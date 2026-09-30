import { countText, type TokenizerModel } from "../tokens";
import type { CavemanIntensity } from "../config";

export type EngineRole = "user" | "tool" | "assistant";

export interface EngineInput {
	text: string;
	role: EngineRole;
	/** Shell-family tool output unlocks command-aware rtk filter stages. */
	isShellTool?: boolean;
}

export interface StepResult {
	engine: string;
	input: string;
	output: string;
	originalTokens: number;
	compressedTokens: number;
	savingsPercent: number;
	techniquesUsed: string[];
	rulesApplied: string[];
	durationMs: number;
	rejected?: boolean;
	rejectReason?: string;
}

export interface EngineApplyOptions {
	cavemanIntensity?: CavemanIntensity;
	/** Target model for token counting; falls back to the byte-estimate counter. */
	model?: TokenizerModel;
}

export interface CompressionEngine {
	id: string;
	name: string;
	apply(input: EngineInput, opts?: EngineApplyOptions): StepResult;
}

/** Step that ran its skip gate: text unchanged, rejected with a reason. */
export function skippedStep(engine: string, input: string, reason: string, opts?: EngineApplyOptions): StepResult {
	return {
		engine,
		input,
		output: input,
		originalTokens: countText(input, opts?.model),
		compressedTokens: countText(input, opts?.model),
		savingsPercent: 0,
		techniquesUsed: [],
		rulesApplied: [],
		durationMs: 0,
		rejected: true,
		rejectReason: reason,
	};
}

/** Shared step bookkeeping: timing, token accounting, no-gain rejection. */
export function finishStep(
	engine: string,
	input: string,
	output: string,
	transform: () => { output: string; techniquesUsed: string[]; rulesApplied: string[] },
	opts?: EngineApplyOptions,
): StepResult {
	const originalTokens = countText(input, opts?.model);
	const started = performance.now();
	const { output: transformed, techniquesUsed, rulesApplied } = transform();
	const durationMs = performance.now() - started;
	const compressedTokens = countText(transformed, opts?.model);
	const noGain = compressedTokens >= originalTokens;
	return {
		engine,
		input,
		output: noGain ? input : transformed,
		originalTokens,
		compressedTokens: noGain ? originalTokens : compressedTokens,
		savingsPercent: noGain
			? 0
			: Math.round(((originalTokens - compressedTokens) / originalTokens) * 1000) / 10,
		techniquesUsed,
		rulesApplied: transformed === input ? [] : rulesApplied,
		durationMs,
		rejected: noGain ? true : undefined,
		rejectReason: noGain ? "no-gain" : undefined,
	};
}
