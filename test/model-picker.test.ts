import { describe, expect, test } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { StudioEnv } from "../src/studio/studio-view";
import { StudioView } from "../src/studio/studio-view";

function stubStudio(): StudioView {
	const env: StudioEnv = {
		ctx: {} as StudioEnv["ctx"],
		tui: { requestRender() {} } as TUI,
		theme: { fg: (_role: string, text: string) => text } as unknown as StudioEnv["theme"],
		keybindings: {} as StudioEnv["keybindings"],
		store: { recent: () => [] } as unknown as StudioEnv["store"],
		getConfig: () =>
			({
				enabled: true,
				strategy: "lite",
				engines: { dedup: false, rtk: true, truncate: false, caveman: true, sessionDedup: false, clear: false },
				cavemanIntensity: "lite",
				gates: { fidelityGate: true, riskGate: false, quantumLock: true, fuzzyDedup: true },
				heatmapDefault: "ultra",
				judgeModel: "",
				costCapUsd: 0.1,
				debug: false,
				clearTriggerTokens: 100_000,
				clearKeep: 3,
			}) as StudioEnv["getConfig"] extends () => infer C ? C : never,
		updateConfig: async () => {},
		setSharedText() {},
		getSharedText: () => "",
		recentRuns: () => [],
		refreshWidget() {},
		notify() {},
		pickModel: () => Promise.resolve(undefined),
		runDialog: (open) => open(),
		close() {},
	};
	return new StudioView(env);
}

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	esc: "\x1b",
};

function render(studio: StudioView): string {
	return studio.render(120).join("\n");
}

describe("in-studio model picker", () => {
	test("arrows move selection and enter resolves the highlighted option", async () => {
		const studio = stubStudio();
		const promise = studio.openModelPicker(["alpha", "beta", "gamma"]);
		expect(render(studio)).toContain("Judge model");
		studio.handleInput(KEYS.down);
		expect(render(studio)).toContain("▶ beta");
		studio.handleInput(KEYS.enter);
		expect(await promise).toBe("beta");
		expect(render(studio)).not.toContain("Judge model");
	});

	test("esc resolves undefined and restores the tab bar", async () => {
		const studio = stubStudio();
		const promise = studio.openModelPicker(["alpha", "beta"]);
		expect(render(studio)).not.toContain("[ play ]");
		studio.handleInput(KEYS.esc);
		expect(await promise).toBeUndefined();
		expect(render(studio)).toContain("[ play ]");
	});

	test("initial index clamps into range and up stops at the top", () => {
		const studio = stubStudio();
		studio.openModelPicker(["alpha", "beta"], 99);
		expect(render(studio)).toContain("▶ beta");
		studio.handleInput(KEYS.up);
		expect(render(studio)).toContain("▶ alpha");
		studio.handleInput(KEYS.up);
		expect(render(studio)).toContain("▶ alpha");
	});

	test("other keys are swallowed while the picker is open", async () => {
		const studio = stubStudio();
		const promise = studio.openModelPicker(["alpha", "beta"]);
		studio.handleInput("q");
		studio.handleInput(KEYS.down);
		studio.handleInput(KEYS.enter);
		expect(await promise).toBe("beta");
	});

	test("long lists scroll the window around the selection", () => {
		const studio = stubStudio();
		const options = Array.from({ length: 31 }, (_, i) => `model-${i}`);
		studio.openModelPicker(options, 0);
		let out = render(studio);
		expect(out).toContain("▶ model-0");
		expect(out).toContain("(1/31)");
		expect(out).not.toContain("model-30");
		studio.handleInput(KEYS.down);
		out = render(studio);
		expect(out).toContain("▶ model-1");
	});
});
