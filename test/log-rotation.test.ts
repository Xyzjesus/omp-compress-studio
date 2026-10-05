import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { rotateLogIfHuge } from "../src/live/log-rotation";

function lineFor(i: number): string {
	return JSON.stringify({ i, pad: "x".repeat(1000) });
}

describe("log rotation", () => {
	test("byte cap keeps only the newest lines that fit keepBytes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compress-rot-"));
		try {
			const file = path.join(dir, "log.jsonl");
			const lines = Array.from({ length: 50 }, (_, i) => lineFor(i));
			await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8"); // ~50KB

			await rotateLogIfHuge(file, 10_000, 5_000);

			const after = await fs.readFile(file, "utf8");
			const stat = await fs.stat(file);
			expect(stat.size).toBeGreaterThan(0);
			expect(stat.size).toBeLessThanOrEqual(5_100); // keepBytes + trailing newline slack
			expect(after.endsWith("\n")).toBe(true); // stays line-delimited JSONL
			const kept = after.trim().split("\n").map((l) => JSON.parse(l) as { i: number });
			expect(kept[kept.length - 1]!.i).toBe(49); // newest line survives
			expect(kept[0]!.i).toBeGreaterThan(0); // oldest lines dropped
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("file under maxBytes is untouched", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compress-rot-"));
		try {
			const file = path.join(dir, "log.jsonl");
			const original = `${lineFor(1)}\n${lineFor(2)}\n`;
			await fs.writeFile(file, original, "utf8");

			await rotateLogIfHuge(file, 1_000_000, 500_000);

			expect(await fs.readFile(file, "utf8")).toBe(original);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
