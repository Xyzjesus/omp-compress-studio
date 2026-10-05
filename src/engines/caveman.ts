import type { CavemanIntensity } from "../config";
import type { CompressionEngine, EngineApplyOptions, EngineInput, StepResult } from "./types";
import { RU_WORDFORM_CLASSES } from "./rules/ru-wordforms";
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
const PATH_RE = /(^|\s)(?:\.{0,2}\/[\wа-яёА-ЯЁ./\-]+)/gu;
const ERROR_HEAD_RE = /^\s*(?:Error|TypeError|RangeError|SyntaxError|ReferenceError):.*$/gm;
const STACK_LINE_RE = /^\s+at\s+.*$/gm;

const INTENSITY_RANK = { lite: 1, full: 2, ultra: 3 } as const;

interface CavemanRule {
	name: string;
	minIntensity: CavemanIntensity;
	patterns: Array<[RegExp, string]>;
}

/** prose rules, ported from OmniRoute cavemanRules. Order matters for readability of results. */
const EN_RULES: CavemanRule[] = [
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

/** Alternatives longest-first: «по сути дела» must win over «по сути», «скорее всего» over shorter tokens. */
function ruCore(alternation: string, requireFollowingWord = false): string {
	const longest = alternation
		.split("|")
		.sort((a, b) => b.length - a.length)
		.join("|");
	const follow = requireFollowingWord ? String.raw`(?=\s+\p{L})` : "";
	return String.raw`(?<!\p{L})(?:${longest})${follow}(?!\p{L})`;
}

function ruDeletePatterns(core: string): Array<[RegExp, string]> {
	return [
		// Sentence-edge: absorbs its own trailing punctuation frame completely.
		[new RegExp(String.raw`(?:^|(?<=[.!?]\s))[ ,]*${core}[,.!? \t]*`, "gimu"), ""],
		// Mid-clause: neutral separator both sides → single space, keeping the comma that belongs to the preceding word.
		[new RegExp(String.raw`[ \t]*${core}[ \t]*`, "gimu"), " "],
	];
}

function ruDeleteFramedPatterns(core: string): Array<[RegExp, string]> {
	return [
		// Mid-clause: consume the whole comma frame «, X,» so no dangling comma survives.
		[new RegExp(String.raw`,\s*${core}\s*,`, "gimu"), ""],
		// Sentence-edge: phrase + trailing comma at start of a sentence.
		[new RegExp(String.raw`(?:^|(?<=[.!?]\s))[ ,]*${core},\s*`, "gimu"), ""],
	];
}

function ruDelete(alternation: string): Array<[RegExp, string]> {
	return ruDeletePatterns(ruCore(alternation));
}

/** Word-form classes come from the offline pymorphy3 generator (src/engines/rules/ru-wordforms.ts). */
function wordformRule(name: string, minIntensity: CavemanIntensity, forms: readonly string[], framed: boolean, requireFollowingWord = false): CavemanRule {
	const core = ruCore(forms.join("|"), requireFollowingWord);
	return { name, minIntensity, patterns: framed ? ruDeleteFramedPatterns(core) : ruDeletePatterns(core) };
}

/** Hand-written Russian rules. Framed deletion per plan conventions: `(?<!\p{L})…(?!\p{L})` word boundary, `ё` handled by dual-form generation upstream. */
const RU_RULES: CavemanRule[] = [
	{
		name: "ru_redundant_openers",
		minIntensity: "lite",
		patterns: [[/^(?:Привет|Здравствуйте|Здравствуй|Добрый день|Доброе утро|Добрый вечер|Доброй ночи)[,.!?\s]*\s*/gim, ""]],
	},
	{ name: "ru_pleasantries", minIntensity: "lite", patterns: ruDelete("спасибо|огромное спасибо|большое спасибо|заранее благодарю|рад помочь|буду рад помочь|с радостью помогу|готов помочь|не за что") },
	{ name: "ru_emphasis", minIntensity: "lite", patterns: ruDelete("очень|крайне|весьма|чрезвычайно|максимально|предельно|невероятно|существенно|значительно") },
	{ name: "ru_qualifiers", minIntensity: "lite", patterns: ruDelete("немного|немножко|чуть-чуть|слегка|как бы|типа того|своего рода") },
	{
		name: "ru_purpose",
		minIntensity: "lite",
		patterns: [
			[/(?<!\p{L})для того\s+чтобы(?!\p{L})/giu, "чтобы "],
			[/(?<!\p{L})с тем\s+чтобы(?!\p{L})/giu, "чтобы "],
		],
	},
	{ name: "ru_hedging", minIntensity: "full", patterns: ruDeleteFramedPatterns(ruCore("возможно|наверное|вероятно|скорее всего|видимо|по-видимому|похоже|кажется")) },
	{ name: "ru_parentheticals", minIntensity: "full", patterns: ruDeleteFramedPatterns(ruCore("кроме того|помимо этого|более того|таким образом|как правило|в частности|тем не менее|в свою очередь|по сути|по сути дела|на самом деле|иными словами|в принципе|к сожалению|к счастью|как известно|само собой|между тем|впрочем")) },
	{
		name: "ru_causality",
		minIntensity: "full",
		patterns: [
			[/(?<!\p{L})в связи с тем,?\s+что(?!\p{L})/giu, "так как "],
			[/(?<!\p{L})ввиду того,?\s+что(?!\p{L})/giu, "так как "],
			[/(?<!\p{L})несмотря на то,?\s+что(?!\p{L})/giu, "хотя "],
			[/(?<!\p{L})(?:в целях|с целью)(?!\p{L})/giu, "для "],
		],
	},
	{
		name: "ru_copula",
		minIntensity: "full",
		patterns: [[/(?<!\p{L})(?:является|являются|представляет собой)(?!\p{L})\s+/giu, "— "]],
	},
	{ name: "ru_time_parasites", minIntensity: "full", patterns: ruDelete("в настоящее время|на сегодняшний день|в данный момент|на данный момент|в скором времени|на текущий момент|на сегодняшний момент") },
	{
		// Только словарные формы им. падежа; косвенные («данного») и существительное «данные» сознательно не трогаются.
		name: "ru_officialese",
		minIntensity: "full",
		patterns: [
			[/(?<!\p{L})данный(?=\s+\p{L})/gu, "этот"],
			[/(?<!\p{L})данная(?=\s+\p{L})/gu, "эта"],
			[/(?<!\p{L})данное(?=\s+\p{L})/gu, "это"],
		],
	},
	{
		name: "ru_tautology",
		minIntensity: "full",
		patterns: [
			[/(?<!\p{L})(спускаться|спуститься|подниматься|подняться)\s+(?:вниз|вверх)(?!\p{L})/giu, "$1 "],
			[/(?<!\p{L})главная\s+суть|самая\s+суть/giu, "суть"],
			[/(?<!\p{L})(прогноз\w*)(?!\p{L})\s+на будущее(?!\p{L})/gu, "$1"],
		],
	},
	wordformRule("ru_wf_intensifiers", "lite", RU_WORDFORM_CLASSES.intensifiers, false),
	wordformRule("ru_wf_hedges", "full", RU_WORDFORM_CLASSES.hedges, true),
	wordformRule("ru_wf_determiners", "full", RU_WORDFORM_CLASSES.determiners, false, true),
];

/** Extracts protected spans to ⟦P<i>⟧ placeholders; returns masked text + restore function. */
function extractProtected(text: string): { masked: string; restore: (masked: string) => string; count: number } {
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
		count: values.length,
	};
}

/** Collapses doubled commas and empty paired punctuation left by rule deletions. Idempotent. */
function foldPairedPunctuation(text: string): string {
	return text
		.replace(/,\s*,+/g, ",")
		.replace(/«\s*»/g, "")
		.replace(/\(\s*\)/g, "");
}

/** Cyrillic ≥ 30% of Latin → ru. Ties go to ru: ru patterns are inert on Latin, en patterns actively corrupt Cyrillic text. */
function detectCavemanLanguage(text: string): "en" | "ru" {
	const cyr = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
	const lat = (text.match(/[A-Za-z]/gu) ?? []).length;
	return cyr * 10 >= lat * 3 ? "ru" : "en";
}

const RULE_SETS: Record<"en" | "ru", readonly CavemanRule[]> = {
	en: EN_RULES,
	ru: RU_RULES,
};

function cleanupArtifacts(text: string): string {
	return foldPairedPunctuation(text)
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function recapitalizeSentences(text: string): string {
	return text.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_m, prefix: string, ch: string) => prefix + ch.toUpperCase());
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

	const { masked, restore, count: placeholderCount } = extractProtected(text);

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
		const lang = detectCavemanLanguage(masked);
		const rulesApplied: string[] = [];
		let working = masked;
		for (const rule of RULE_SETS[lang]) {
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
		working = foldPairedPunctuation(working)
			.replace(/[ \t]{2,}/g, " ")
			.replace(/ +([,.;:!?])/g, "$1")
			.trim();

		if (intensity === "ultra") working = cleanupArtifacts(working);
		if (working !== masked) working = recapitalizeSentences(working);

		// A rule that consumed a ⟦P<i>⟧ placeholder deleted a protected span
		// (fence, URL, path, stack line). Restore only when every placeholder
		// survived rule application; otherwise return the original text.
		const surviving = (working.match(/⟦P\d+⟧/g) ?? []).length;
		if (surviving < placeholderCount) {
			return { output: text, techniquesUsed: [], rulesApplied: [] };
		}

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
