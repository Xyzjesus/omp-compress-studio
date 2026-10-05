import type { StepResult } from "../engines/types";
import { isLogLine } from "../log-shape";
import { MIN_NOVEL_CHARS, normalizeLine } from "../engines/truncate";

const MIN_CRITICAL_SURVIVAL_PERCENT = 95;
const MIN_JSON_KEY_PERCENT = 90;

/** Needles that must survive compression (ratio-checked). */
const CRITICAL_RES: Array<[kind: string, regex: RegExp]> = [
	["url", /\bhttps?:\/\/\S+/g],
	["version", /\b\d+(?:\.\d+){1,3}\b/g],
	["dotted_identifier", /\b[A-Za-z_][\w$]*(?:\.[\w$]+)+\b/g],
	["function_call", /\b[A-Za-z_]\w*\([^()]*\)/g],
	["file_path", /\b[\w-]+(?:\/[\w.-]+)+\b/g],
	["inline_code", /`[^`\n]+`/g],
	["const_case", /\b[A-Z][A-Z0-9_]{2,}\b/g],
];

const NUMERIC_RE = /\d[\d.,]{0,40}/g;
const JSON_KEY_RE = /"([A-Za-z_$][\w$-]{0,80})"\s*:/g;
const HUNK_RE = /@@ -\d{1,9}(?:,\d{1,9})? \+\d{1,9}(?:,\d{1,9})? @@/g;

function unique(values: Iterable<string>): string[] {
	return [...new Set(values)];
}

/** Unique critical needles a model must be able to recover from the text —
 * routes through extractProtected so the log-line/repeat exemption applies:
 * needles the engines are contracted to drop never count against recall. */
export function criticalNeedles(input: string): string[] {
	return extractProtected(input).critical.map((entry) => entry.needle);
}

/**
 * Needles whose every occurrence sits on a log-shaped line are exempt: log
 * noise is compressible by contract (see log-shape.ts), so structural
 * engines may drop those lines without failing the invariant.
 */
function extractProtected(input: string): { critical: Array<{ kind: string; needle: string }>; numbers: string[]; hunks: string[] } {
	const lines = input.split("\n");
	// Normalized-repeat lines share smartTruncate's canonical identity with an
	// EARLIER line (digits collapsed) — the first occurrence guards every
	// needle that shape can carry, so repeats join log lines in the exemption.
	// Without this, counter-driven spam (`line 12: ok …`) rolls back forever:
	// truncate treats the numbers as noise, fidelity as sacred facts.
	const seenNormalized = new Set<string>();
	const repeatLine = new Set<number>();
	lines.forEach((line, idx) => {
		const normalized = normalizeLine(line);
		if (normalized.length < MIN_NOVEL_CHARS) return;
		if (seenNormalized.has(normalized)) repeatLine.add(idx);
		else seenNormalized.add(normalized);
	});

	const critical: Array<{ kind: string; needle: string }> = [];
	const seen = new Set<string>();
	const numbers = new Set<string>();
	const hunks = new Set<string>();
	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx]!;
		if (isLogLine(line) || repeatLine.has(idx)) continue;
		for (const [kind, regex] of CRITICAL_RES) {
			for (const needle of line.match(regex) ?? []) {
				const key = `${kind}\u0000${needle}`;
				if (!seen.has(key)) {
					seen.add(key);
					critical.push({ kind, needle });
				}
			}
		}
		for (const number of line.match(NUMERIC_RE) ?? []) numbers.add(number);
		for (const hunk of line.match(HUNK_RE) ?? []) hunks.add(hunk);
	}
	return { critical, numbers: [...numbers], hunks: [...hunks] };
}

export interface FidelityVerdict {
	/** Pass-through step when ok; rolled-back step when failed. */
	step: StepResult;
	ok: boolean;
	reason?: string;
}

/**
 * Post-step invariant check: critical needles ≥95% survival, JSON keys ≥90%,
 * every non-log-line number and every diff hunk present. Needles occurring
 * only on log-shaped lines are exempt (see extractProtected). Failure rolls
 * the step back.
 */
export function fidelityCheck(step: StepResult): FidelityVerdict {
	const input = step.input;
	const output = step.output;
	if (input === output) return { step, ok: true };

	const fail = (reason: string): FidelityVerdict => ({
		step: { ...step, output: step.input, rejected: true, rejectReason: reason },
		ok: false,
		reason,
	});

	const { critical, numbers, hunks } = extractProtected(input);
	if (critical.length > 0) {
		const survived = critical.filter(({ needle }) => output.includes(needle)).length;
		const ratio = (survived / critical.length) * 100;
		if (ratio < MIN_CRITICAL_SURVIVAL_PERCENT) {
			const missing = critical.find(({ needle }) => !output.includes(needle));
			return fail(`fidelity:critical(${missing?.kind ?? "unknown"}:${survived}/${critical.length})`);
		}
	}

	const keyNames = unique([...input.matchAll(JSON_KEY_RE)].map((m) => m[1]));
	if (keyNames.length > 0) {
		const survived = keyNames.filter((key) => output.includes(`"${key}"`)).length;
		const ratio = (survived / keyNames.length) * 100;
		if (ratio < MIN_JSON_KEY_PERCENT) {
			return fail(`fidelity:json-keys(${survived}/${keyNames.length})`);
		}
	}

	const missingNumber = numbers.find((n) => !output.includes(n));
	if (missingNumber !== undefined) {
		return fail(`fidelity:numeric(${missingNumber})`);
	}

	const missingHunk = hunks.find((h) => !output.includes(h));
	if (missingHunk !== undefined) {
		return fail("fidelity:hunk");
	}

	return { step, ok: true };
}

export const FIDELITY_THRESHOLDS = {
	minTokenSurvivalPercent: MIN_CRITICAL_SURVIVAL_PERCENT,
	minJsonKeyPercent: MIN_JSON_KEY_PERCENT,
};
