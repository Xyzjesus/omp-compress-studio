import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Theme, TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionUiComponent } from "@oh-my-pi/pi-tui/chat/extension-types";
import type { StudioConfig } from "../config";
import { fmtTokens, fmtSavings, keyName, renderLine } from "./render-utils";
import { ReplayState } from "./replay";
import { waterfallLines } from "./waterfall";
import type { RunRecord } from "../live/store";

export interface LiveEnv {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	getConfig(): StudioConfig;
	updateConfig(producer: (config: StudioConfig) => StudioConfig): Promise<void>;
	recentRuns(): readonly RunRecord[];
	refreshWidget(): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Recent live runs with waterfall/replay of the selected run. */
export class LiveView implements ExtensionUiComponent {
	selected = 0;
	readonly replay: ReplayState;

	#env: LiveEnv;

	constructor(env: LiveEnv) {
		this.#env = env;
		this.replay = new ReplayState(() => env.tui.requestRender());
	}

	invalidate(): void {}
	dispose(): void {
		this.replay.dispose();
	}

	handleInput(data: string): boolean {
		const key = keyName(data);
		if (key === "ctrl+e" || key === "o") {
			void this.toggleEnabled();
			return true;
		}
		if (key === "up" || key === "down") {
			const count = this.#env.recentRuns().length;
			if (count > 0) {
				const delta = key === "up" ? -1 : 1;
				this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
				this.replay.reset();
				this.#env.tui.requestRender();
			}
			return true;
		}
		if (key === "space") {
			const run = this.selectedRun();
			if (run) this.replay.toggle(run.steps.length);
			this.#env.tui.requestRender();
			return true;
		}
		if (key === "backspace") {
			this.replay.reset();
			return true;
		}
		if (key === ",") {
			this.replay.speedDown();
			return true;
		}
		if (key === ".") {
			this.replay.speedUp();
			return true;
		}
		return false;
	}

	async toggleEnabled(): Promise<void> {
		const next = !this.#env.getConfig().enabled;
		await this.#env.updateConfig((c) => ({ ...c, enabled: next }));
		this.#env.refreshWidget();
		this.#env.notify(next ? "compress-studio: live compression ON" : "compress-studio: live compression OFF");
		this.#env.tui.requestRender();
	}

	private selectedRun(): RunRecord | undefined {
		const runs = [...this.#env.recentRuns()].reverse();
		return runs[this.selected];
	}

	render(width: number): readonly string[] {
		const theme = this.#env.theme;
		const config = this.#env.getConfig();
		const lines: string[] = [];

		const status = config.enabled ? theme.fg("success", "ON") : theme.fg("dim", "OFF");
		lines.push(
			renderLine(
				`live compression: ${status}${theme.fg("dim", "  (Ctrl+E toggle)")}${theme.fg("dim", `  strategy: ${config.strategy}`)}`,
				width,
			),
		);
		if (!config.enabled) {
			lines.push(theme.fg("dim", "runs appear here only when enabled — /compress-studio on"));
		}

		const runs = [...this.#env.recentRuns()].reverse();
		if (runs.length > 0) {
			lines.push(theme.fg("dim", "── recent runs (↑/↓ select, space replay) ──"));
			for (let i = 0; i < Math.min(runs.length, 8); i++) {
				const run = runs[i]!;
				const time = new Date(run.ts).toLocaleTimeString();
				const outcome = run.accepted
					? theme.fg("success", fmtSavings(run.savingsPercent))
					: theme.fg("dim", `fallback: ${run.fallbackReason ?? "?"}`);
				const marker = i === this.selected ? theme.fg("accent", "▶") : " ";
				lines.push(
					renderLine(
						`${marker} ${time} ${run.model?.padEnd(24) ?? "".padEnd(24)} ${run.strategy.padEnd(9)} ${fmtTokens(run.originalTokens)}→${fmtTokens(run.compressedTokens)} ${outcome}`,
						width,
					),
				);
			}

			const run = this.selectedRun();
			if (run) {
				const visibleSteps = this.replay.active ? Math.max(1, this.replay.frame) : run.steps.length;
				lines.push(
					renderLine(
						theme.fg("dim", `── run detail${this.replay.playing ? theme.fg("accent", " ▶ replay") : ""} ──`),
						width,
					),
				);
				lines.push(...waterfallLines(run.steps, visibleSteps, -1, width, theme));
			}
		}
		return lines;
	}
}
