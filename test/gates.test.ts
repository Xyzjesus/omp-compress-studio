import { describe, expect, test } from "bun:test";
import { quantumLock } from "../src/gates/quantum";
import { applyRiskMask } from "../src/gates/risk";
import { diffWords } from "../src/diff";

describe("quantum lock", () => {
	test("uuid is stabilized and restored", () => {
		const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
		const text = `request for ${uuid} failed twice`;
		const lock = quantumLock(text);
		expect(lock.text).toContain("⟦Q0⟧");
		expect(lock.text).not.toContain(uuid);
		expect(lock.stats.fragments).toBe(1);
		expect(lock.restore(lock.text)).toBe(text);
	});

	test("jwt and bearer are locked in fixed order", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		const text = `Bearer ${jwt}`;
		const lock = quantumLock(text);
		expect(lock.stats.fragments).toBe(1); // jwt wins before the bearer rule
		expect(lock.stats.categories.api_key).toBeUndefined();
		expect(lock.restore(lock.text)).toBe(text);
	});

	test("idempotent on already-locked text", () => {
		const locked = "value ⟦QUANTUMLOCK⟧ stays";
		const lock = quantumLock(locked);
		expect(lock.text).toBe(locked);
		expect(lock.stats.fragments).toBe(0);
	});
});

describe("risk gate", () => {
	test("k8s Secret manifest rejects compression at doc level", () => {
		const manifest = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ndata:\n  password: cGFzcw==\n";
		const result = applyRiskMask(manifest);
		expect(result.docLevelReject).toBe("risk:k8s_secret");
	});

	test("stack traces are masked and restored", () => {
		const text = [
			"worker started",
			"    at handler (/app/dist/handler.js:120:19)",
			"    at process (/app/dist/loop.js:44:11)",
			"done",
		].join("\n");
		const result = applyRiskMask(text);
		expect(result.docLevelReject).toBeUndefined();
		expect(result.stats.categories).toContain("stack_trace");
		expect(result.stats.spansProtected).toBe(2);
		expect(result.masked).not.toContain("/app/dist/handler.js");
		expect(result.restore(result.masked)).toBe(text);
	});
});

describe("diff", () => {
	test("small inputs produce segments", () => {
		const diff = diffWords("the quick brown fox jumps", "the brown fox leaps");
		expect(diff.omitted).toBe(false);
		const types = diff.segments.map((s) => s.type);
		expect(types).toContain("removed");
		expect(types).toContain("added");
	});

	test("guard skips multi-60k-token inputs", () => {
		const words = (seed: string) => Array.from({ length: 60_000 }, (_, i) => `${seed}${i}`).join(" ");
		const original = words("a");
		const compressed = words("a").replace("a0 ", "").replace("a59999", "");
		const diff = diffWords(original, compressed);
		expect(diff.omitted).toBe(true);
		expect(diff.segments).toHaveLength(0);
		expect(diff.warning).toContain("too large");
	});
});
