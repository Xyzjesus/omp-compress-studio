/**
 * session-dedup: lossless content-addressed dedup across the payload.
 *
 * Port of OmniRoute's `session-dedup` engine (the first stage of their default
 * "Standard Savings" combo): tool/user blocks ≥80 chars with ≥3 lines that
 * appear more than once keep only the FIRST verbatim copy; every later
 * identical occurrence collapses to a short reference marker. The model still
 * sees the full content once, so no information is lost — later copies are
 * redundant context.
 *
 * The newest user message and current-turn blocks are never touched.
 */

import { createHash } from "node:crypto";

export const MIN_BLOCK_CHARS = 80;
export const MIN_BLOCK_LINES = 3;

export interface DedupableBlock {
	text: string;
	isNewestUser: boolean;
	isCurrentTurn: boolean;
}

/** `[dedup:ref sha=<24hex>]` — first copy above; model reads it there. */
export function dedupMarker(sha: string, lines: number, chars: number): string {
	return `[dedup:ref sha=${sha}] identical to an earlier block above (~${lines} lines, ${chars} chars omitted)`;
}

function blockSha(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function eligible(text: string): boolean {
	if (text.length < MIN_BLOCK_CHARS) return false;
	return text.split("\n").length >= MIN_BLOCK_LINES;
}

/**
 * Returns one entry per input block: `null` when the block stays verbatim,
 * otherwise the replacement marker text. The FIRST eligible occurrence of a
 * repeated text is kept; every later occurrence gets the marker.
 */
export function dedupSessionBlocks(blocks: readonly DedupableBlock[]): Array<string | null> {
	const replacements: Array<string | null> = new Array(blocks.length).fill(null);
	const seen = new Set<string>();
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i]!;
		if (block.isNewestUser || block.isCurrentTurn) continue;
		if (!eligible(block.text)) continue;
		const sha = blockSha(block.text);
		if (!seen.has(sha)) {
			seen.add(sha);
			continue;
		}
		replacements[i] = dedupMarker(sha, block.text.split("\n").length, block.text.length);
	}
	return replacements;
}
