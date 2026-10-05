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
import { rotateLogIfHuge } from "./log-rotation";
import type { RunRecord, RunStore, RunStepSummary } from "./store";
import { dedupSessionBlocks } from "../engines/sessionDedup";
import { blockMemo } from "./block-memo";

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

const DEBUG_LOG_MAX_BYTES = 25 * 1024 * 1024;
const DEBUG_LOG_KEEP_BYTES = 2 * 1024 * 1024;
/** Smaller tool results are not worth a placeholder. */
const MIN_CLEARABLE_CHARS = 200;
/** The whole payload rewrite must save at least this many tokens to be worth a cache break. */
const MIN_PAYLOAD_GAIN_TOKENS = 32;
/** Providers cannot cache a prefix shorter than this — compressing it buys nothing. */
const MIN_CACHEABLE_TOKENS = 512;

function appendDebugEntry(entry: DebugRunEntry): void {
	fs.appendFile(debugPath(), `${JSON.stringify(entry)}\n`, "utf8").catch((err: unknown) => {
		logger.warn("compress-studio: failed to append debug entry", { error: String(err) });
	});
	// Every append: a single debug entry can be megabytes, so the size check
	// must not wait for a batch of appends to pass (the 45MB overshoot bug).
	rotateLogIfHuge(debugPath(), DEBUG_LOG_MAX_BYTES, DEBUG_LOG_KEEP_BYTES).catch((err: unknown) => {
		logger.warn("compress-studio: debug.jsonl rotation failed", { error: String(err) });
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
			cavemanIntensity: config.cavemanIntensity,
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

		// Accept only a strict win on both axes; the payload-level accept below
		// applies the clear_at_least-style hysteresis for the whole batch.
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

	const started = performance.now();
	const model = ctx.model ?? undefined;
	const api = model?.api;
	// Observability contract: every early exit records a fallback run so the
	// widget shows live traffic and WHY it passed through — never a silent
	// "req 0" that is indistinguishable from a dead hook.
	const recordFallback = (reason: string) => {
		deps.onRun(deps.store.append({
			ts: Date.now(), model: model?.id, api: api ?? "unknown", strategy: config.strategy,
			originalTokens: 0, compressedTokens: 0, savingsPercent: 0,
			steps: [], durationMs: performance.now() - started, accepted: false, fallbackReason: reason,
		}));
		return undefined;
	};

	if (payload === null || typeof payload !== "object") return recordFallback("no-payload");
	if (!api) return recordFallback("no-model-api");
	const extraction = extractBlocks(payload, api);
	if (!extraction) return recordFallback("unsupported-api");
	if (extraction.blocks.length === 0) return recordFallback("no-compressible-blocks");

	const lanesTool = toolLanes(config);
	const lanesUser = userLanes(config);
	if (lanesTool.length === 0 && lanesUser.length === 0 && !config.engines.sessionDedup && !config.engines.clear) {
		return recordFallback("no-lanes-enabled");
	}

	const payloadJson = JSON.stringify(payload); // serialized once: token baseline + accept comparison
	const debugBlocks: DebugBlockEntry[] = [];
	const debugEnabled = config.debug;
	const debugEntry = (): DebugRunEntry => ({
		ts: Date.now(),
		model: model?.id,
		api,
		strategy: config.strategy,
		payloadCharsBefore: payloadJson.length,
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

	const tokensBefore = countText(payloadJson, model);

	// Sub-cacheable payloads cannot amortize anything: provider prompt caches
	// need a ≥512-token prefix (research note §2.1), so compressing below that
	// is pure churn with nothing on the other side of the trade.
	if (tokensBefore < MIN_CACHEABLE_TOKENS) return recordFallback("below-min-cacheable");


	// writeBack mutates in place; the working copy materializes once, on the
	// first rewrite (event.payload itself is never mutated).
	let nextPayload: unknown = payload;
	let cloned = false;
	const ensureWritable = () => {
		if (!cloned) {
			nextPayload = structuredClone(payload);
			cloned = true;
		}
	};
	let changedAny = false;
	const allSteps: RunStepSummary[] = [];

	// Stage 0 (payload-level): session-dedup — first occurrence of a repeated
	// block stays verbatim, later occurrences collapse to reference markers.
	if (config.engines.sessionDedup) {
		const deduped = dedupSessionBlocks(
			extraction.blocks.map((b) => ({ text: b.text, isNewestUser: b.isNewestUser, isCurrentTurn: b.isCurrentTurn })),
		);
		for (let i = 0; i < extraction.blocks.length; i++) {
			const marker = deduped[i];
			const block = extraction.blocks[i]!;
			if (marker === null) continue;
			ensureWritable();
			nextPayload = extraction.writeBack(nextPayload, block, marker);
			changedAny = true;
			const saved = Math.max(0, countText(block.text, model) - countText(marker, model));
			allSteps.push({
				engine: "session-dedup",
				savingsPercent: countText(block.text, model) > 0 ? Math.round((saved / countText(block.text, model)) * 1000) / 10 : 0,
				rejected: false,
				techniquesUsed: ["dedup-ref-marker"],
			});
			if (debugEnabled) {
				debugBlocks.push({
					kind: block.kind, messageIndex: block.path.message, isShellTool: block.isShellTool,
					isNewestUser: false, input: block.text, output: marker,
					steps: [{ engine: "session-dedup", input: block.text, output: marker, originalTokens: countText(block.text, model), compressedTokens: countText(marker, model), rejected: false, techniquesUsed: ["dedup-ref-marker"], rulesApplied: [], durationMs: 0 }],
				});
			}
			extraction.blocks[i]!.text = marker; // downstream lanes see the marker, not the full text
		}
	}

	// Stage 0.5: Anthropic-style tool-result clearing. Past the trigger
	// budget the OLDEST tool results (beyond `keep`, never the current turn)
	// collapse to a readable placeholder — the model is told what was removed,
	// the tool_use pairing stays intact, and the window pressure drops.
	if (config.engines.clear && tokensBefore > config.clearTriggerTokens) {
		const toolIndexes = extraction.blocks
			.map((b, i) => ({ b, i }))
			.filter(({ b }) => b.kind === "tool" && !b.isCurrentTurn && b.text.length >= MIN_CLEARABLE_CHARS);
		const clearable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - config.clearKeep));
		for (const { b, i } of clearable) {
			const saved = countText(b.text, model);
			const placeholder = `[cleared: tool result elided to free context — ~${saved} tok removed]`;
			ensureWritable();
			nextPayload = extraction.writeBack(nextPayload, b, placeholder);
			extraction.blocks[i]!.text = placeholder; // downstream lanes see the placeholder
			changedAny = true;
			allSteps.push({
				engine: "clear",
				savingsPercent: saved > 0 ? Math.round(((saved - countText(placeholder, model)) / saved) * 1000) / 10 : 0,
				rejected: false,
				techniquesUsed: ["clear-tool-result"],
			});
			if (debugEnabled) {
				debugBlocks.push({
					kind: b.kind, messageIndex: b.path.message, isShellTool: b.isShellTool, isNewestUser: false,
					input: b.text, output: placeholder,
					steps: [{ engine: "clear", input: b.text, output: placeholder, originalTokens: saved, compressedTokens: countText(placeholder, model), rejected: false, techniquesUsed: ["clear-tool-result"], rulesApplied: [], durationMs: 0 }],
				});
			}
		}
	}

	for (const block of extraction.blocks) {
		// The newest user message is never compressed (safety contract).
		if (block.isNewestUser) {
			if (debugEnabled) debugBlocks.push({ kind: block.kind, messageIndex: block.path.message, isShellTool: block.isShellTool, isNewestUser: true, skipped: "newest-user" });
			continue;
		}
		// The current-turn tool result is what the model is answering from
		// right now — always verbatim.
		if (block.isCurrentTurn) {
			if (debugEnabled) debugBlocks.push({ kind: block.kind, messageIndex: block.path.message, isShellTool: block.isShellTool, isNewestUser: false, skipped: "current-turn" });
			continue;
		}
		const lanes = block.kind === "tool" ? lanesTool : lanesUser;
		if (lanes.length === 0) {
			if (debugEnabled) debugBlocks.push({ kind: block.kind, messageIndex: block.path.message, isShellTool: block.isShellTool, isNewestUser: false, skipped: "no-lanes" });
			continue;
		}

		// Memoized decision: identical inputs must produce the identical
		// compressed form, so a block is compressed exactly once per config.
		const memoKey = blockMemo.key([
			block.text, block.kind, block.isShellTool ? "shell" : "other",
			lanes.join(","), config.cavemanIntensity, JSON.stringify(config.gates), model?.id ?? "",
		]);
		const memoized = blockMemo.get(memoKey);
		const result = memoized !== undefined
			? memoized ?? undefined
			: (() => {
				const computed = compressBlock(block, block.text, lanes, config, model);
				blockMemo.set(memoKey, computed ?? null);
				return computed;
			})();
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
		ensureWritable();
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
	if (serialized.length >= payloadJson.length || tokensAfter >= tokensBefore) {
		flushDebug(false, "payload-not-smaller");
		deps.onRun(deps.store.append({
			ts: Date.now(), model: model?.id, api, strategy: config.strategy,
			originalTokens: tokensBefore, compressedTokens: tokensBefore, savingsPercent: 0,
			steps: allSteps, durationMs, accepted: false, fallbackReason: "payload-not-smaller",
		}));
		return undefined;
	}
	// clear_at_least analogue: a payload rewrite invalidates the provider's
	// prompt cache from the first edited block on — the whole batch must pay
	// for itself. Below the threshold the original payload goes out untouched.
	if (tokensBefore - tokensAfter < MIN_PAYLOAD_GAIN_TOKENS) {
		flushDebug(false, "gain-below-threshold");
		deps.onRun(deps.store.append({
			ts: Date.now(), model: model?.id, api, strategy: config.strategy,
			originalTokens: tokensBefore, compressedTokens: tokensBefore, savingsPercent: 0,
			steps: allSteps, durationMs, accepted: false, fallbackReason: "gain-below-threshold",
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
