import { completeSimple } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { StudioConfig } from "./config";
import { criticalNeedles } from "./gates/fidelity";
import type { JudgePair } from "./judge";
import { assistantText, judgeCostUsd, resolveJudgeRuntime } from "./judge";

/**
 * Recovery eval (research note §10 / LongLLMLingua `recover()`): can a model
 * still EXTRACT the critical facts from the COMPRESSED text? Fidelity gates
 * only check substring survival; this asks a model to read the compressed
 * representation and list its URLs, versions, paths, and identifiers, then
 * scores the answer against the ORIGINAL's needles programmatically.
 */

const RECOVERY_SYSTEM_PROMPT =
	"You are a precise extraction tool. List VERBATIM, one per line, every URL, semantic version, file path, and code identifier (constants, dotted names, function calls) that appears in the given text. Output ONLY the list, no commentary, no duplicates. If the text contains none, output nothing.";

export interface RecoveryResult {
	id: string;
	/** Share of the ORIGINAL's critical needles the model recovered from the compressed text, %. */
	recallPercent: number | null;
	/** Original needles missing from the model's answer (first 5, diagnostic). */
	missed: string[];
	usdCost: number;
	skippedCapped?: boolean;
	error?: string;
}

export interface RecoveryBatchResult {
	results: RecoveryResult[];
	totalUsd: number;
	capped: boolean;
	error?: string;
}

function collapseWs(text: string): string {
	return text.replace(/\s+/g, " ");
}

/**
 * Whitespace-tolerant needle match: LLM answers wrap long URLs/paths across
 * lines and reindent lists, so an exact substring check would report false
 * misses. Space-containing needles match on collapsed whitespace; space-free
 * needles additionally match across removed newlines only (a URL broken by a
 * hard wrap recovers; enumerated lists cannot merge into false positives).
 */
function needleInAnswer(answer: string, needle: string): boolean {
	if (answer.includes(needle)) return true;
	if (collapseWs(answer).includes(collapseWs(needle))) return true;
	return !needle.includes(" ") && answer.replace(/\s*\n\s*/g, "").includes(needle);
}

/** Pure recall scoring: which of `needles` can be recovered from the model's answer. */
export function recoveryRecall(answer: string, needles: readonly string[]): { recallPercent: number; missed: string[] } {
	if (needles.length === 0) return { recallPercent: 100, missed: [] };
	const missed = needles.filter((needle) => !needleInAnswer(answer, needle));
	const recallPercent = Math.round(((needles.length - missed.length) / needles.length) * 1000) / 10;
	return { recallPercent, missed: missed.slice(0, 5) };
}


/**
 * Sequential recovery eval, capped at costCapUsd per batch (independent of the
 * fidelity judge batch). Pairs whose original has no critical needles score
 * 100 with zero cost (nothing to recover).
 */
export async function judgeRecoveryBatch(
	pairs: JudgePair[],
	ctx: ExtensionContext,
	config: StudioConfig,
	signal?: AbortSignal,
): Promise<RecoveryBatchResult> {
	const runtime = await resolveJudgeRuntime(ctx, config);
	if ("error" in runtime) {
		return { results: [], totalUsd: 0, capped: false, error: runtime.error };
	}
	const { model, apiKey } = runtime;

	const results: RecoveryResult[] = [];
	let totalUsd = 0;
	let capped = false;

	for (const pair of pairs) {
		const needles = criticalNeedles(pair.original);
		if (needles.length === 0) {
			results.push({ id: pair.id, recallPercent: 100, missed: [], usdCost: 0 });
			continue;
		}
		if (totalUsd >= config.costCapUsd) {
			capped = true;
			results.push({ id: pair.id, recallPercent: null, missed: [], usdCost: 0, skippedCapped: true });
			continue;
		}
		try {
			const response = await completeSimple(model, {
				systemPrompt: [RECOVERY_SYSTEM_PROMPT],
				messages: [
					{
						role: "user",
						content: `Text (possibly compressed):\n${pair.compressed}`,
						timestamp: Date.now(),
					},
				],
			}, { apiKey, signal });
			const usdCost = judgeCostUsd(model, response.usage);
			totalUsd += usdCost;
			const { recallPercent, missed } = recoveryRecall(assistantText(response), needles);
			results.push({ id: pair.id, recallPercent, missed, usdCost });
		} catch (err) {
			if (signal?.aborted) throw err;
			results.push({
				id: pair.id,
				recallPercent: null,
				missed: [],
				usdCost: 0,
				error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
			});
		}
	}

	return { results, totalUsd, capped };
}
