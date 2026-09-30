import { encode as toonEncode } from "@toon-format/toon";
import { countText, type TokenizerModel } from "./tokens";

export type EncoderId = "json" | "gcf" | "toon";

export interface EncodingMeasure {
	bytes: number;
	tokens: number;
}

export interface EncoderComparison {
	arraysCompared: number;
	json: EncodingMeasure;
	gcf: EncodingMeasure;
	toon: EncodingMeasure | null;
	toonAvailable: boolean;
	winner: EncoderId;
}

const MIN_ARRAY_LENGTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Candidate arrays: whole lines starting with `[` that parse as arrays, plus
 * the contents of ```json fences. Only arrays of ≥8 plain objects qualify.
 */
export function extractCompactableArrays(text: string): unknown[][] {
	const arrays: unknown[][] = [];
	const candidates: string[] = [];
	const seen = new Set<string>();

	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) candidates.push(trimmed);
	}
	for (const fence of text.match(/```json\s*([\s\S]*?)```/g) ?? []) {
		const inner = fence.replace(/^```json\s*/, "").replace(/```$/, "");
		candidates.push(inner.trim());
	}

	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (
				Array.isArray(parsed) &&
				parsed.length >= MIN_ARRAY_LENGTH &&
				parsed.every(isPlainObject)
			) {
				arrays.push(parsed);
			}
		} catch {
			// not JSON — not a candidate
		}
	}
	return arrays;
}

type ColumnType = "s" | "n" | "b" | "null" | "j";

function typeHint(value: unknown): ColumnType {
	if (typeof value === "string") return "s";
	if (typeof value === "number") return "n";
	if (typeof value === "boolean") return "b";
	if (value === null || value === undefined) return "null";
	return "j";
}

function csvCell(value: string): string {
	return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Legacy omni-tabular form: a ```omni-tabular fence with a type-hint row, a
 * header row, RFC-4180 data rows, and a trailing `[N rows]` line.
 */
export function encodeGcf(array: Array<Record<string, unknown>>): string {
	const columns: string[] = [];
	for (const row of array) {
		for (const key of Object.keys(row)) {
			if (!columns.includes(key)) columns.push(key);
		}
	}

	const hints: ColumnType[] = columns.map((col) => {
		for (const row of array) {
			const value = row[col];
			if (value !== undefined && value !== null) return typeHint(value);
		}
		return "null";
	});

	const cell = (row: Record<string, unknown>, col: string, hint: ColumnType): string => {
		const value = row[col] ?? null;
		if (hint === "j") return JSON.stringify(value ?? null);
		if (value === null || value === undefined) return "";
		return String(value);
	};

	const lines = [
		"```omni-tabular",
		hints.join(","),
		columns.join(","),
		...array.map((row) => columns.map((col, i) => csvCell(cell(row, col, hints[i]))).join(",")),
		`[${array.length} rows]`,
		"```",
	];
	return lines.join("\n");
}

/** Compare json vs gcf vs toon encodings on every compactable array in the text. */
export function compareEncoders(text: string, model?: TokenizerModel): EncoderComparison {
	const arrays = extractCompactableArrays(text);
	if (arrays.length === 0) {
		return {
			arraysCompared: 0,
			json: { bytes: 0, tokens: 0 },
			gcf: { bytes: 0, tokens: 0 },
			toon: null,
			toonAvailable: true,
			winner: "json",
		};
	}

	let jsonBytes = 0;
	let jsonTokens = 0;
	let gcfBytes = 0;
	let gcfTokens = 0;
	let toonBytes = 0;
	let toonTokens = 0;
	let toonAvailable = true;

	for (const array of arrays) {
		const json = JSON.stringify(array);
		jsonBytes += Buffer.byteLength(json, "utf8");
		jsonTokens += countText(json, model);

		const gcf = encodeGcf(array as Array<Record<string, unknown>>);
		gcfBytes += Buffer.byteLength(gcf, "utf8");
		gcfTokens += countText(gcf, model);

		if (toonAvailable) {
			try {
				const toon = toonEncode(array);
				toonBytes += Buffer.byteLength(toon, "utf8");
				toonTokens += countText(toon, model);
			} catch {
				toonAvailable = false;
			}
		}
	}

	const candidates: Array<[EncoderId, EncodingMeasure]> = [
		["json", { bytes: jsonBytes, tokens: jsonTokens }],
		["gcf", { bytes: gcfBytes, tokens: gcfTokens }],
	];
	if (toonAvailable) candidates.push(["toon", { bytes: toonBytes, tokens: toonTokens }]);
	candidates.sort((a, b) => a[1].tokens - b[1].tokens || a[1].bytes - b[1].bytes);

	return {
		arraysCompared: arrays.length,
		json: { bytes: jsonBytes, tokens: jsonTokens },
		gcf: { bytes: gcfBytes, tokens: gcfTokens },
		toon: toonAvailable ? { bytes: toonBytes, tokens: toonTokens } : null,
		toonAvailable,
		winner: candidates[0]![0],
	};
}
