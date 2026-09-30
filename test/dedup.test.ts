import { describe, expect, test } from "bun:test";
import { deduplicateBlocks, dedupEngine } from "../src/engines/dedup";

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
});
