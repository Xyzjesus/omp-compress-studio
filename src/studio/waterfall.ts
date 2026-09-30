import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui";
import type { WordDiff } from "../diff";
import type { StepResult } from "../engines/types";
import { renderLine } from "./render-utils";

/** One waterfall row in the shared summary shape (live runs store the same fields). */
export interface WaterfallRow {
	engine: string;
	savingsPercent: number;
	rejected: boolean;
	rejectReason?: string;
	techniquesUsed: string[];
}

export function stepToRow(step: StepResult): WaterfallRow {
	return {
		engine: step.engine,
		savingsPercent: step.savingsPercent,
		rejected: step.rejected === true,
		rejectReason: step.rejectReason,
		techniquesUsed: step.techniquesUsed,
	};
}

export function waterfallLines(
	rows: readonly WaterfallRow[],
	visibleCount: number,
	selected: number,
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const count = Math.min(visibleCount, rows.length);
	for (let i = 0; i < count; i++) {
		const row = rows[i]!;
		const savings = row.savingsPercent > 0 ? `−${row.savingsPercent.toFixed(1)}%` : "0%";
		const meta = row.techniquesUsed.length > 0 ? ` · ${row.techniquesUsed.join(",")}` : "";
		const label = `${row.engine.padEnd(9)} ${savings.padStart(7)}${meta}`;
		let line: string;
		if (row.rejected) {
			line = theme.fg("dim", `  ${label}  [${row.rejectReason ?? "rejected"}]`);
		} else {
			line = `  ${label}`;
		}
		if (i === selected) line = theme.fg("accent", `▶${line.slice(1)}`);
		lines.push(renderLine(line, width));
	}
	return lines;
}

/** Colorized diff rows: removed red, added green, context dim; wrapped to width. */
export function diffLines(diff: WordDiff, maxRows: number, width: number, theme: Theme): string[] {
	if (diff.omitted) {
		return [theme.fg("warning", `⚠ ${diff.warning ?? "diff omitted"}`)];
	}
	const chunks: string[] = [];
	for (const segment of diff.segments) {
		if (segment.text.length === 0) continue;
		const color =
			segment.type === "removed" ? "toolDiffRemoved" : segment.type === "added" ? "toolDiffAdded" : "dim";
		chunks.push(theme.fg(color, segment.text));
	}
	const colored = chunks.join("");
	const rows: string[] = [];
	for (const rawLine of colored.split("\n")) {
		if (rawLine.length === 0) {
			rows.push("");
			continue;
		}
		rows.push(...wrapTextWithAnsi(rawLine, Math.max(20, width)));
	}
	return rows.slice(0, maxRows);
}

/** Heatmap preview: first N tokens with brightness by score, dropped tokens dimmed. */
export function heatmapLines(
	tokens: ReadonlyArray<{ text: string; score: number; kept: boolean }>,
	maxTokens: number,
	width: number,
	theme: Theme,
): string[] {
	const visible = tokens.slice(0, maxTokens);
	let line = "";
	for (const token of visible) {
		const piece = token.text;
		if (!token.kept) {
			line += theme.fg("dim", piece);
			continue;
		}
		line += token.score >= 0.9 ? theme.fg("text", piece) : theme.fg("muted", piece);
	}
	return [renderLine(line, width)];
}
