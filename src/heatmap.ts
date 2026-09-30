import { tokenizeWords } from "./diff";
import type { WordDiff } from "./diff";

export type HeatmapMode = "off" | "ultra" | "universal";

export interface HeatmapToken {
	text: string;
	score: number;
	kept: boolean;
}

/** ~80 stopwords: function words whose loss never changes meaning. */
const STOPWORDS: Record<string, true> = {
	a: true, an: true, the: true, is: true, are: true, was: true, were: true, be: true,
	been: true, being: true, am: true, will: true, would: true, could: true, may: true,
	might: true, and: true, but: true, or: true, at: true, by: true, in: true, of: true,
	on: true, to: true, with: true, from: true, as: true, for: true, into: true, over: true,
	under: true, just: true, very: true, really: true, quite: true, rather: true, also: true,
	too: true, even: true, still: true, often: true, usually: true, sometimes: true,
	here: true, there: true, it: true, its: true, this: true, that: true, these: true,
	those: true, so: true, than: true, then: true, up: true, down: true, out: true, off: true,
	about: true, again: true, further: true, once: true, all: true, any: true, both: true,
	each: true, few: true, more: true, most: true, other: true, some: true, such: true,
	no: true, nor: true, not: true, only: true, own: true, same: true,
};

const FORCE_PRESERVE_RES: RegExp[] = [
	/\bhttps?:\/\//,
	/^\.{0,2}\//,
	/\b\d+(?:\.\d+){1,3}\b/,
	/\b[A-Za-z_][\w$]*(?:\.[\w$]+)+\b/,
	/^`.*`$/,
	/^\d{3,}$/,
];

function isForcePreserve(token: string): boolean {
	return FORCE_PRESERVE_RES.some((re) => re.test(token));
}

/**
 * Token scores for the heatmap. `universal`: binary kept/dropped from the
 * diff. `ultra`: heuristic score — 1.0 force-preserve, 0.15 stopwords, else
 * 0.4 + min(len/40, 0.2). Kept/dropped always comes from the diff.
 */
export function buildHeatmap(original: string, diff: WordDiff, mode: Exclude<HeatmapMode, "off">): HeatmapToken[] {
	const tokens = tokenizeWords(original);

	// Map diff segments back onto original tokens to mark kept/dropped.
	const kept: boolean[] = [];
	let segIdx = 0;
	let offset = 0;
	for (const token of tokens) {
		while (segIdx < diff.segments.length && offset >= diff.segments[segIdx].text.length) {
			offset -= diff.segments[segIdx].text.length;
			segIdx++;
		}
		const segment = diff.segments[segIdx];
		kept.push(segment !== undefined && segment.type !== "removed");
		offset += token.length;
	}

	return tokens.map((text, i) => {
		if (mode === "universal") {
			return { text, score: kept[i] ? 1 : 0, kept: kept[i] };
		}
		const bare = text.trim();
		const score = isForcePreserve(bare)
			? 1
			: STOPWORDS[bare.toLowerCase()] === true
				? 0.15
				: 0.4 + Math.min(bare.length / 40, 0.2);
		return { text, score, kept: kept[i] };
	});
}
