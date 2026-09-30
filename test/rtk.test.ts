import { describe, expect, test } from "bun:test";
import { rtkEngine } from "../src/engines/rtk";
import { smartTruncate } from "../src/engines/truncate";

function shellFixture(): string {
	const parts = ["$ bun run build --verbose"];
	// 150 unique lines keep the output above the line cap after dedup
	for (let i = 0; i < 150; i++) {
		parts.push(`Compiling unique_module_${i}.ts with options target=esnext strict`);
	}
	// 30 identical consecutive lines collapse via rtk-dedup
	for (let i = 0; i < 30; i++) {
		parts.push("Reusing cached build artifacts from previous run");
	}
	parts.push("ERROR: module_3.ts:42:7 - TS2345: Argument of type 'string' is not assignable");
	parts.push("Build failed with 1 error");
	return parts.join("\n");
}

describe("rtk engine", () => {
	test("shell output: dedup + truncate fire and shrink", () => {
		const text = shellFixture();
		const step = rtkEngine.apply({ text, role: "tool", isShellTool: true });
		expect(step.rejected).toBeUndefined();
		expect(step.output.length).toBeLessThan(text.length);
		expect(step.techniquesUsed).toContain("rtk-dedup");
		expect(step.techniquesUsed).toContain("rtk-truncate");
		// severity lines survive truncation
		expect(step.output).toContain("ERROR: module_3.ts:42:7");
		expect(step.output).toContain("Build failed with 1 error");
	});

	test("read-only document without command or errors is skipped", () => {
		const text = Array.from({ length: 150 }, (_, i) => `Plain documentation paragraph number ${i} with prose content.`).join("\n");
		const step = rtkEngine.apply({ text, role: "tool" });
		expect(step.rejected).toBe(true);
		expect(step.rejectReason).toBe("document");
		expect(step.output).toBe(text);
	});

	test("no-gain input is rejected", () => {
		const step = rtkEngine.apply({ text: "$ short ok", role: "tool", isShellTool: true });
		expect(step.rejected).toBe(true);
		expect(step.rejectReason).toBe("no-gain");
	});

	test("log-shaped file content gets structural treatment without shell provenance", () => {
		const parts: string[] = [];
		for (let i = 0; i < 150; i++) parts.push(`Compiling unique_module_${i} v1.${i}.3`);
		for (let i = 0; i < 30; i++) parts.push("warning: unused variable `temp_7` in generated handler");
		for (let i = 0; i < 100; i++) parts.push(`2026-09-30T08:${String(i % 60).padStart(2, "0")}:00Z DEBUG http: GET /api/v2/items?page=${i} 200 OK 34ms`);
		parts.push("npm WARN deprecated request@2.88.2: this package is no longer supported");
		const text = parts.join("\n");
		// No shell tool, no `$ ` prompt, no `Error:` — log shape alone must unlock rtk.
		const step = rtkEngine.apply({ text, role: "tool" });
		expect(step.rejected).toBeUndefined();
		expect(step.output.length).toBeLessThan(text.length);
		expect(step.techniquesUsed).toContain("rtk-dedup");
		expect(step.techniquesUsed).toContain("rtk-truncate");
		// severity lines survive truncation
		expect(step.output).toContain("npm WARN deprecated request@2.88.2");
	});
});

describe("smartTruncate", () => {
	test("keeps head, tail, and severity lines under the line cap", () => {
		const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
		lines[150] = "ERROR: something exploded";
		const { text, droppedLines } = smartTruncate(lines.join("\n"));
		const out = text.split("\n");
		expect(out[0]).toBe("line 0");
		expect(out[out.length - 1]).toBe("line 299");
		expect(text).toContain("ERROR: something exploded");
		expect(droppedLines).toBeGreaterThan(0);
		expect(text).toContain("lines truncated");
	});

	test("marker reports the true number of dropped lines", () => {
		const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
		const { text, droppedLines } = smartTruncate(lines.join("\n"));
		const matches = [...text.matchAll(/\[… (\d+) lines truncated …\]/g)];
		expect(matches.length).toBeGreaterThan(0);
		const reported = matches.map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
		expect(reported).toBe(droppedLines);
	});
});
