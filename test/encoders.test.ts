import { describe, expect, test } from "bun:test";
import { compareEncoders, encodeGcf, extractCompactableArrays } from "../src/encoders";

function fixtureArray(n: number): Array<Record<string, unknown>> {
	return Array.from({ length: n }, (_, i) => ({
		id: i,
		name: `item-${i}`,
		active: i % 2 === 0,
		score: i * 1.5,
	}));
}

describe("encoders", () => {
	test("extracts inline arrays and json fences", () => {
		const text = `${JSON.stringify(fixtureArray(10))}\n\n\`\`\`json\n${JSON.stringify(fixtureArray(8))}\n\`\`\`\n`;
		const arrays = extractCompactableArrays(text);
		expect(arrays).toHaveLength(2);
		expect(arrays[0]).toHaveLength(10);
	});

	test("short arrays and non-object elements are rejected", () => {
		const text = `${JSON.stringify([1, 2, 3])}\n${JSON.stringify(["a", "b"])}`;
		expect(extractCompactableArrays(text)).toHaveLength(0);
	});

	test("comparison picks a winner and gcf fence parses back", () => {
		const array = fixtureArray(10);
		const text = JSON.stringify(array);
		const comparison = compareEncoders(text);
		expect(comparison.arraysCompared).toBe(1);
		expect(["json", "gcf", "toon"]).toContain(comparison.winner);
		expect(comparison.toonAvailable).toBe(true);

		const gcf = encodeGcf(array);
		expect(gcf.startsWith("```omni-tabular")).toBe(true);
		expect(gcf).toContain("[10 rows]");
		const lines = gcf.split("\n");
		const hints = lines[1]!.split(",");
		const headers = lines[2]!.split(",");
		expect(headers).toEqual(["id", "name", "active", "score"]);
		expect(hints).toEqual(["n", "s", "b", "n"]);
		const rows = lines.slice(3, 3 + 10).map((row) => row.split(","));
		expect(rows).toHaveLength(10);
		expect(rows[5]).toEqual(["5", "item-5", "false", "7.5"]);
	});

	test("text without arrays reports zero comparisons", () => {
		const comparison = compareEncoders("just prose, nothing compactable here");
		expect(comparison.arraysCompared).toBe(0);
		expect(comparison.winner).toBe("json");
	});
});
