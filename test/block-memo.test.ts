import { describe, expect, test } from "bun:test";
import { BlockMemo, blockMemo } from "../src/live/block-memo";
import type { StepResult } from "../src/engines/types";

function step(input: string, output: string): StepResult {
	return {
		engine: "test", input, output,
		originalTokens: 1, compressedTokens: 1, savingsPercent: 0,
		techniquesUsed: [], rulesApplied: [], durationMs: 0,
	};
}

describe("block memo", () => {
	test("null entries round-trip (no-gain cached), entries returned verbatim", () => {
		const memo = new BlockMemo();
		const kNull = memo.key(["no-gain"]);
		memo.set(kNull, null);
		expect(memo.get(kNull)).toBeNull();

		const entry = { text: "compressed", steps: [], rawSteps: [step("in", "compressed")] };
		const kEntry = memo.key(["gain"]);
		memo.set(kEntry, entry);
		expect(memo.get(kEntry)).toBe(entry);
	});

	test("evicts oldest entries beyond the char budget", () => {
		const memo = new BlockMemo(100, 1000);
		const big = "x".repeat(400);
		memo.set(memo.key(["a"]), { text: big, steps: [], rawSteps: [step(big, "y")] }); // ~800 chars
		memo.set(memo.key(["b"]), { text: big, steps: [], rawSteps: [step(big, "y")] }); // pushes past 1000
		expect(memo.get(memo.key(["a"]))).toBeUndefined(); // evicted
		expect(memo.get(memo.key(["b"]))).not.toBeNull();
	});

	test("singleton resets cleanly for tests", () => {
		blockMemo.reset();
		blockMemo.set(blockMemo.key(["x"]), null);
		expect(blockMemo.stats.entries).toBe(1);
		blockMemo.reset();
		expect(blockMemo.stats).toEqual({ entries: 0, bytes: 0, hits: 0, misses: 0 });
	});
});
