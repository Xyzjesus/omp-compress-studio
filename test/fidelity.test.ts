import { describe, expect, test } from "bun:test";
import { fidelityCheck } from "../src/gates/fidelity";
import { rtkEngine } from "../src/engines/rtk";
import type { StepResult } from "../src/engines/types";

function stepOf(input: string, output: string): StepResult {
	return {
		engine: "test",
		input,
		output,
		originalTokens: 10,
		compressedTokens: 8,
		savingsPercent: 20,
		techniquesUsed: ["test"],
		rulesApplied: [],
		durationMs: 1,
	};
}

describe("fidelity gate", () => {
	test("missing number rolls the step back with fidelity:numeric", () => {
		const verdict = fidelityCheck(stepOf(
			"processed 91337 items in batch 42 with retries 3 across regions eu-west us-east",
			"processed items in batch across regions eu-west us-east",
		));
		expect(verdict.ok).toBe(false);
		expect(verdict.step.output).toBe(verdict.step.input);
		expect(verdict.step.rejected).toBe(true);
		expect(verdict.step.rejectReason).toBe("fidelity:numeric(91337)");
		expect(verdict.reason).toContain("fidelity:numeric(91337)");
	});

	test("surviving numbers pass", () => {
		const verdict = fidelityCheck(stepOf(
			"processed 91337 items in batch 42 with retries 3",
			"processed 91337 items batch 42 retries 3",
		));
		expect(verdict.ok).toBe(true);
		expect(verdict.step.rejected).toBeUndefined();
	});

	test("dropping critical identifiers fails the critical survival ratio", () => {
		const verdict = fidelityCheck(stepOf(
			"set baseURL to https://api.example.com/v2 and export API_KEY_VALUE before running",
			"set baseURL to and export before running",
		));
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("fidelity:critical");
	});

	test("unchanged output passes trivially", () => {
		const text = "nothing changed here 12345";
		const verdict = fidelityCheck(stepOf(text, text));
		expect(verdict.ok).toBe(true);
	});

	test("needles occurring only on log-shaped lines are exempt", () => {
		const input = Array.from(
			{ length: 60 },
			(_, i) => `2026-09-30T08:${String(i % 60).padStart(2, "0")}:00Z DEBUG http: GET /items?page=${i} pkg v1.0.${i} build 91337`,
		).join("\n");
		const output = `${input.split("\n").slice(0, 4).join("\n")}\n[… 56 lines truncated …]`;
		const verdict = fidelityCheck(stepOf(input, output));
		expect(verdict.ok).toBe(true);
		expect(verdict.step.rejected).toBeUndefined();
	});

	test("version needle on a code line still guards next to log lines", () => {
		const input = [
			'const REQUIRED_MIN = "2.14.7";',
			...Array.from({ length: 40 }, (_, i) => `2026-09-30T08:${String(i % 60).padStart(2, "0")}:00Z DEBUG worker tick ${i} latency 12ms`),
		].join("\n");
		const output = input.split("\n").slice(1).join("\n"); // code line truncated away
		const verdict = fidelityCheck(stepOf(input, output));
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("fidelity:critical(version:");
	});

	test("rtk truncation of log output survives the fidelity gate", () => {
		const parts: string[] = [];
		for (let i = 0; i < 150; i++) parts.push(`Compiling crate_${i} v1.${i}.3 unique-target`);
		for (let i = 0; i < 200; i++) {
			parts.push(`warning: unused variable \`temp_${i}\``);
			parts.push(`  --> src/module_${i % 40}/handler.rs:${100 + i}:13`);
			parts.push("   = note: `#[warn(unused_variables)]` on by default");
		}
		const text = parts.join("\n");
		const step = rtkEngine.apply({ text, role: "tool" });
		expect(step.rejected).toBeUndefined();
		const verdict = fidelityCheck(step);
		expect(verdict.ok).toBe(true);
		expect(step.compressedTokens).toBeLessThan(step.originalTokens);
	});
});
