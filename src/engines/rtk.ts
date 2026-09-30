import type { CompressionEngine, EngineApplyOptions, EngineInput } from "./types";
import { finishStep, skippedStep } from "./types";
import { smartTruncate } from "./truncate";
import { isLogShaped } from "../log-shape";

const ERROR_RE = /Error:|Exception:|Traceback \(most recent call last\):/;
const COMMAND_PROMPT_RE = /(^|\n)\s*\$\s/;
const FENCE_RE = /```[\s\S]*?```/g;

/** Shell tool names unlock command-aware filter stages (bash, run_command, …). */
const SHELL_TOOL_RE = /\b(bash|shell|terminal|run_command|execute_command|exec|command)\b/;

export function isShellToolName(toolName: string | undefined): boolean {
	return toolName !== undefined && SHELL_TOOL_RE.test(toolName);
}

function isCommandAware(input: EngineInput): boolean {
	return input.isShellTool === true || COMMAND_PROMPT_RE.test(input.text) || isLogShaped(input.text);
}

const TIMESTAMP_LINE_RE = /^\s*\[?\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?\]?\s*$/;
const EMPTY_DEBUG_LINE_RE = /^\s*\[?(?:debug|trace|verbose)\]?:?\s*$/i;
/** Decorative separator/logo lines (===, ---, ***). Prose repeats belong to the dedup stage. */
const DECORATIVE_LINE_RE = /^[\s=*#~_-]{4,}$/;

/** Stage 2: drop timestamp-only lines, empty debug lines, and decorative banner repeats. */
function filterLines(text: string): { text: string; changed: boolean } {
	const lines = text.split("\n");
	const out: string[] = [];
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (TIMESTAMP_LINE_RE.test(line) || EMPTY_DEBUG_LINE_RE.test(line)) {
			changed = true;
			continue;
		}
		// Banner repeat: same decorative line directly repeated.
		if (DECORATIVE_LINE_RE.test(line) && out.length > 0 && out[out.length - 1] === line) {
			changed = true;
			continue;
		}
		out.push(line);
	}
	return { text: out.join("\n"), changed };
}

/** Stage 3: collapse runs of ≥3 identical consecutive lines to one line with a ×N suffix. */
function dedupConsecutiveLines(text: string): { text: string; changed: boolean } {
	const lines = text.split("\n");
	const out: string[] = [];
	let changed = false;
	let i = 0;
	while (i < lines.length) {
		let run = 1;
		while (i + run < lines.length && lines[i + run] === lines[i]) run++;
		if (run >= 3) {
			out.push(`${lines[i]} (×${run})`);
			changed = true;
		} else {
			for (let k = 0; k < run; k++) out.push(lines[i]);
		}
		i += run;
	}
	return { text: out.join("\n"), changed };
}

const KEEP_COMMENT_RE = /(^#!|#\s*(?:noqa|eslint|tslint|prettier-ignore|type:\s*ignore|region|endregion)|(?:ERROR|WARN|Error:|Exception:)|https?:\/\/)/;

/** Stage 4: strip full-line comments inside fenced code; docstrings and severity/URL comments stay. */
function stripFenceComments(text: string): { text: string; changed: boolean } {
	let changed = false;
	const transformed = text.replace(FENCE_RE, (fence) => {
		const lines = fence.split("\n");
		const kept = lines.filter((line, idx) => {
			if (idx === 0 || idx === lines.length - 1) return true; // fence markers
			const trimmed = line.trimStart();
			const isComment = trimmed.startsWith("#") || trimmed.startsWith("//");
			if (!isComment) return true;
			return KEEP_COMMENT_RE.test(trimmed);
		});
		if (kept.length === lines.length) return fence;
		changed = true;
		return kept.join("\n");
	});
	return { text: transformed, changed };
}

/**
 * rtk: filter → dedup → code-strip → truncate, for command/tool output.
 * Read-only documents (no command, no errors, not log-shaped) are skipped entirely.
 */
export const rtkEngine: CompressionEngine = {
	id: "rtk",
	name: "RTK",
	apply(input: EngineInput, opts?: EngineApplyOptions) {
		if (!isCommandAware(input) && !ERROR_RE.test(input.text)) {
			return skippedStep("rtk", input.text, "document", opts);
		}
		return finishStep("rtk", input.text, input.text, () => {
			const techniques: string[] = [];
			let text = input.text;

			if (isCommandAware(input)) {
				const filtered = filterLines(text);
				if (filtered.changed) {
					text = filtered.text;
					techniques.push("rtk-filter");
				}
			}

			const deduped = dedupConsecutiveLines(text);
			if (deduped.changed) {
				text = deduped.text;
				techniques.push("rtk-dedup");
			}

			const stripped = stripFenceComments(text);
			if (stripped.changed) {
				text = stripped.text;
				techniques.push("rtk-code-strip");
			}

			const truncated = smartTruncate(text);
			if (truncated.droppedLines > 0) {
				text = truncated.text;
				techniques.push("rtk-truncate");
			}

			return { output: text, techniquesUsed: techniques, rulesApplied: [] };
		}, opts);
	},
};
