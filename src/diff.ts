export type DiffSegmentType = "same" | "removed" | "added";

export interface DiffSegment {
	type: DiffSegmentType;
	text: string;
}

export interface WordDiff {
	segments: DiffSegment[];
	omitted: boolean;
	warning?: string;
}

export interface PreservedBlock {
	kind: "code-block" | "inline-code" | "url";
	preview: string;
}

const DIFF_GUARD_PRODUCT = 1_000_000;

/** Split into whitespace/non-whitespace tokens so concatenation reconstructs the input. */
export function tokenizeWords(text: string): string[] {
	return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Word-level LCS diff. Guard: when token-count product exceeds 1e6 the diff is
 * skipped (same bound OmniRoute uses) — an O(n·m) DP over multi-ten-thousand
 * token inputs is not worth a preview.
 */
export function diffWords(
	original: string,
	compressed: string,
	counts?: { originalTokens: number; compressedTokens: number },
): WordDiff {
	const a = tokenizeWords(original);
	const b = tokenizeWords(compressed);
	const product = counts ? counts.originalTokens * counts.compressedTokens : a.length * b.length;
	if (product > DIFF_GUARD_PRODUCT) {
		return {
			segments: [],
			omitted: true,
			warning: `diff skipped: inputs too large (${counts?.originalTokens ?? a.length} × ${counts?.compressedTokens ?? b.length} tokens)`,
		};
	}

	// dp[i][j] = LCS length of a[i..] and b[j..]
	const dp = new Int32Array((a.length + 1) * (b.length + 1));
	const at = (i: number, j: number) => i * (b.length + 1) + j;
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			dp[at(i, j)] =
				a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
		}
	}

	const segments: DiffSegment[] = [];
	const push = (type: DiffSegmentType, text: string) => {
		const last = segments[segments.length - 1];
		if (last && last.type === type) last.text += text;
		else segments.push({ type, text });
	};

	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			push("same", a[i]);
			i++;
			j++;
		} else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
			push("removed", a[i]);
			i++;
		} else {
			push("added", b[j]);
			j++;
		}
	}
	while (i < a.length) {
		push("removed", a[i]);
		i++;
	}
	while (j < b.length) {
		push("added", b[j]);
		j++;
	}

	return { segments, omitted: false };
}

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const URL_RE = /\bhttps?:\/\/\S+/g;

function collapseWhitespace(text: string, cap: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > cap ? `${collapsed.slice(0, cap - 1)}…` : collapsed;
}

/**
 * Blocks compression engines must not mangle: fenced code, inline code, URLs.
 * Spans are collected with precedence (fence > inline > url) so overlapping
 * matches are not reported twice.
 */
export function extractPreservedBlocks(original: string): PreservedBlock[] {
	const blocks: PreservedBlock[] = [];
	const taken: Array<[number, number]> = [];
	const overlaps = (start: number, end: number) => taken.some(([s, e]) => start < e && end > s);

	for (const match of original.matchAll(FENCE_RE)) {
		const start = match.index;
		if (start === undefined) continue;
		taken.push([start, start + match[0].length]);
		blocks.push({ kind: "code-block", preview: collapseWhitespace(match[0], 96) });
	}
	for (const match of original.matchAll(INLINE_CODE_RE)) {
		const start = match.index;
		if (start === undefined || overlaps(start, start + match[0].length)) continue;
		taken.push([start, start + match[0].length]);
		blocks.push({ kind: "inline-code", preview: collapseWhitespace(match[0], 96) });
	}
	for (const match of original.matchAll(URL_RE)) {
		const start = match.index;
		if (start === undefined || overlaps(start, start + match[0].length)) continue;
		taken.push([start, start + match[0].length]);
		blocks.push({ kind: "url", preview: collapseWhitespace(match[0], 96) });
	}
	return blocks;
}
