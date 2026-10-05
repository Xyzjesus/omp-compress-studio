import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { handleBeforeProviderRequest, type DebugRunEntry } from "../src/live/capture";
import { RunStore } from "../src/live/store";
import { blockMemo } from "../src/live/block-memo";
import { DEFAULT_CONFIG, applyStrategyPreset, sanitizeConfig, type StudioConfig } from "../src/config";

const MODEL = { id: "test-model", api: "anthropic-messages" } as unknown as Model;

function fakeCtx(model: Model | undefined = MODEL): ExtensionContext {
	return { model, hasUI: true } as unknown as ExtensionContext;
}

function messagesOf(value: unknown): unknown[] {
	if (isRecord(value) && Array.isArray(value.messages)) return value.messages;
	throw new Error("payload has no messages array");
}

function inputItemsOf(value: unknown): unknown[] {
	if (isRecord(value) && Array.isArray(value.input)) return value.input;
	throw new Error("payload has no input array");
}

function field(value: unknown, name: string): unknown {
	if (isRecord(value) && name in value) return value[name];
	return undefined;
}

function bigToolOutput(): string {
	const parts = ["$ bun test --all"];
	// numeric-light repeated lines: survives the fidelity numeric invariant
	for (let i = 0; i < 200; i++) {
		parts.push("ok — running suite module.test.ts with several assertions in short order");
	}
	parts.push("ERROR: module_4.test.ts:88 — expected 42, got 43");
	for (let i = 0; i < 30; i++) parts.push(`summary line ${i}: all subsystems nominal`);
	return parts.join("\n");
}

function syntheticPayload(): Record<string, unknown> {
	return {
		model: "claude-test",
		max_tokens: 1024,
		system: [{ type: "text", text: "You are a helpful assistant." }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "Summarize the earlier test run and tell me what to fix first, please provide a lot of detail about it." }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "bash", input: { command: "bun test" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: bigToolOutput() }] },
			{ role: "assistant", content: [{ type: "text", text: "Acknowledged the test results." }] },
			{ role: "user", content: [{ type: "text", text: "And what is 2+2?" }] },
		],
	};
}

function verboseProse(): string {
	// caveman-sensitive filler repeated enough that the payload-level gain
	// clears MIN_PAYLOAD_GAIN_TOKENS (micro-gain rewrites are now rejected)
	return Array.from({ length: 40 }, () => "Furthermore, I want to kind of make sure that it is very much okay in order to proceed safely.").join(" ");
}

describe("capture", () => {
	test("compresses tool_result, preserves newest user byte-for-byte, records a run", async () => {
		const payload = syntheticPayload();
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");

		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx(),
			{ getConfig: () => config, store, onRun: () => {} },
		);
		expect(isRecord(result)).toBe(true);
		expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(payload).length);

		const messages = messagesOf(result);
		const payloadMessages = messagesOf(payload);
		// system untouched
		expect(field(result, "system")).toEqual(field(payload, "system"));
		// newest user message untouched byte-for-byte
		expect(messages[4]).toEqual(payloadMessages[4]);
		// old-prose user block (previous turn) compresses via caveman
		expect(JSON.stringify(messages[0]).length).toBeLessThan(JSON.stringify(payloadMessages[0]).length);

		// run recorded with a non-empty breakdown
		expect(store.recent()).toHaveLength(1);
		const record = store.recent()[0]!;
		expect(record.accepted).toBe(true);
		expect(record.steps.length).toBeGreaterThan(0);
		expect(record.savingsPercent).toBeGreaterThan(0);
		expect(record.api).toBe("anthropic-messages");
	});

	test("debug flag writes per-block input/output texts", async () => {
		const payload = syntheticPayload();
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true, debug: true }, "stacked");
		const debugEntries: DebugRunEntry[] = [];
		await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx(),
			{ getConfig: () => config, store, onRun: () => {}, appendDebug: (entry) => debugEntries.push(entry) },
		);

		expect(debugEntries).toHaveLength(1);
		const entry = debugEntries[0]!;
		expect(entry.accepted).toBe(true);
		expect(entry.payloadCharsAfter).toBeLessThan(entry.payloadCharsBefore);

		// newest user recorded as skipped, never with rewritten text
		const newest = entry.blocks.find((b) => b.isNewestUser);
		expect(newest?.skipped).toBe("newest-user");
		expect(newest?.output).toBeUndefined();

		// the compressed tool block carries full before/after plus step detail
		const toolBlock = entry.blocks.find((b) => b.kind === "tool");
		expect(toolBlock?.input).toBe(bigToolOutput());
		expect(toolBlock?.output?.length ?? 0).toBeGreaterThan(0);
		expect(toolBlock!.output!.length).toBeLessThan(toolBlock!.input!.length);
		expect(toolBlock?.steps?.length ?? 0).toBeGreaterThan(0);
		expect(toolBlock?.steps?.some((s) => !s.rejected)).toBe(true);
	});
	test("image-bearing tool_result is left untouched", async () => {
		const payload = {
			model: "claude-test",
			max_tokens: 1024,
			messages: [
				{ role: "user", content: [{ type: "text", text: verboseProse() }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "bash", input: { command: "shot" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: [
					{ type: "text", text: "ok — running suite module.test.ts with several assertions in short order\n".repeat(100) + "ERROR: x.ts:1 — boom" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
				] }] },
				{ role: "assistant", content: [{ type: "text", text: "Acknowledged the test results." }] },
				{ role: "user", content: [{ type: "text", text: "And what is 2+2?" }] },
			],
		};
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx(),
			{ getConfig: () => config, store, onRun: () => {} },
		);
		const messages = messagesOf(result);
		expect(messages[3]).toEqual(payload.messages[3]);

	});
	test("openai-completions payload round-trips with old user prose compressed", async () => {
		const payload = {
			model: "gpt-test",
			messages: [
			{ role: "user", content: verboseProse() },
				{ role: "assistant", content: "Sure." },
				{ role: "user", content: "And what is 2+2?" },
			],
		};
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const ctx = fakeCtx({ id: "m", api: "openai-completions" } as unknown as Model);
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			ctx,
			{ getConfig: () => config, store, onRun: () => {} },
		);
		const messages = messagesOf(result);
		expect(messages[3]).toEqual(payload.messages[3]); // newest untouched
		expect(JSON.stringify(messages[0]).length).toBeLessThan(JSON.stringify(payload.messages[0]).length);

	});
	test("openai-responses payload round-trips and compresses old user text", async () => {
		const payload = {
			model: "gpt-test",
			input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: verboseProse() }] },
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Understood." }] },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "And what is 2+2?" }] },
			],
		};
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const ctx = fakeCtx({ id: "m", api: "openai-responses" } as unknown as Model);
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			ctx,
			{ getConfig: () => config, store, onRun: () => {} },
		);
		const items = inputItemsOf(result);
		expect(items[1]).toEqual(payload.input[1]); // newest untouched
		expect(JSON.stringify(items[0]).length).toBeLessThan(JSON.stringify(payload.input[0]).length);
	});

	test("disabled config returns undefined and records nothing", async () => {
		const payload = syntheticPayload();
		const store = new RunStore(undefined, null);
		const config = { ...DEFAULT_CONFIG, enabled: false };
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx(),
			{ getConfig: () => config, store, onRun: () => {} },
		);
		expect(result).toBeUndefined();
		expect(store.recent()).toHaveLength(0);
	});

	test("unknown api returns undefined", async () => {
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const ctx = fakeCtx({ id: "m", api: "google-generative-ai" } as unknown as Model);
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload: syntheticPayload() },
			ctx,
			{ getConfig: () => config, store, onRun: () => {} },
		);
		expect(result).toBeUndefined();
	});
});

describe("real omp api strings", () => {
	// omp's Model.api type uses "anthropic-messages" (packages/ai/src/types.ts),
	// never "anthropic" — a payload on a Claude-compatible model (e.g. zai/glm)
	// must extract and compress exactly like the test fixture api above.
	test("anthropic-messages payload extracts and records a run", async () => {
		const payload = syntheticPayload();
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const ctx = fakeCtx({ id: "zai/glm-5.3", api: "anthropic-messages" } as unknown as Model);
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			ctx,
			{ getConfig: () => config, store, onRun: () => {} },
		);
		expect(isRecord(result)).toBe(true);
		expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(payload).length);
		expect(store.recent()).toHaveLength(1);
		expect(store.recent()[0]!.accepted).toBe(true);
	});

	test("unsupported api records a fallback run instead of silence", async () => {
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const ctx = fakeCtx({ id: "m", api: "ollama-chat" } as unknown as Model);
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload: syntheticPayload() },
			ctx,
			{ getConfig: () => config, store, onRun: () => {} },
		);
		expect(result).toBeUndefined();
		// observability contract: the widget must show the request and why it
		// fell through, not a permanent "req 0"
		expect(store.recent()).toHaveLength(1);
		const record = store.recent()[0]!;
		expect(record.accepted).toBe(false);
		expect(record.fallbackReason).toBe("unsupported-api");
	});

	test("numbered counter spam in tool output compresses under the omniroute preset", async () => {
		// Lines differing ONLY by a counter are noise to smartTruncate (digits
		// normalize away) — fidelity must not roll that back: the repeated shape
		// is preserved by its first occurrence.
		const toolOut = Array.from({ length: 400 }, (_, i) => `line ${i}: ok — running suite module.test.ts with several assertions`).join("\n");
		const payload = syntheticPayload();
		(payload.messages as Array<{ content: Array<{ type: string; content: string }> }>)[2]!.content[0]!.content = toolOut;
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "omniroute");
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx({ id: "zai/glm-5.3", api: "anthropic-messages" } as unknown as Model),
			{ getConfig: () => config, store, onRun: () => {} },
		);
		expect(isRecord(result)).toBe(true);
		const record = store.recent()[0]!;
		expect(record.accepted).toBe(true);
		expect(record.savingsPercent).toBeGreaterThan(50);
	});

	test("repeat request is served from the block memo byte-identically", async () => {
		blockMemo.reset();
		const payload = syntheticPayload();
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const deps = { getConfig: () => config, store, onRun: () => {} };
		const first = await handleBeforeProviderRequest({ type: "before_provider_request", payload }, fakeCtx(), deps);
		const hitsAfterFirst = blockMemo.stats.hits;
		const second = await handleBeforeProviderRequest({ type: "before_provider_request", payload }, fakeCtx(), deps);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(blockMemo.stats.hits).toBeGreaterThan(hitsAfterFirst);

		// Config change (intensity) must invalidate the decision, not reuse it.
		const retuned = { ...config, cavemanIntensity: "ultra" as const };
		await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload: syntheticPayload() },
			fakeCtx(),
			{ getConfig: () => retuned, store, onRun: () => {} },
		);
		const beforeMisses = blockMemo.stats.misses;
		await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload: syntheticPayload() },
			fakeCtx(),
			{ getConfig: () => retuned, store, onRun: () => {} },
		);
		expect(blockMemo.stats.misses).toBe(beforeMisses); // retuned keys already memoized on first call
		expect(blockMemo.stats.hits).toBeGreaterThan(0);
		blockMemo.reset();
	});

	test("usage accumulator sums cache buckets", () => {
		const store = new RunStore(undefined, null);
		store.recordUsage({ input: 100, output: 50, cacheRead: 900, cacheWrite: 200 });
		store.recordUsage({ input: 100, cacheRead: 900 });
		expect(store.usageTotals()).toEqual({ input: 200, output: 50, cacheRead: 1800, cacheWrite: 200 });
	});
});

function toolText(message: unknown): string {
	if (isRecord(message) && Array.isArray(message.content)) {
		const part = message.content[0];
		if (isRecord(part)) {
			if (typeof part.content === "string") return part.content;
			if (typeof part.text === "string") return part.text;
		}
	}
	throw new Error("unexpected tool message shape");
}

describe("clear stage", () => {
	function threeToolPayload(): Record<string, unknown> {
		const big = (seed: string) => `${seed} ${"payload ".repeat(120)}`.trim();
		return {
			model: "zai/glm-5.3",
			messages: [
				{ role: "user", content: [{ type: "text", text: "Old question." }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: big("first") }] },
				{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				{ role: "user", content: [{ type: "text", text: "Second question." }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "bash", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: big("second") }] },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
				// current turn: tool result the model answers from right now
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_3", content: big("current") }] },
				{ role: "user", content: [{ type: "text", text: "Summarize." }] },
			],
		};
	}

	test("past trigger: oldest tool results clear, keep + current turn survive", async () => {
		const payload = threeToolPayload();
		const store = new RunStore(undefined, null);
		const base = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "omniroute");
		const config: StudioConfig = {
			...base,
			engines: { ...base.engines, clear: true },
			clearTriggerTokens: 100, // armed: payload is far larger
			clearKeep: 1,
		};
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx({ id: "zai/glm-5.3", api: "anthropic-messages" } as unknown as Model),
			{ getConfig: () => config, store, onRun: () => {} },
		);
		expect(isRecord(result)).toBe(true);
		const messages = messagesOf(result);
		expect(toolText(messages[2])).toContain("[cleared:");
		expect(toolText(messages[6])).not.toContain("[cleared:"); // keep=1 survives
		expect(toolText(messages[8])).not.toContain("[cleared:"); // current turn verbatim
		const record = store.recent()[0]!;
		expect(record.accepted).toBe(true);
		expect(record.steps.some((s) => s.engine === "clear")).toBe(true);
		// original payload untouched
		expect(toolText(messagesOf(payload)[2])).not.toContain("[cleared:");
	});

	test("below trigger: nothing clears", async () => {
		const payload = threeToolPayload();
		const base = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "omniroute");
		const config: StudioConfig = {
			...base,
			engines: { ...base.engines, clear: true },
			clearTriggerTokens: 10_000_000,
			clearKeep: 1,
		};
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx({ id: "zai/glm-5.3", api: "anthropic-messages" } as unknown as Model),
			{ getConfig: () => config, store: new RunStore(undefined, null), onRun: () => {} },
		);
		expect(JSON.stringify(result ?? payload).includes("[cleared:")).toBe(false);
	});

	test("micro-gain block rewrite is rejected (cache hysteresis)", async () => {
		// Old user prose that caveman shrinks by only a couple of tokens:
		// rewriting a mid-history block for that costs more in cache misses.
		const payload = {
			// uns compressible bulk so the payload clears the min-cacheable guard
			system: `Context: ${"relevant background material ".repeat(120)}`,
			model: "m",
			messages: [
				{ role: "user", content: "I want to make sure to explain the deployment process due to the fact that it is fragile." },
				{ role: "assistant", content: "Understood." },
				{ role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
			],
		};
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "lite"); // caveman only
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx(),
			{ getConfig: () => config, store, onRun: () => {} },
		);
		expect(result).toBeUndefined();
		const record = store.recent()[0]!;
		expect(record.accepted).toBe(false);
		expect(record.fallbackReason).toBe("gain-below-threshold");
	});

	test("sub-cacheable payload passes through uncompressed (min 512 tokens)", async () => {
		// Genuinely compressible spam, but the whole payload is under the
		// provider's minimum cacheable prefix — compressing it buys nothing.
		const spam = Array.from({ length: 10 }, () => "ok — module suite assertions running\n".repeat(4).trim()).join("\n");
		const payload = {
			model: "m",
			messages: [
				{ role: "user", content: "q1" },
				{ role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: spam }] },
				{ role: "assistant", content: "done" },
				{ role: "user", content: "Summarize." },
			],
		};
		const store = new RunStore(undefined, null);
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx(),
			{ getConfig: () => config, store, onRun: () => {} },
		);
		expect(result).toBeUndefined();
		expect(store.recent()[0]!.fallbackReason).toBe("below-min-cacheable");
	});
});

describe("config", () => {
	test("presets write per-engine flags (runtime truth)", () => {
		// interactive is the cache-hygiene default: lossless + deterministic only
		expect(sanitizeConfig(undefined).strategy).toBe("interactive");
		const interactive = applyStrategyPreset(sanitizeConfig(undefined), "interactive");
		expect(interactive.engines).toEqual({ dedup: false, rtk: false, truncate: true, caveman: false, sessionDedup: true, clear: false });

		const stacked = applyStrategyPreset(sanitizeConfig(undefined), "stacked");
		expect(stacked.engines).toEqual({ dedup: true, rtk: true, truncate: true, caveman: true, sessionDedup: true, clear: false });
		expect(stacked.cavemanIntensity).toBe("full");

		const rtk = applyStrategyPreset(stacked, "rtk");
		expect(rtk.engines).toEqual({ dedup: false, rtk: true, truncate: false, caveman: false, sessionDedup: false, clear: false });

		const omniroute = applyStrategyPreset(rtk, "omniroute");
		expect(omniroute.engines).toEqual({ dedup: false, rtk: false, truncate: true, caveman: false, sessionDedup: true, clear: false });

		const ultra = applyStrategyPreset(omniroute, "ultra");
		expect(ultra.engines.clear).toBe(true); // ultra is the window-pressure preset
		expect(ultra.cavemanIntensity).toBe("ultra");
	});

	test("sanitize clamps and repairs corrupt input", () => {
		const config = sanitizeConfig({ enabled: "yes", costCapUsd: 99, strategy: "bogus", gates: { fidelityGate: false } });
		expect(config.enabled).toBe(false);
		expect(config.costCapUsd).toBe(5);
		expect(config.strategy).toBe("interactive");
		expect(config.gates.fidelityGate).toBe(false);
		expect(config.gates.riskGate).toBe(true);
	});
});
