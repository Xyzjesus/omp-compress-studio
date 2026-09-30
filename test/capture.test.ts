import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { handleBeforeProviderRequest, type DebugRunEntry } from "../src/live/capture";
import { RunStore } from "../src/live/store";
import { DEFAULT_CONFIG, applyStrategyPreset, sanitizeConfig } from "../src/config";

const MODEL = { id: "test-model", api: "anthropic" } as unknown as Model;

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
			{ role: "user", content: [{ type: "text", text: "And what is 2+2?" }] },
		],
	};
}

describe("capture", () => {
	test("compresses tool_result, preserves newest user byte-for-byte, records a run", async () => {
		const payload = syntheticPayload();
		const store = new RunStore();
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
		expect(messages[3]).toEqual(payloadMessages[3]);
		// tool_result message actually shrank
		expect(JSON.stringify(messages[2]).length).toBeLessThan(JSON.stringify(payloadMessages[2]).length);

		// run recorded with a non-empty breakdown
		expect(store.recent()).toHaveLength(1);
		const record = store.recent()[0]!;
		expect(record.accepted).toBe(true);
		expect(record.steps.length).toBeGreaterThan(0);
		expect(record.savingsPercent).toBeGreaterThan(0);
		expect(record.api).toBe("anthropic");
	});

	test("debug flag writes per-block input/output texts", async () => {
		const payload = syntheticPayload();
		const store = new RunStore();
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
				{ role: "user", content: [{ type: "text", text: "Summarize the earlier test run and tell me what to fix first, please provide a lot of detail about it." }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "bash", input: { command: "shot" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: [
					{ type: "text", text: "ok — running suite module.test.ts with several assertions in short order\n".repeat(100) + "ERROR: x.ts:1 — boom" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
				] }] },
				{ role: "user", content: [{ type: "text", text: "And what is 2+2?" }] },
			],
		};
		const store = new RunStore();
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			fakeCtx(),
			{ getConfig: () => config, store, onRun: () => {} },
		);
		const messages = messagesOf(result);
		expect(messages[2]).toEqual(payload.messages[2]);
	});

	test("openai-completions payload round-trips with old user prose compressed", async () => {
		const payload = {
			model: "gpt-test",
			messages: [
				{ role: "user", content: "First turn: hi there, I want to make sure to explain the deployment process due to the fact that it is a bit fragile." },
				{ role: "assistant", content: "Sure." },
				{ role: "user", content: "And what is 2+2?" },
			],
		};
		const store = new RunStore();
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "stacked");
		const ctx = fakeCtx({ id: "m", api: "openai-completions" } as unknown as Model);
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			ctx,
			{ getConfig: () => config, store, onRun: () => {} },
		);
		const messages = messagesOf(result);
		expect(messages[2]).toEqual(payload.messages[2]); // newest untouched
		expect(JSON.stringify(messages[0]).length).toBeLessThan(JSON.stringify(payload.messages[0]).length);
	});

	test("openai-responses payload round-trips and compresses old user text", async () => {
		const payload = {
			model: "gpt-test",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "First turn: hi there, I want to make sure to explain the deployment process due to the fact that it is a bit fragile." }] },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "And what is 2+2?" }] },
			],
		};
		const store = new RunStore();
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
		const store = new RunStore();
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
		const store = new RunStore();
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

describe("config", () => {
	test("presets write per-engine flags (runtime truth)", () => {
		const stacked = applyStrategyPreset(sanitizeConfig(undefined), "stacked");
		expect(stacked.engines).toEqual({ dedup: true, rtk: true, truncate: true, caveman: true });
		expect(stacked.cavemanIntensity).toBe("full");

		const rtk = applyStrategyPreset(stacked, "rtk");
		expect(rtk.engines).toEqual({ dedup: false, rtk: true, truncate: false, caveman: false });

		const ultra = applyStrategyPreset(rtk, "ultra");
		expect(ultra.cavemanIntensity).toBe("ultra");
	});

	test("sanitize clamps and repairs corrupt input", () => {
		const config = sanitizeConfig({ enabled: "yes", costCapUsd: 99, strategy: "bogus", gates: { fidelityGate: false } });
		expect(config.enabled).toBe(false);
		expect(config.costCapUsd).toBe(5);
		expect(config.strategy).toBe("stacked");
		expect(config.gates.fidelityGate).toBe(false);
		expect(config.gates.riskGate).toBe(true);
	});
});
