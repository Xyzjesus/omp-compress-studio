import { completeSimple } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { StudioConfig } from "./config";

const JUDGE_SYSTEM_PROMPT =
	"You are a strict evaluation judge. You are given two answers to the same question: answer A produced from the full context, and answer B produced from a compressed context. Decide whether B MATERIALLY differs from A (a difference that changes the substance, correctness, or key facts — NOT mere wording/format). Reply with exactly one final line: `VERDICT: SAME` or `VERDICT: MATERIALLY_DIFFERS`.";

export interface JudgePair {
	id: string;
	original: string;
	compressed: string;
}

export type JudgeVerdict = "same" | "materially-differs" | "unparseable";

export interface JudgeResult {
	id: string;
	verdict: JudgeVerdict | null;
	usdCost: number;
	skippedCapped?: boolean;
	error?: string;
}

export interface JudgeBatchResult {
	results: JudgeResult[];
	totalUsd: number;
	capped: boolean;
	error?: string;
}

/** Verdict parser: the final VERDICT line wins; heuristics only on the last line so prose like "nothing differs" cannot flip the verdict. */
export function parseVerdict(text: string): JudgeVerdict {
	const lowered = text.trim().toLowerCase();
	const lastLine = lowered.split("\n").filter((line) => line.trim().length > 0).pop() ?? "";
	const explicit = lastLine.match(/verdict:\s*(same|materially[\s_-]*differs)/);
	if (explicit) return explicit[1]!.startsWith("m") ? "materially-differs" : "same";
	if (/materially[\s_-]*differs/.test(lastLine)) return "materially-differs";
	if (/\bsame\b/.test(lastLine)) return "same";
	return "unparseable";
}


export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<typeof message.content[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function judgeCostUsd(model: Model, usage: AssistantMessage["usage"]): number {
	return (usage.input / 1e6) * model.cost.input + (usage.output / 1e6) * model.cost.output;
}

export interface JudgeRuntime {
	model: Model;
	apiKey: string;
}

/** Shared model/credential resolution for judge-style batches (fidelity + recovery). */
export async function resolveJudgeRuntime(
	ctx: ExtensionContext,
	config: StudioConfig,
): Promise<JudgeRuntime | { error: string }> {
	const model: Model | undefined = config.judgeModel ? ctx.models.resolve(config.judgeModel) : ctx.model;
	if (!model) return { error: "no judge model available" };
	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKey(model);
	} catch (err) {
		if (err instanceof Error && err.message === "aborted") throw err;
		apiKey = undefined;
	}
	if (!apiKey) return { error: `no credentials for ${model.provider}` };
	return { model, apiKey };
}

/**
 * Sequential fidelity judging of compression pairs with a USD cap.
 * Pair calls that throw surface as `unparseable` with zero cost.
 */
export async function judgeFidelityBatch(
	pairs: JudgePair[],
	ctx: ExtensionContext,
	config: StudioConfig,
	signal?: AbortSignal,
): Promise<JudgeBatchResult> {
	const model: Model | undefined = config.judgeModel ? ctx.models.resolve(config.judgeModel) : ctx.model;
	if (!model) {
		return {
			results: pairs.map((pair) => ({ id: pair.id, verdict: null, usdCost: 0, error: "no judge model" })),
			totalUsd: 0,
			capped: false,
			error: "no judge model available",
		};
	}

	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKey(model);
	} catch (err) {
		apiKey = undefined;
		if (err instanceof Error && err.message === "aborted") throw err;
	}
	if (!apiKey) {
		return {
			results: pairs.map((pair) => ({ id: pair.id, verdict: null, usdCost: 0, error: "no credentials" })),
			totalUsd: 0,
			capped: false,
			error: `no credentials for ${model.provider}`,
		};
	}

	const results: JudgeResult[] = [];
	let totalUsd = 0;
	let capped = false;

	for (const pair of pairs) {
		if (totalUsd >= config.costCapUsd) {
			capped = true;
			results.push({ id: pair.id, verdict: null, usdCost: 0, skippedCapped: true });
			continue;
		}
		try {
			const response = await completeSimple(model, {
				systemPrompt: [JUDGE_SYSTEM_PROMPT],
				messages: [
					{
						role: "user",
						content: `Answer A (full context):\n${pair.original}\n\nAnswer B (compressed context):\n${pair.compressed}`,
						timestamp: Date.now(),
					},
				],
			}, { apiKey, signal });
			const usdCost = judgeCostUsd(model, response.usage);
			totalUsd += usdCost;
			results.push({ id: pair.id, verdict: parseVerdict(assistantText(response)), usdCost });
		} catch (err) {
			if (signal?.aborted) throw err;
			results.push({
				id: pair.id,
				verdict: null,
				usdCost: 0,
				error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
			});
		}
	}

	return { results, totalUsd, capped };
}
