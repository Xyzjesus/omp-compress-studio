import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { dedupSessionBlocks } from "../src/engines/sessionDedup";
import { smartTruncate } from "../src/engines/truncate";
import { handleBeforeProviderRequest } from "../src/live/capture";
import { RunStore } from "../src/live/store";
import { DEFAULT_CONFIG, applyStrategyPreset } from "../src/config";

const MODEL = { id: "test-model", api: "anthropic" } as unknown as Model;

function ctx(): ExtensionContext {
	return { model: MODEL, hasUI: true } as unknown as ExtensionContext;
}

function bigBlock(seed: string, size = 5000): string {
	return Array.from({ length: Math.ceil(size / 80) }, () => `${seed} with some repeated filler content here`).join("\n");
}

describe("session-dedup", () => {
	test("keeps first occurrence verbatim, collapses later identical blocks to markers", () => {
		const text = bigBlock("dup");
		const result = dedupSessionBlocks([
			{ text, isNewestUser: false, isCurrentTurn: false },
			{ text, isNewestUser: false, isCurrentTurn: false },
			{ text, isNewestUser: false, isCurrentTurn: false },
		]);
		expect(result[0]).toBeNull();
		const marker = result[1]!;
		expect(marker).toMatch(/^\[dedup:ref sha=[0-9a-f]{24}\] identical to an earlier block above/);
		expect(result[2]).toBe(marker);
		expect(marker.length).toBeLessThan(200);
	});

	test("newest user and current-turn blocks are never replaced", () => {
		const text = bigBlock("dup");
		const result = dedupSessionBlocks([
			{ text, isNewestUser: false, isCurrentTurn: false },
			{ text, isNewestUser: true, isCurrentTurn: false },
			{ text, isNewestUser: false, isCurrentTurn: true },
		]);
		expect(result).toEqual([null, null, null]);
	});

	test("short or line-poor blocks are ignored", () => {
		const result = dedupSessionBlocks([
			{ text: "tiny", isNewestUser: false, isCurrentTurn: false },
			{ text: "tiny", isNewestUser: false, isCurrentTurn: false },
			{ text: "a\nb", isNewestUser: false, isCurrentTurn: false },
			{ text: "a\nb", isNewestUser: false, isCurrentTurn: false },
		]);
		expect(result).toEqual([null, null, null, null]);
	});
});

describe("semantics-first truncation", () => {
	test("digit-variant log spam collapses to first occurrence + marker", () => {
		const lines = Array.from({ length: 300 }, (_, i) => `   Compiling crate-${String(i).padStart(3, "0")} v1.0.0 platform=x64 wheel=bundled feature-set=full`);
		const text = lines.join("\n");
		const { text: out, droppedLines } = smartTruncate(text);
		expect(droppedLines).toBe(299);
		expect(out).toContain("Compiling crate-000");
		expect(out).not.toContain("crate-299");
		expect(out).toContain("lines truncated");
	});

	test("unique source lines survive even far over the caps", () => {
		const word = (n: number): string => {
			let s = "";
			let v = n;
			do {
				s = String.fromCharCode(97 + (v % 26)) + s;
				v = Math.floor(v / 26) - 1;
			} while (v >= 0);
			return s;
		};
		const lines = Array.from({ length: 300 }, (_, i) => `export function handler${word(i)}(request: Request): Response { return ok; }`);
		const text = lines.join("\n");
		const { text: out, droppedLines } = smartTruncate(text);
		for (const line of lines) expect(out).toContain(line);
		expect(droppedLines).toBe(0);
	});
});

describe("omniroute-parity capture flow", () => {
	async function runPayload() {
		const bigA = bigBlock("alpha", 20000);
		const bigB = bigBlock("bravo", 20000);
		const bigC = bigBlock("charlie", 20000);
		const payload = {
			model: "claude-test",
			max_tokens: 1024,
			system: [{ type: "text", text: "You are a helpful assistant." }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "Read the files, then summarize everything in detail please." }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bigA }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t2", name: "read", input: { path: "a" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: bigA }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t3", name: "read", input: { path: "b" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: bigB }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t4", name: "read", input: { path: "c" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t4", content: bigC }] },
				{ role: "user", content: [{ type: "text", text: "Now summarize all of it with plenty of detail for me please." }] },
			],
		};
		const store = new RunStore();
		const config = applyStrategyPreset({ ...DEFAULT_CONFIG, enabled: true }, "omniroute");
		const result = await handleBeforeProviderRequest(
			{ type: "before_provider_request", payload },
			ctx(),
			{ getConfig: () => config, store, onRun: () => {} },
		);
		return { payload, result, store };
	}

	function messageOf(value: unknown, index: number): string {
		if (!isRecord(value)) throw new Error("not a payload");
		const messages = value.messages as unknown[];
		const message = messages[index] as { content: Array<{ text?: string }> };
		const part = message.content[0] as { text?: string };
		return typeof part?.text === "string" ? part.text : JSON.stringify(message.content);
	}

	test("duplicate collapses, old oversized blocks truncate, current turn stays verbatim", async () => {
		const { payload, result, store } = await runPayload();
		expect(isRecord(result)).toBe(true);

		// duplicate tool result (index 4) → reference marker
		expect(messageOf(result, 4)).toContain("[dedup:ref sha=");
		expect(messageOf(result, 4).length).toBeLessThan(300);

		// old oversized tool results (index 2, 6): repeated filler lines
		// collapse to their first occurrences + a drop marker — semantics kept
		expect(messageOf(result, 2)).toContain("[… ");
		expect(messageOf(result, 2)).toContain("lines truncated …]");
		expect(messageOf(result, 2)).toContain("alpha with some repeated filler content here");
		expect(messageOf(result, 6)).toContain("lines truncated …]");
		expect(messageOf(result, 2).length).toBeLessThan(3200);

		// current-turn tool result (index 8) stays byte-for-byte
		expect(messageOf(result, 8)).toBe(messageOf(payload, 8));

		// newest user message untouched
		expect(messageOf(result, 9)).toBe(messageOf(payload, 9));

		// system untouched
		expect((result as Record<string, unknown>).system).toEqual(payload.system);

		// meaningful savings: ≥20% payload reduction (OmniRoute parity)
		expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(payload).length * 0.8);

		// breakdown records both stages
		const record = store.recent()[0]!;
		const engines = record.steps.map((s) => s.engine);
		expect(engines).toContain("session-dedup");
		expect(engines).toContain("truncate");
		expect(record.accepted).toBe(true);
		expect(record.savingsPercent).toBeGreaterThan(15);
	});
});
