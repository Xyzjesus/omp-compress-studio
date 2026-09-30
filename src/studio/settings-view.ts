import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Theme, TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionUiComponent } from "@oh-my-pi/pi-tui/chat/extension-types";
import type { CavemanIntensity, Strategy, StudioConfig } from "../config";
import { applyStrategyPreset, STRATEGIES } from "../config";
import { renderLine, keyName } from "./render-utils";

export interface SettingsEnv {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	getConfig(): StudioConfig;
	updateConfig(producer: (config: StudioConfig) => StudioConfig): Promise<void>;
	runDialog<T>(open: () => Promise<T>): Promise<T>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface SettingRow {
	label: string;
	value(): string;
	/** space/enter on this row */
	toggle(): Promise<void> | void;
	/** left/right arrows; dir = -1 | 1 */
	cycle(dir: -1 | 1): Promise<void> | void;
}

const INTENSITIES: CavemanIntensity[] = ["lite", "full", "ultra"];

function strategyNeighbor(current: Strategy, dir: -1 | 1): Strategy {
	const idx = STRATEGIES.indexOf(current);
	return STRATEGIES[(idx + dir + STRATEGIES.length) % STRATEGIES.length]!;
}

/** Config rows; every mutation persists atomically via updateConfig. */
export class SettingsView implements ExtensionUiComponent {
	selected = 0;
	#rows: SettingRow[];

	constructor(private readonly env: SettingsEnv) {
		this.#rows = [
			{
				label: "live compression",
				value: () => (env.getConfig().enabled ? "on" : "off"),
				toggle: () => this.setConfig((c) => ({ ...c, enabled: !c.enabled })),
				cycle: (dir) => this.setConfig((c) => ({ ...c, enabled: dir > 0 })),
			},
			{
				label: "strategy preset",
				value: () => env.getConfig().strategy,
				toggle: async () => {
					// preset row has no boolean; space advances forward
					await this.applyStrategy(strategyNeighbor(env.getConfig().strategy, 1));
				},
				cycle: (dir) => this.applyStrategy(strategyNeighbor(env.getConfig().strategy, dir)),
			},
			...(["dedup", "rtk", "truncate", "caveman"] as const).map((engine) => ({
				label: `engine ${engine}`,
				value: () => (env.getConfig().engines[engine] ? "on" : "off"),
				toggle: () => this.setConfig((c) => ({ ...c, engines: { ...c.engines, [engine]: !c.engines[engine] } })),
				cycle: (dir: -1 | 1) => this.setConfig((c) => ({ ...c, engines: { ...c.engines, [engine]: dir > 0 } })),
			})),
			{
				label: "caveman intensity",
				value: () => env.getConfig().cavemanIntensity,
				toggle: () => this.cycleIntensity(1),
				cycle: (dir) => this.cycleIntensity(dir),
			},
			...([
				["fidelity", "fidelityGate"],
				["fuzzy dedup", "fuzzyDedup"],
				["risk gate", "riskGate"],
				["quantum lock", "quantumLock"],
			] as const).map(([label, gate]) => ({
				label: `gate ${label}`,
				value: () => (env.getConfig().gates[gate] ? "on" : "off"),
				toggle: () => this.setConfig((c) => ({ ...c, gates: { ...c.gates, [gate]: !c.gates[gate] } })),
				cycle: (dir: -1 | 1) => this.setConfig((c) => ({ ...c, gates: { ...c.gates, [gate]: dir > 0 } })),
			})),
			{
				label: "heatmap default",
				value: () => env.getConfig().heatmapDefault,
				toggle: () => this.cycleHeatmap(1),
				cycle: (dir) => this.cycleHeatmap(dir),
			},
			{
				label: "judge cost cap $",
				value: () => String(env.getConfig().costCapUsd),
				toggle: () => this.promptCostCap(),
				cycle: (dir) =>
					this.setConfig((c) => ({
						...c,
						costCapUsd: Math.min(5, Math.max(0.01, Math.round((c.costCapUsd + dir * 0.1) * 100) / 100)),
					})),
			},
			{
				label: "judge model",
				value: () => env.getConfig().judgeModel || "(session model)",
				toggle: () => this.promptJudgeModel(),
				cycle: () => this.promptJudgeModel(),
			},
			{
				label: "debug jsonl",
				value: () => (env.getConfig().debug ? "on" : "off"),
				toggle: () => this.setConfig((c) => ({ ...c, debug: !c.debug })),
				cycle: (dir) => this.setConfig((c) => ({ ...c, debug: dir > 0 })),
			},
		];
	}

	private async setConfig(producer: (config: StudioConfig) => StudioConfig): Promise<void> {
		await this.env.updateConfig(producer);
		this.env.tui.requestRender();
	}

	private async applyStrategy(strategy: Strategy): Promise<void> {
		await this.setConfig((c) => applyStrategyPreset(c, strategy));
	}

	private cycleIntensity(dir: -1 | 1): Promise<void> {
		return this.setConfig((c) => {
			const idx = INTENSITIES.indexOf(c.cavemanIntensity);
			return { ...c, cavemanIntensity: INTENSITIES[(idx + dir + INTENSITIES.length) % INTENSITIES.length]! };
		});
	}

	private cycleHeatmap(dir: -1 | 1): Promise<void> {
		return this.setConfig((c) => ({
			...c,
			heatmapDefault: c.heatmapDefault === "ultra" && dir > 0 ? "universal" : "ultra",
		}));
	}

	private async promptCostCap(): Promise<void> {
		const raw = await this.env.runDialog(() =>
			this.env.ctx.ui.input("Judge cost cap USD (0.01–5)", String(this.env.getConfig().costCapUsd)),
		);
		if (raw === undefined) return;
		const value = Number(raw.trim());
		if (!Number.isFinite(value) || value < 0.01 || value > 5) {
			this.env.notify("cost cap must be between 0.01 and 5", "warning");
			return;
		}
		await this.setConfig((c) => ({ ...c, costCapUsd: value }));
	}

	private async promptJudgeModel(): Promise<void> {
		const models = this.env.ctx.models.list();
		const options = ["(session model)", ...models.map((model) => `${model.provider}/${model.id}`)];
		const selected = await this.env.runDialog(() => this.env.ctx.ui.select("Judge model", options));
		if (selected === undefined) return;
		const spec = selected === "(session model)" ? "" : selected;
		await this.setConfig((c) => ({ ...c, judgeModel: spec }));
	}

	invalidate(): void {}
	dispose(): void {}

	handleInput(data: string): boolean {
		const key = keyName(data);
		const row = this.#rows[this.selected];
		if (key === "up" || key === "down") {
			const delta = key === "up" ? -1 : 1;
			this.selected = Math.max(0, Math.min(this.#rows.length - 1, this.selected + delta));
			this.env.tui.requestRender();
			return true;
		}
		if (!row) return false;
		if (key === "space" || key === "enter") {
			void row.toggle();
			return true;
		}
		if (key === "left" || key === "h") {
			void row.cycle(-1);
			return true;
		}
		if (key === "right" || key === "l") {
			void row.cycle(1);
			return true;
		}
		return false;
	}

	render(width: number): readonly string[] {
		const theme = this.env.theme;
		const lines: string[] = [];
		lines.push(renderLine(theme.fg("dim", "↑/↓ select · space toggle · ←/→ or h/l cycle · changes save instantly"), width));
		for (let i = 0; i < this.#rows.length; i++) {
			const row = this.#rows[i]!;
			const marker = i === this.selected ? theme.fg("accent", "▶ ") : "  ";
			const value = row.value();
			const styled = value === "on" ? theme.fg("success", value) : value.startsWith("(") || value === "off" ? theme.fg("dim", value) : value;
			lines.push(renderLine(`${marker}${row.label.padEnd(20)}${styled}`, width));
		}
		return lines;
	}
}
