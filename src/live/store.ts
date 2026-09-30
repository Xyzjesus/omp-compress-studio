import * as fs from "node:fs/promises";
import { runsPath } from "../config";
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

export interface SessionTotals {
	requests: number;
	accepted: number;
	originalTokens: number;
	compressedTokens: number;
	savingsPercent: number;
	lastRun?: RunRecord;
}

const RING_CAPACITY = 50;

/** In-memory ring of recent runs, mirrored to an append-only JSONL on disk. */
export class RunStore {
	#ring: RunRecord[] = [];

	constructor(private readonly log?: { warn(message: string, fields?: unknown): void }) {}

	append(record: RunRecord): void {
		this.#ring.push(record);
		if (this.#ring.length > RING_CAPACITY) this.#ring.shift();
		const line = `${JSON.stringify(record)}\n`;
		fs.appendFile(runsPath(), line, "utf8").catch((err: unknown) => {
			this.log?.warn("compress-studio: failed to append run record", { error: String(err) });
		});
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
}
