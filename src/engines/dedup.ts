import type { CompressionEngine, EngineApplyOptions, EngineInput } from "./types";
import { finishStep } from "./types";

const MIN_BLOCK_CHARS = 80;
const FUZZY_MAX_BLOCK_CHARS = 2_000;
const FUZZY_MAX_BLOCKS = 400;
const SIMILARITY_THRESHOLD = 0.9;

function normalizeBlock(block: string): string {
	return block.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Levenshtein distance with an early-exit upper bound (k = allowed edits). */
function withinDistance(a: string, b: string, maxEdits: number): boolean {
	if (Math.abs(a.length - b.length) > maxEdits) return false;
	let prev = new Int32Array(b.length + 1);
	let curr = new Int32Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		if (rowMin > maxEdits) return false;
		[prev, curr] = [curr, prev];
	}
	return prev[b.length] <= maxEdits;
}

const COUNT_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"] as const;

/**
 * Elision counts are spelled in words: a digit in the marker could satisfy
 * the substring-based numeric gate vacuously after a genuinely dropped
 * number (reviewer repro: `batch 2` blocks elided, marker said `2`).
 */
function elisionMarker(removed: number): string {
	const word = removed <= COUNT_WORDS.length ? COUNT_WORDS[removed - 1] : undefined;
	const count = word === undefined ? "" : `${word} `;
	return `[… ${count}duplicate block${removed === 1 ? "" : "s"} elided …]`;
}

/**
 * Session-dedup: near-identical `\\n\\n`-separated blocks (≥80 chars) are
 * collapsed to their first occurrence. Fuzzy matching is capped to keep the
 * O(n²) pass bounded; beyond the caps only exact normalized matches drop.
 */
export function deduplicateBlocks(text: string, fuzzy = true): { text: string; removed: number } {
	const blocks = text.split("\n\n");
	if (blocks.length < 2) return { text, removed: 0 };

	const fuzzyAllowed = fuzzy && blocks.length <= FUZZY_MAX_BLOCKS;
	const kept: string[] = [];
	const keptNormalized: string[] = [];
	let removed = 0;

	for (const block of blocks) {
		const normalized = normalizeBlock(block);
		let isDuplicate = false;
		if (normalized.length >= MIN_BLOCK_CHARS) {
			for (let i = 0; i < keptNormalized.length; i++) {
				if (keptNormalized[i] === normalized) {
					isDuplicate = true;
					break;
				}
				const candidate = kept[i];
				if (
					fuzzyAllowed &&
					normalized.length <= FUZZY_MAX_BLOCK_CHARS &&
					candidate.length <= FUZZY_MAX_BLOCK_CHARS
				) {
					const allowedEdits = Math.floor(
						(1 - SIMILARITY_THRESHOLD) * Math.max(normalized.length, candidate.length),
					);
					if (allowedEdits > 0 && withinDistance(normalized, keptNormalized[i], allowedEdits)) {
						isDuplicate = true;
						break;
					}
				}
			}
		}
		if (isDuplicate) {
			removed++;
			continue;
		}
		kept.push(block);
		keptNormalized.push(normalized);
	}

	if (removed === 0) return { text, removed };
	// The elision is announced — the model must see that content was dropped,
	// the same readable-edit contract every other stage's markers follow.
	return { text: `${kept.join("\n\n")}\n\n${elisionMarker(removed)}`, removed };
}

export const dedupEngine: CompressionEngine = {
	id: "dedup",
	name: "Session Dedup",
	apply(input: EngineInput, opts?: EngineApplyOptions) {
		return finishStep("dedup", input.text, input.text, () => {
			const { text, removed } = deduplicateBlocks(input.text, opts?.fuzzy ?? true);
			return {
				output: text,
				techniquesUsed: removed > 0 ? ["session-dedup"] : [],
				rulesApplied: [],
			};
		}, opts);
	},
};
