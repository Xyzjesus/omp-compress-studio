import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BeforeProviderRequestEvent } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs/promises";
import { debugPath } from "../config";
import { countText, type TokenizerModel } from "../tokens";
import type { StudioConfig } from "../config";
import type { LiveLane } from "../engines/pipeline";
import { runPipeline } from "../engines/pipeline";
import type { StepResult } from "../engines/types";
import { fidelityCheck } from "../gates/fidelity";
import type { RiskMaskResult } from "../gates/risk";
import { applyRiskMask } from "../gates/risk";
import type { QuantumLock } from "../gates/quantum";
import { quantumLock } from "../gates/quantum";
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtractedBlock } from "./formats";
import { extractBlocks } from "./formats";
import type { RunRecord, RunStore, RunStepSummary } from "./store";

export interface DebugBlockEntry {
	kind: "tool" | "user";
	messageIndex: number;
	isShellTool: boolean;
	isNewestUser: boolean;
	skipped?: string;
	input?: string;
	output?: string;
	steps?: Array<Pick<StepResult, "engine" | "input" | "output" | "originalTokens" | "compressedTokens" | "rejected" | "rejectReason" | "techniquesUsed" | "rulesApplied" | "durationMs">>;
}

export interface DebugRunEntry {
	ts: number;
	model?: string;
	api: string;
	strategy: string;
	payloadCharsBefore: number;
	payloadCharsAfter: number;
	accepted: boolean;
	fallbackReason?: string;
	blocks: DebugBlockEntry[];
}

function appendDebugEntry(entry: DebugRunEntry): void {
	fs.appendFile(debugPath(), `${JSON.stringify(entry)}\n`, "utf8").catch((err: unknown) => {
		logger.warn("compress-studio: failed to append debug entry", { error: String(err) });
	});
}

export interface CaptureDeps {
	/** Live config getter (config mutates via studio/command without re-registering). */
	getConfig: () => StudioConfig;
	store: RunStore;
	/** Throttled widget refresh hook. */
	onRun: (record: RunRecord) => void;
	/** Debug sink override (tests); defaults to appending to debug.jsonl. */
	appendDebug?: (entry: DebugRunEntry) => void;
}

function toolLanes(config: StudioConfig): LiveLane[] {
	const lanes: LiveLane[] = [];
	if (config.engines.dedup) lanes.push("dedup");
	if (config.engines.rtk) lanes.push("rtk");
	if (config.engines.truncate) lanes.push("truncate");
	if (config.engines.caveman) lanes.push("caveman");
	return lanes;
}

function userLanes(config: StudioConfig): LiveLane[] {
	return config.engines.caveman ? ["caveman"] : [];
}

function stepSummary(step: StepResult): RunStepSummary {
	return {
		engine: step.engine,
		savingsPercent: step.savingsPercent,
		rejected: step.rejected === true,
		rejectReason: step.rejectReason,
		techniquesUsed: step.techniquesUsed,
	};
}

function compressBlock(
	block: ExtractedBlock,
	text: string,
	lanes: LiveLane[],
	config: StudioConfig,
	model: TokenizerModel,
): { text: string; steps: RunStepSummary[]; rawSteps: StepResult[] } | undefined {
	try {
		let working = text;

		let riskMasked: RiskMaskResult | undefined;
		if (config.gates.riskGate) {
			riskMasked = applyRiskMask(working);
			if (riskMasked.docLevelReject) {
				return { text: working, steps: [{ engine: "risk-gate", savingsPercent: 0, rejected: true, rejectReason: riskMasked.docLevelReject, techniquesUsed: [] }], rawSteps: [] };
			}
			working = riskMasked.masked;
		}

		let lock: QuantumLock | undefined;
		if (config.gates.quantumLock) {
			lock = quantumLock(working);
			working = lock.text;
		}

		const { steps, output } = runPipeline(working, block.kind === "tool" ? "tool" : "user", lanes, {
			model,
			isShellTool: block.isShellTool,
			fuzzy: config.gates.fuzzyDedup,
			postCheck: config.gates.fidelityGate ? (step) => fidelityCheck(step).step : undefined,
		});

		let restored = lock ? lock.restore(output) : output;
		if (riskMasked) restored = riskMasked.restore(restored);

		// Placeholder round-trip guard: engines must neither drop nor duplicate
		// gate placeholders. smartTruncate/dedup delete whole lines, and a lost
		// ⟦Q⟧/⟦risk_⟧ means a "protected" span was silently deleted (fidelity
		// is blind to it — its needles come from the masked text).
		const countPlaceholders = (s: string, re: RegExp) => (s.match(re) ?? []).length;
		const residual = /⟦(?:Q\d+|risk_[a-z_]+\d+)⟧/.test(restored);
		const quantumRoundTrip =
			!lock ||
			countPlaceholders(output, /⟦Q\d+⟧/g) === lock.stats.fragments;
		const riskRoundTrip =
			!riskMasked ||
			riskMasked.stats.spansProtected === 0 ||
			(countPlaceholders(working, /⟦risk_[a-z_]+\d+⟧/g) === riskMasked.stats.spansProtected &&
				countPlaceholders(restored, /⟦risk_[a-z_]+\d+⟧/g) === 0);
		if (residual || !quantumRoundTrip || !riskRoundTrip) {
			return undefined;
		}

		// Accept only a strict win on both axes.
		if (restored.length < text.length && countText(restored, model) < countText(text, model)) {
			return { text: restored, steps: steps.map(stepSummary), rawSteps: steps };
		}
		return undefined;
	} catch (err) {
		logger.warn("compress-studio: block compression failed, sending original", {
			error: err instanceof Error ? err.message : String(err),
			kind: block.kind,
			messageIndex: block.path.message,
		});
		return undefined;
	}
}

/**
 * `before_provider_request` handler: compress eligible tool/user blocks of the
 * outgoing payload. Returns the replacement payload, or `undefined` to send
 * the original.
 */
export async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	deps: CaptureDeps,
): Promise<unknown> {
	const config = deps.getConfig();
	// Runtime truth is config.engines (+ gates); `strategy` is a preset label
	// only. The "off" preset writes all engines off, so this no-ops naturally.
	if (!config.enabled) return undefined;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return undefined;
	const api = ctx.model?.api;
	if (!api) return undefined;
	const extraction = extractBlocks(payload, api);
	if (!extraction || extraction.blocks.length === 0) return undefined;

	const started = performance.now();
	const lanesTool = toolLanes(config);
	const lanesUser = userLanes(config);
	if (lanesTool.length === 0 && lanesUser.length === 0) return undefined;

	const debugBlocks: DebugBlockEntry[] = [];
	const debugEnabled = config.debug;
	const debugEntry = (): DebugRunEntry => ({
		ts: Date.now(),
		model: model?.id,
		api,
		strategy: config.strategy,
		payloadCharsBefore: JSON.stringify(payload).length,
		payloadCharsAfter: JSON.stringify(nextPayload).length,
		accepted: false,
		blocks: debugBlocks,
	});
	const flushDebug = (accepted: boolean, fallbackReason?: string) => {
		if (!debugEnabled) return;
		const entry = debugEntry();
		entry.accepted = accepted;
		entry.fallbackReason = fallbackReason;
		(deps.appendDebug ?? appendDebugEntry)(entry);
	};

	const model = ctx.model ?? undefined;
	const tokensBefore = countText(JSON.stringify(payload), model);

	let nextPayload: unknown = payload;
	let changedAny = false;
	const allSteps: RunStepSummary[] = [];

	for (const block of extraction.blocks) {
		// The newest user message is never compressed (safety contract).
		if (block.isNewestUser) {
			if (debugEnabled) debugBlocks.push({ kind: block.kind, messageIndex: block.path.message, isShellTool: block.isShellTool, isNewestUser: true, skipped: "newest-user" });
			continue;
		}
		const lanes = block.kind === "tool" ? lanesTool : lanesUser;
		if (lanes.length === 0) {
			if (debugEnabled) debugBlocks.push({ kind: block.kind, messageIndex: block.path.message, isShellTool: block.isShellTool, isNewestUser: false, skipped: "no-lanes" });
			continue;
		}

		const result = compressBlock(block, block.text, lanes, config, model);
		if (!result) {
			if (debugEnabled) debugBlocks.push({ kind: block.kind, messageIndex: block.path.message, isShellTool: block.isShellTool, isNewestUser: false, skipped: "no-gain-or-gate" });
			continue;
		}
		if (debugEnabled) {
			debugBlocks.push({
				kind: block.kind,
				messageIndex: block.path.message,
				isShellTool: block.isShellTool,
				isNewestUser: false,
				input: block.text,
				output: result.text,
				steps: result.rawSteps.map((step) => ({
					engine: step.engine, input: step.input, output: step.output,
					originalTokens: step.originalTokens, compressedTokens: step.compressedTokens,
					rejected: step.rejected === true, rejectReason: step.rejectReason,
					techniquesUsed: step.techniquesUsed, rulesApplied: step.rulesApplied,
					durationMs: step.durationMs,
				})),
			});
		}
		if (result.text === block.text) continue;
		nextPayload = extraction.writeBack(nextPayload, block, result.text);
		changedAny = true;
		allSteps.push(...result.steps);
	}

	const durationMs = performance.now() - started;
	if (!changedAny) {
		flushDebug(false, "no-block-changed");
		deps.onRun(deps.store.append({
			ts: Date.now(), model: model?.id, api, strategy: config.strategy,
			originalTokens: tokensBefore, compressedTokens: tokensBefore, savingsPercent: 0,
			steps: allSteps, durationMs, accepted: false, fallbackReason: "no-block-changed",
		}));
		return undefined;
	}

	const serialized = JSON.stringify(nextPayload);
	const tokensAfter = countText(serialized, model);
	if (serialized.length >= JSON.stringify(payload).length || tokensAfter >= tokensBefore) {
		flushDebug(false, "payload-not-smaller");
		deps.onRun(deps.store.append({
			ts: Date.now(), model: model?.id, api, strategy: config.strategy,
			originalTokens: tokensBefore, compressedTokens: tokensBefore, savingsPercent: 0,
			steps: allSteps, durationMs, accepted: false, fallbackReason: "payload-not-smaller",
		}));
		return undefined;
	}

	const savingsPercent =
		tokensBefore > 0 ? Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 1000) / 10 : 0;
	const record: RunRecord = {
		ts: Date.now(),
		model: model?.id,
		api,
		strategy: config.strategy,
		originalTokens: tokensBefore,
		compressedTokens: tokensAfter,
		savingsPercent,
		steps: allSteps,
		durationMs,
		accepted: true,
	};
	deps.onRun(deps.store.append(record));
	flushDebug(true);
	return nextPayload;
}
