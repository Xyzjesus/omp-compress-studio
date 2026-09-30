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

describe("smartTruncate (semantics-first)", () => {
	test("repetitive log collapses to first occurrences, severity survives", () => {
		const lines = Array.from({ length: 300 }, () => "   Compiling module_x v1.2.3 with options target=esnext strict=true");
		lines[150] = "ERROR: module_x.ts:42:7 - TS2345: Argument of type 'string' is not assignable";
		lines[299] = "Build failed with 1 error";
		const { text, droppedLines } = smartTruncate(lines.join("\n"));
		expect(droppedLines).toBeGreaterThan(200);
		expect(text).toContain("Compiling module_x v1.2.3 with options target=esnext strict=true");
		expect(text).toContain("ERROR: module_x.ts:42:7");
		expect(text).toContain("Build failed with 1 error");
		expect(text).toContain("lines truncated");
	});

	test("digit-variant lines are repeats, not novel content", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `worker thread ${i} finished job batch ${Math.floor(i / 10)} cleanly`);
		const { text, droppedLines } = smartTruncate(lines.join("\n"));
		expect(droppedLines).toBeGreaterThan(180);
		expect(text).toContain("worker thread 0 finished job batch 0 cleanly");
	});

	test("unique lines are never dropped, even far over the caps", () => {
		const word = (n: number): string => {
			let s = "";
			let v = n;
			do {
				s = String.fromCharCode(97 + (v % 26)) + s;
				v = Math.floor(v / 26) - 1;
			} while (v >= 0);
			return s;
		};
		const lines = Array.from({ length: 300 }, (_, i) => `Scenario ${word(i)} handles workflow phase ${word(i * 3)}: verify contract ${word(i * 7)} for suite`);
		const text = lines.join("\n");
		const { text: out, droppedLines } = smartTruncate(text);
		for (const line of lines) expect(out).toContain(line);
		expect(droppedLines).toBe(0);
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
