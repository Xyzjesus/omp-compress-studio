import { describe, expect, test } from "bun:test";
import { recoveryRecall } from "../src/recovery";
import { criticalNeedles } from "../src/gates/fidelity";

describe("recovery eval", () => {
	test("recall scoring: full, partial, and empty needle sets", () => {
		const needles = ["https://a.example/x", "1.2.3", "src/foo.ts", "MAX_RETRIES"];
		expect(recoveryRecall("https://a.example/x 1.2.3 src/foo.ts MAX_RETRIES", needles))
			.toEqual({ recallPercent: 100, missed: [] });
		const half = recoveryRecall("https://a.example/x MAX_RETRIES", needles);
		expect(half.recallPercent).toBe(50);
		expect(half.missed.sort()).toEqual(["1.2.3", "src/foo.ts"]);
		expect(recoveryRecall("anything", [])).toEqual({ recallPercent: 100, missed: [] });
		expect(recoveryRecall("nothing here", needles).recallPercent).toBe(0);
	});

	test("line-wrapped URLs and reindented needles still count as recovered", () => {
		const needles = ["https://cdn.example.com/releases/app-2.3.1.tar.gz", "deploy(app, region)"];
		const wrapped = [
			"- https://cdn.example.com/releases/ ",
			"  app-2.3.1.tar.gz",
			"- deploy(app,",
			"  region)",
		].join("\n");
		expect(recoveryRecall(wrapped, needles).recallPercent).toBe(100);
		// Negative: whitespace-tolerance must not merge one-line enumerations —
		// "1. 2. 3" is NOT an occurrence of version 1.2.3.
		expect(recoveryRecall("1. 2. 3", ["1.2.3"]).recallPercent).toBe(0);
	});

	test("log-shaped lines are exempt from recovery needles (engines drop them by contract)", () => {
		const text = [
			"deploy finished, see https://mirror.example.internal/artifact.bin",
			...Array.from({ length: 10 }, (_, i) => `2026-09-30T10:0${i}:00Z INFO fetched https://log-noise.example/${i}`),
		].join("\n");
		const needles = criticalNeedles(text);
		expect(needles.some((n) => n.includes("log-noise.example"))).toBe(false);
		expect(needles.some((n) => n.includes("mirror.example.internal"))).toBe(true);
	});

	test("missed list is capped at 5 for diagnostics", () => {
		const needles = Array.from({ length: 9 }, (_, i) => `needle_${i}`);
		expect(recoveryRecall("", needles).missed).toHaveLength(5);
	});
	test("criticalNeedles extracts urls, versions, paths, constants", () => {
		const text = [
			"see https://example.com/docs for release 2.3.1 details",
			"constant MAX_RETRIES in src/config.ts",
		].join("\n");
		const needles = criticalNeedles(text);
		expect(needles).toContain("https://example.com/docs");
		expect(needles).toContain("2.3.1");
		expect(needles).toContain("MAX_RETRIES");
		expect(needles.some((n) => n.includes("config.ts"))).toBe(true);
	});
});
