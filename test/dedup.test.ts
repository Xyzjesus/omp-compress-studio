import { describe, expect, test } from "bun:test";
import { deduplicateBlocks, dedupEngine } from "../src/engines/dedup";
import { fidelityCheck } from "../src/gates/fidelity";

describe("dedup", () => {
	test("fuzzy=false keeps exact dedup, drops fuzzy-only duplicates", () => {
		// exact duplicate after normalization (case + whitespace differ)
		const exactDup = `${"A".repeat(100)}\n\n${"a".repeat(100)}`;
		expect(deduplicateBlocks(exactDup, false).removed).toBe(1);

		// fuzzy-only duplicate: near-identical, not an exact normalized match
		const base = `${"word ".repeat(40)}alpha beta gamma delta`;
		const nearMiss = `${"word ".repeat(40)}alpha beta gamma epsilon`;
		const fuzzyOnly = `${base}\n\n${nearMiss}`;
		expect(deduplicateBlocks(fuzzyOnly, true).removed).toBe(1);
		expect(deduplicateBlocks(fuzzyOnly, false).removed).toBe(0);
	});

	test("engine honors the fuzzy flag from engine options", () => {
		const base = `${"word ".repeat(40)}alpha beta gamma delta`;
		const nearMiss = `${base}\n\n${base.replace("delta", "epsilon")}`;
		const fuzzyStep = dedupEngine.apply({ text: nearMiss, role: "tool" }, { fuzzy: true });
		const exactStep = dedupEngine.apply({ text: nearMiss, role: "tool" }, { fuzzy: false });
		expect(fuzzyStep.output.length).toBeLessThan(nearMiss.length);
		expect(exactStep.output).toBe(nearMiss);
	});
	test("elided duplicates leave a readable marker", () => {
		const base = `${"word ".repeat(40)}alpha beta gamma delta`;
		const { text, removed } = deduplicateBlocks(`${base}\n\n${base}\n\n${base}`, false);
		expect(removed).toBe(2);
		expect(text).toContain("[… two duplicate blocks elided …]");
		expect(text).not.toMatch(/\[… \d+ duplicate block/); // counts are worded, never digits
		expect(text.indexOf(base)).toBeGreaterThan(-1); // first copy survives verbatim
	});

	test("numerically-distinct fuzzy duplicates pass via repeat-exempt, not marker digits", () => {
		// Reviewer's masking scenario: near-duplicate blocks differing only by a
		// number. The dropped digit is exempt (normalized-repeat line — a digit
		// difference collapses to the same canonical identity), so the step is
		// accepted on that contract; worded marker counts are defense-in-depth,
		// NOT the mechanism that lets this pass. Do not reopen as a bug.
		const text = [
			`${"filler ".repeat(30)}batch 9 done`,
			`${"filler ".repeat(30)}batch 2 done`,
			`${"filler ".repeat(30)}batch 2 done`,
		].join("\n\n");
		const step = dedupEngine.apply({ text, role: "tool" });
		expect(step.output).not.toContain("batch 2");
		expect(step.output).not.toMatch(/\[… \d+ duplicate block/);
		const verdict = fidelityCheck(step);
		expect(verdict.ok).toBe(true); // exempt by contract, not masked by a digit
	});

	test("singular elision marker reads 'one duplicate block'", () => {
		const base = `${"word ".repeat(40)}alpha beta gamma delta`;
		const { text } = deduplicateBlocks(`${base}\n\n${base}`, false);
		expect(text).toContain("[… one duplicate block elided …]");
	});
});
