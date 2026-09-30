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

/**
 * Session-dedup: near-identical `\\n\\n`-separated blocks (≥80 chars) are
 * collapsed to their first occurrence. Fuzzy matching is capped to keep the
 * O(n²) pass bounded; beyond the caps only exact normalized matches drop.
 */
export function deduplicateBlocks(text: string): { text: string; removed: number } {
	const blocks = text.split("\n\n");
	if (blocks.length < 2) return { text, removed: 0 };

	const fuzzyAllowed = blocks.length <= FUZZY_MAX_BLOCKS;
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
	return { text: kept.join("\n\n"), removed };
}

export const dedupEngine: CompressionEngine = {
	id: "dedup",
	name: "Session Dedup",
	apply(input: EngineInput, opts?: EngineApplyOptions) {
		return finishStep("dedup", input.text, input.text, () => {
			const { text, removed } = deduplicateBlocks(input.text);
			return {
				output: text,
				techniquesUsed: removed > 0 ? ["session-dedup"] : [],
				rulesApplied: [],
			};
		}, opts);
	},
};
