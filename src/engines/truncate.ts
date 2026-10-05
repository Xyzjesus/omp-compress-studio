import type { CompressionEngine, EngineApplyOptions, EngineInput } from "./types";
import { finishStep } from "./types";

export const MAX_LINES = 120;
export const MAX_CHARS = 12_000;

/** ERROR/WARN-style lines are informative; their first occurrence always survives. */
const SEVERITY_LINE_RE = /(ERROR|WARN|Error:|Exception:)/;
/** Canonical line identity threshold — shorter normalized lines are trivial filler. */
export const MIN_NOVEL_CHARS = 8;

export interface TruncateResult {
	text: string;
	droppedLines: number;
}

function marker(dropped: number): string {
	return `[… ${dropped} lines truncated …]`;
}

/** Canonical line identity: digits are noise (counters, line numbers, ids). */
export function normalizeLine(line: string): string {
	return line.trim().toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
}

/**
 * Semantics-first truncation. A line is dropped only when it carries no novel
 * information: it is either trivial filler (blank after normalization) or a
 * normalized repeat of an earlier line — digits are normalized away, so
 * counter-driven log spam (crate-001, crate-002, …) collapses. The FIRST
 * occurrence of every distinct line always survives, wherever it sits, so
 * source reads and documents pass through intact even when they exceed the
 * caps. Unbounded unique content is deliberately not cut (semantics beat
 * compression).
 */
export function smartTruncate(text: string): TruncateResult {
	const lines = text.split("\n");
	if (lines.length <= MAX_LINES && text.length <= MAX_CHARS) {
		return { text, droppedLines: 0 };
	}

	const seen = new Set<string>();
	const novel = lines.map((line) => {
		const normalized = normalizeLine(line);
		if (normalized.length < MIN_NOVEL_CHARS) return false;
		if (seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	});

	const kept: string[] = [];
	let dropped = 0;
	let runDropped = 0;
	for (let i = 0; i < lines.length; i++) {
		if (novel[i] || SEVERITY_LINE_RE.test(lines[i])) {
			if (runDropped > 0) {
				kept.push(marker(runDropped));
				runDropped = 0;
			}
			kept.push(lines[i]);
		} else {
			dropped++;
			runDropped++;
		}
	}
	if (runDropped > 0) kept.push(marker(runDropped));
	return { text: kept.join("\n"), droppedLines: dropped };
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
