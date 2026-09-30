import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyStrategyPreset, sanitizeConfig, saveConfigTo } from "../src/config";

describe("config persistence", () => {
	test("concurrent atomic saves all land and leave no temp files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cs-test-"));
		const file = path.join(dir, "config.json");
		const runs = Array.from({ length: 20 }, (_, i) =>
			saveConfigTo(file, applyStrategyPreset(sanitizeConfig(undefined), i % 2 === 0 ? "ultra" : "rtk")),
		);
		await Promise.all(runs);
		const saved = await loadConfigFrom(file);
		// final state is one of the two valid presets, and the file parses
		expect(["ultra", "rtk"]).toContain(saved.strategy);
		const entries = await fs.readdir(dir);
		expect(entries.filter((name) => name.includes(".tmp"))).toHaveLength(0);
		await fs.rm(dir, { recursive: true, force: true });
	});
});

async function loadConfigFrom(file: string) {
	try {
		return sanitizeConfig(await Bun.file(file).json());
	} catch {
		throw new Error(`config at ${file} unreadable after concurrent saves`);
	}
}
