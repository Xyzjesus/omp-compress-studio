import { createHash } from "node:crypto";
import type { StepResult } from "../engines/types";
import type { RunStepSummary } from "./store";

export interface BlockMemoEntry {
	text: string;
	steps: RunStepSummary[];
	rawSteps: StepResult[];
}

export interface BlockMemoStats {
	entries: number;
	bytes: number;
	hits: number;
	misses: number;
}

/** Actual retained chars: compressed text plus every step's input/output. */
function entryCost(entry: BlockMemoEntry | null): number {
	if (entry === null) return 0;
	let cost = entry.text.length;
	for (const step of entry.rawSteps) cost += step.input.length + step.output.length;
	return cost;
}

/**
 * Per-process memo of block compression decisions, keyed by everything that
 * feeds `compressBlock` (block text + lanes + gates + intensity + model).
 * Engines are pure, so a repeated key MUST yield the byte-identical result —
 * this turns per-request O(history) work into O(new blocks) and guarantees the
 * compressed prefix stays stable across turns (prompt-cache friendly).
 * `null` entries record a no-gain outcome so misses are paid exactly once.
 */
export class BlockMemo {
	#map = new Map<string, BlockMemoEntry | null>();
	#bytes = 0;
	#hits = 0;
	#misses = 0;

	constructor(
		private readonly maxEntries = 2048,
		private readonly maxChars = 32 * 1024 * 1024,
	) {}

	key(parts: readonly string[]): string {
		return createHash("sha256").update(parts.join("\u0000")).digest("hex");
	}

	get(key: string): BlockMemoEntry | null | undefined {
		const entry = this.#map.get(key);
		if (entry === undefined) {
			this.#misses++;
			return undefined;
		}
		this.#hits++;
		// refresh LRU position
		this.#map.delete(key);
		this.#map.set(key, entry);
		return entry;
	}

	set(key: string, entry: BlockMemoEntry | null): void {
		if (this.#map.has(key)) return;
		const cost = entryCost(entry);
		this.#map.set(key, entry);
		this.#bytes += cost;
		while (this.#map.size > this.maxEntries || this.#bytes > this.maxChars) {
			const oldest = this.#map.keys().next().value;
			if (oldest === undefined) break;
			const evicted = this.#map.get(oldest);
			this.#bytes -= evicted === null || evicted === undefined ? 0 : entryCost(evicted);
			this.#map.delete(oldest);
		}
	}

	get stats(): BlockMemoStats {
		return { entries: this.#map.size, bytes: this.#bytes, hits: this.#hits, misses: this.#misses };
	}

	reset(): void {
		this.#map.clear();
		this.#bytes = 0;
		this.#hits = 0;
		this.#misses = 0;
	}
}

/** Singleton used by the live capture path. */
export const blockMemo = new BlockMemo();
