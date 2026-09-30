import type { CavemanIntensity } from "../config";
import type { CompressionEngine, EngineApplyOptions, EngineInput, StepResult } from "./types";
import { finishStep, skippedStep } from "./types";

const MIN_TEXT_LENGTH = 50;

/** Any of these characters hint at structure (code refs, numbers, paths, tables). */
const HAS_SPECIAL_CHARS_RE = /[`~[\]$#\\/:_()0-9]/;

/** Version strings, URLs, md links, tables, env refs, zero-arg calls → skip rule phase. */
const PROTECTED_STRUCTURE_RE =
	/https?:\/\/|\[[^\]]+\]\([^)]*\)|^\s*\|.+\|\s*$|\b\d+(?:\.\d+){1,3}\b|process\.env\.[A-Za-z_$][\w$]*|\b[A-Za-z_]\w*\(\s*\)/m;

const CODE_LINE_RE = /[{};=]\s*$|^\s{4,}\S|=>|^\s*(?:function|const|let|var|class|import|export|def|return)\b/;

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
const PATH_RE = /(^|\s)(?:\.{0,2}\/[\w./\-]+)/g;
const ERROR_HEAD_RE = /^\s*(?:Error|TypeError|RangeError|SyntaxError|ReferenceError):.*$/gm;
const STACK_LINE_RE = /^\s+at\s+.*$/gm;

const INTENSITY_RANK = { lite: 1, full: 2, ultra: 3 } as const;

interface CavemanRule {
	name: string;
	minIntensity: CavemanIntensity;
	patterns: Array<[RegExp, string]>;
}

/** prose rules, ported from OmniRoute cavemanRules. Order matters for readability of results. */
const RULES: CavemanRule[] = [
	{
		name: "redundant_phrasing",
		minIntensity: "full",
		patterns: [
		[/\bmake sure to\s+/g, "ensure "],
		[/\bdue to the fact that\s+/g, "because "],
		],
	},
	{
		name: "pleasantries",
		minIntensity: "lite",
		patterns: [[/\b(?:happy to|thank you|thanks|no problem)(?:[!,.]*)\s*/gi, ""]],
	},
	{
		name: "articles",
		minIntensity: "full",
		patterns: [[/\b(?:a|an|the)\s+(?=[a-z])/g, ""]],
	},
	{
		name: "filler_phrases",
		minIntensity: "lite",
		patterns: [[/^(?:I want to|I need to|I'd like to)\s*/gim, ""]],
	},
	{
		name: "redundant_openers",
		minIntensity: "lite",
		patterns: [[/^(?:Hi there|Hello|Good morning|Hey)[,!\s]*/gim, ""]],
	},
	{
		name: "qualifier_removal",
		minIntensity: "lite",
		patterns: [[/\b(?:a bit|a little|somewhat|kind of|sort of)\s+/gi, ""]],
	},
	{
		name: "list_conjunction",
		minIntensity: "full",
		patterns: [[/,\s*and also\s+|,\s*as well as\s+/g, ", "]],
	},
	{
		name: "purpose_phrases",
		minIntensity: "lite",
		patterns: [[/\b(?:in order to|so as to)\b\s*/g, "to "]],
	},
	{
		name: "redundant_quantifiers",
		minIntensity: "full",
		patterns: [
			[/\beach and every single\b/g, "each"],
			[/\bany and all\b/g, "all"],
		],
	},
	{
		name: "verbose_connectors",
		minIntensity: "lite",
		patterns: [[/\b(?:furthermore|additionally|moreover|in addition)\b,?\s*/gi, "also "]],
	},
	{
		name: "emphasis_removal",
		minIntensity: "lite",
		patterns: [[/\b(?:very|really|extremely|highly)\s+/gi, ""]],
	},
];

/** Extracts protected spans to ⟦P<i>⟧ placeholders; returns masked text + restore function. */
function extractProtected(text: string): { masked: string; restore: (masked: string) => string } {
	const values: string[] = [];
	const stash = (match: string) => {
		const placeholder = `⟦P${values.length}⟧`;
		values.push(match);
		return placeholder;
	};

	let masked = text.replace(FENCE_RE, stash).replace(INLINE_CODE_RE, stash).replace(URL_RE, stash);
	masked = masked.replace(PATH_RE, (_m, prefix: string, path: string) => prefix + stash(path));
	masked = masked.replace(ERROR_HEAD_RE, stash).replace(STACK_LINE_RE, stash);

	return {
		masked,
		restore: (m) => m.replace(/⟦P(\d+)⟧/g, (_ph, idx) => values[Number(idx)] ?? _ph),
	};
}

function cleanupArtifacts(text: string): string {
	return text
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function recapitalizeSentences(text: string): string {
	return text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, prefix: string, ch: string) => prefix + ch.toUpperCase());
}

function isCodeDominant(text: string): boolean {
	const nonEmpty = text.split("\n").filter((line) => line.trim().length > 0);
	if (nonEmpty.length < 3) return false;
	const codeLike = nonEmpty.filter((line) => CODE_LINE_RE.test(line)).length;
	return codeLike / nonEmpty.length >= 0.3;
}

export function applyCaveman(input: EngineInput, opts?: EngineApplyOptions): StepResult {
	const text = input.text;
	const intensity: CavemanIntensity = opts?.cavemanIntensity ?? "full";

	if (text.length < MIN_TEXT_LENGTH) {
		return skippedStep("caveman", text, "too-short", opts);
	}

	const { masked, restore } = extractProtected(text);

	// Code dominance is judged on prose outside fences — fenced code is
	// placeholder-masked and irrelevant to prose rules.
	if (isCodeDominant(masked)) {
		return skippedStep("caveman", text, "code-dominant", opts);
	}

	return finishStep("caveman", text, text, () => {
		if (HAS_SPECIAL_CHARS_RE.test(masked) && PROTECTED_STRUCTURE_RE.test(masked)) {
			return { output: restore(masked), techniquesUsed: [], rulesApplied: [] };
		}

		const rank = INTENSITY_RANK[intensity];
		const rulesApplied: string[] = [];
		let working = masked;
		for (const rule of RULES) {
			if (INTENSITY_RANK[rule.minIntensity] > rank) continue;
			let ruleChanged = false;
			for (const [pattern, replacement] of rule.patterns) {
				const next = working.replace(pattern, (...args: unknown[]) => {
					ruleChanged = true;
					const groups = args.slice(1) as unknown[];
					return replacement.replace(/\$(\d)/g, (_tag, d: string) => String(groups[Number(d) - 1] ?? ""));
				});
				working = next;
			}
			if (ruleChanged) rulesApplied.push(rule.name);
		}

		// Normalize whitespace introduced by rule application (not the ultra-only cleanup pass).
		working = working.replace(/[ \t]{2,}/g, " ").replace(/ +([,.;:!?])/g, "$1");

		if (intensity === "ultra") working = cleanupArtifacts(working);
		if (working !== masked) working = recapitalizeSentences(working);

		return { output: restore(working), techniquesUsed: ["caveman"], rulesApplied };
	}, opts);
}

export const cavemanEngine: CompressionEngine = {
	id: "caveman",
	name: "Caveman",
	apply: applyCaveman,
};

/** The `lite` studio lane: caveman pinned to lite intensity regardless of config. */
export const cavemanLiteEngine: CompressionEngine = {
	id: "lite",
	name: "Caveman (lite)",
	apply(input: EngineInput, opts?: EngineApplyOptions) {
		return applyCaveman(input, { ...opts, cavemanIntensity: "lite" });
	},
};
