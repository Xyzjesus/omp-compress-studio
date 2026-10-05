import * as fs from "node:fs/promises";
import { runsPath } from "../config";
import { rotateLogIfHuge } from "./log-rotation";
import type { Strategy } from "../config";

export interface RunStepSummary {
	engine: string;
	savingsPercent: number;
	rejected: boolean;
	rejectReason?: string;
	techniquesUsed: string[];
}

export interface RunRecord {
	ts: number;
	model?: string;
	api: string;
	strategy: Strategy;
	originalTokens: number;
	compressedTokens: number;
	savingsPercent: number;
	steps: RunStepSummary[];
	durationMs: number;
	accepted: boolean;
	fallbackReason?: string;
}

export interface CacheUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface SessionTotals {
	requests: number;
	accepted: number;
	originalTokens: number;
	compressedTokens: number;
	savingsPercent: number;
	lastRun?: RunRecord;
}
const RING_CAPACITY = 50;
const RUNS_LOG_MAX_BYTES = 5 * 1024 * 1024;
const RUNS_LOG_KEEP_BYTES = 1024 * 1024;

/** In-memory ring of recent runs, mirrored to an append-only JSONL on disk. */
export class RunStore {
	#ring: RunRecord[] = [];

	#log?: { warn(message: string, fields?: unknown): void };
	#file: string | null;
	#usage: CacheUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	/** `file: null` = memory-only (tests must not pollute the user's runs.jsonl). */
	constructor(log?: { warn(message: string, fields?: unknown): void }, file?: string | null) {
		this.#log = log;
		this.#file = file === undefined ? runsPath() : file;
	}

	append(record: RunRecord): RunRecord {
		this.#ring.push(record);
		if (this.#ring.length > RING_CAPACITY) this.#ring.shift();
		if (this.#file) {
			const line = `${JSON.stringify(record)}\n`;
			fs.appendFile(this.#file, line, "utf8").catch((err: unknown) => {
				this.#log?.warn("compress-studio: failed to append run record", { error: String(err) });
			});
			// Size check on every append: with fallback records now written for
			// early exits too, append frequency went up; a stat per request is
			// negligible.
			rotateLogIfHuge(this.#file, RUNS_LOG_MAX_BYTES, RUNS_LOG_KEEP_BYTES).catch((err: unknown) => {
				this.#log?.warn("compress-studio: runs.jsonl rotation failed", { error: String(err) });
			});
		}
		return record;
	}

	recent(): readonly RunRecord[] {
		return this.#ring;
	}

	/** Totals over accepted runs of this process. */
	sessionTotals(): SessionTotals {
		const accepted = this.#ring.filter((run) => run.accepted);
		const originalTokens = accepted.reduce((sum, run) => sum + run.originalTokens, 0);
		const compressedTokens = accepted.reduce((sum, run) => sum + run.compressedTokens, 0);
		return {
			requests: this.#ring.length,
			accepted: accepted.length,
			originalTokens,
			compressedTokens,
			savingsPercent:
				originalTokens > 0
					? Math.round(((originalTokens - compressedTokens) / originalTokens) * 1000) / 10
					: 0,
			lastRun: this.#ring[this.#ring.length - 1],
		};
	}

	/** Accumulates provider usage from finalized assistant messages (message_end). */
	recordUsage(usage: Partial<CacheUsageTotals>): void {
		this.#usage.input += usage.input ?? 0;
		this.#usage.output += usage.output ?? 0;
		this.#usage.cacheRead += usage.cacheRead ?? 0;
		this.#usage.cacheWrite += usage.cacheWrite ?? 0;
	}

	usageTotals(): CacheUsageTotals {
		return { ...this.#usage };
	}
}
