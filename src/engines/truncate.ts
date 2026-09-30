import type { CompressionEngine, EngineApplyOptions, EngineInput } from "./types";
import { finishStep } from "./types";

export const MAX_LINES = 120;
export const MAX_CHARS = 12_000;
const HEAD_LINES = 24;
const TAIL_LINES = 24;

const SEVERITY_LINE_RE = /(ERROR|WARN|Error:|Exception:)/;
const MARKER_PREFIX = "\u0000DROP:";
const MARKER_SUFFIX = "\u0000";

export interface TruncateResult {
	text: string;
	droppedLines: number;
}

function marker(dropped: number): string {
	return `[… ${dropped} lines truncated …]`;
}

function sentinel(count: number): string {
	return `${MARKER_PREFIX}${count}${MARKER_SUFFIX}`;
}

function isSentinel(line: string): boolean {
	return line.startsWith(MARKER_PREFIX) && line.endsWith(MARKER_SUFFIX);
}

function sentinelCount(line: string): number {
	return Number(line.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length));
}

/**
 * Smart truncation: keep head+tail windows and every severity line, collapse
 * dropped runs into markers; then enforce the char cap by dropping further
 * non-severity lines outward from the middle.
 */
export function smartTruncate(text: string): TruncateResult {
	const lines = text.split("\n");
	if (lines.length <= MAX_LINES && text.length <= MAX_CHARS) {
		return { text, droppedLines: 0 };
	}

	const keep = new Array<boolean>(lines.length).fill(false);
	for (let i = 0; i < Math.min(HEAD_LINES, lines.length); i++) keep[i] = true;
	for (let i = Math.max(0, lines.length - TAIL_LINES); i < lines.length; i++) keep[i] = true;
	for (let i = 0; i < lines.length; i++) {
		if (!keep[i] && SEVERITY_LINE_RE.test(lines[i])) keep[i] = true;
	}

	const kept: string[] = [];
	let dropped = 0;
	let runLen = 0;
	for (let i = 0; i < lines.length; i++) {
		if (keep[i]) {
			if (runLen > 0) {
				kept.push(sentinel(runLen));
				dropped += runLen;
				runLen = 0;
			}
			kept.push(lines[i]);
		} else {
			runLen++;
		}
	}
	if (runLen > 0) {
		kept.push(sentinel(runLen));
		dropped += runLen;
	}

	let result = collapseMarkers(kept);
	if (result.length <= MAX_CHARS) {
		return { text: result, droppedLines: dropped };
	}

	// Char cap still exceeded: drop non-severity kept lines outward from the middle.
	const severityIdx = new Set<number>();
	for (let i = 0; i < kept.length; i++) {
		if (!isSentinel(kept[i]) && SEVERITY_LINE_RE.test(kept[i])) severityIdx.add(i);
	}
	const mid = Math.floor(kept.length / 2);
	const extraDrop = new Set<number>();
	let projected = result.length;
	for (let offset = 0; offset < kept.length && projected > MAX_CHARS; offset++) {
		for (const idx of [mid - offset, mid + 1 + offset]) {
			if (idx < 0 || idx >= kept.length || extraDrop.has(idx)) continue;
			if (idx in severityIdx || isSentinel(kept[idx])) continue;
			extraDrop.add(idx);
			projected -= kept[idx].length + 1;
		}
	}

	const trimmed: string[] = [];
	let inExtraRun = false;
	for (let i = 0; i < kept.length; i++) {
		if (extraDrop.has(i)) {
			if (!inExtraRun) {
				trimmed.push(sentinel(1));
				inExtraRun = true;
			}
			continue;
		}
		trimmed.push(kept[i]);
		inExtraRun = false;
	}
	const extraDropped = extraDrop.size;
	dropped += extraDropped;
	result = collapseMarkers(trimmed);
	return { text: result, droppedLines: dropped };
}

/** Replace sentinel markers with real per-run drop counts; merge adjacent markers. */
function collapseMarkers(lines: string[]): string {
	const out: string[] = [];
	for (const line of lines) {
		if (!isSentinel(line)) {
			out.push(line);
			continue;
		}
		const prev = out[out.length - 1];
		if (prev !== undefined && prev.startsWith("[… ") && prev.endsWith(" lines truncated …]")) {
			const count = Number(prev.slice(3, -" lines truncated …]".length));
			if (Number.isFinite(count)) {
				out[out.length - 1] = marker(count + sentinelCount(line));
				continue;
			}
		}
		out.push(marker(sentinelCount(line)));
	}
	return out.join("\n");
}

export const truncateEngine: CompressionEngine = {
	id: "truncate",
	name: "Smart Truncate",
	apply(input: EngineInput, opts?: EngineApplyOptions) {
		return finishStep("truncate", input.text, input.text, () => {
			const { text } = smartTruncate(input.text);
			return {
				output: text,
				techniquesUsed: text === input.text ? [] : ["rtk-truncate"],
				rulesApplied: [],
			};
		}, opts);
	},
};
