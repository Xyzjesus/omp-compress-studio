import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Editor, getEditorTheme, type Theme, type TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionUiComponent } from "@oh-my-pi/pi-tui/chat/extension-types";
import { extractPreservedBlocks, diffWords } from "../diff";
import type { StudioConfig } from "../config";
import { compareEncoders, type EncoderComparison } from "../encoders";
import { ENGINE_BY_LANE, LIVE_LANES, runPipeline, type LiveLane, type PipelineResult } from "../engines/pipeline";
import type { StepResult } from "../engines/types";
import { buildHeatmap, type HeatmapMode, type HeatmapToken } from "../heatmap";
import { fidelityCheck } from "../gates/fidelity";
import { countText } from "../tokens";
import { fmtTokens, keyName, renderLine } from "./render-utils";
import { ReplayState } from "./replay";
import { diffLines, heatmapLines, stepToRow, waterfallLines } from "./waterfall";

const MAX_EDITOR_ROWS = 14;
const DIFF_MAX_ROWS = 8;

export interface PlayRunResult {
	text: string;
	originalTokens: number;
	perLane: Record<LiveLane, StepResult>;
	combined: PipelineResult;
	diff: ReturnType<typeof diffWords>;
	heatmap: HeatmapToken[];
	encoders: EncoderComparison;
	preserved: ReturnType<typeof extractPreservedBlocks>;
	durationMs: number;
}

export interface PlayEnv {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	getConfig(): StudioConfig;
	updateConfig(producer: (config: StudioConfig) => StudioConfig): Promise<void>;
	setSharedText(text: string): void;
}

/** Dry-run playground: engines on pasted text, waterfall, diff, heatmap, encoders. */
export class PlayView implements ExtensionUiComponent {
	readonly editor = new Editor(getEditorTheme());
	focus: "editor" | "controls" = "controls";
	enabledLanes: Record<LiveLane, boolean>;
	heatMode: HeatmapMode;
	result: PlayRunResult | undefined;
	selectedStep = 0;
	runError: string | undefined;
	readonly replay: ReplayState;

	constructor(
		private readonly env: PlayEnv,
		private readonly onFocusedEditorChange: (editorFocused: boolean) => void,
	) {
		const config = env.getConfig();
		this.enabledLanes = {
			dedup: config.engines.dedup,
			rtk: config.engines.rtk,
			truncate: config.engines.truncate,
			caveman: config.engines.caveman,
			lite: false,
		};
		this.heatMode = config.heatmapDefault;
		this.editor.setMaxHeight(MAX_EDITOR_ROWS);
		this.replay = new ReplayState(() => env.tui.requestRender());
	}

	invalidate(): void {}
	dispose(): void {
		this.replay.dispose();
	}

	render(width: number): readonly string[] {
		const theme = this.env.theme;
		const lines: string[] = [];

		const focusHint =
			this.focus === "editor"
				? theme.fg("accent", "✎ editor") + theme.fg("dim", "  (Esc/Ctrl+E: controls)")
				: theme.fg("accent", "⚙ controls") + theme.fg("dim", "  (e: edit text · Esc: close)");
		lines.push(renderLine(focusHint, width));

		if (this.focus === "editor") {
			lines.push(...this.editor.render(width));
		} else {
			const text = this.editor.getText();
			const preview = text.replace(/\s+/g, " ").slice(0, Math.max(0, width - 4));
			lines.push(theme.fg("dim", renderLine(preview.length > 0 ? `  ${preview}` : "  <empty>", width)));
		}

		lines.push(
			renderLine(
				LIVE_LANES.map((lane, i) => {
					const on = this.enabledLanes[lane];
					const marker = on ? theme.fg("success", "●") : theme.fg("dim", "○");
					return `${marker}${theme.fg(on ? "text" : "dim", ` ${i + 1} ${lane}`)}`;
				}).join(theme.fg("dim", "  ")) + theme.fg("dim", "   [* all/none]"),
				width,
			),
		);
		lines.push(
			renderLine(
				`${this.toggleLabel("f", this.env.getConfig().gates.fidelityGate)}fidelity  ` +
					`${this.toggleLabel("d", this.env.getConfig().gates.fuzzyDedup)}fuzzy-dedup  ` +
					`${this.toggleLabel("g", this.env.getConfig().gates.riskGate)}risk  ` +
					`${this.toggleLabel("l", this.env.getConfig().gates.quantumLock)}quantum  ` +
					`m heatmap:${this.heatMode}`,
				width,
			),
		);
		lines.push(
			renderLine(
				theme.fg(
					"dim",
					"Ctrl+R/r run · ↑/↓ step · space replay · Backspace reset · ,/. speed · Tab next tab",
				),
				width,
			),
		);

		const result = this.result;
		if (this.runError) lines.push(theme.fg("warning", `⚠ ${this.runError}`));
		if (!result) {
			lines.push(theme.fg("dim", "paste text, then Ctrl+R"));
			return lines;
		}

		const combined = result.combined;
		const outTokens = combined.output.length === result.text.length
			? result.originalTokens
			: combined.steps[combined.steps.length - 1]?.compressedTokens ?? result.originalTokens;
		const savings = result.originalTokens > 0
			? Math.max(0, ((result.originalTokens - outTokens) / result.originalTokens) * 100)
			: 0;
		lines.push(
			renderLine(
				`combined: ${fmtTokens(result.originalTokens)} → ${fmtTokens(outTokens)} tok (${savings.toFixed(1)}%) · ${Math.round(result.durationMs)}ms` +
					(this.replay.playing ? theme.fg("accent", "  ▶ replay") : this.replay.active ? theme.fg("success", "  ✓ replay done") : ""),
				width,
			),
		);

		const visibleSteps = Math.max(1, this.replay.frame) || combined.steps.length;
		lines.push(...waterfallLines(combined.steps.map(stepToRow), visibleSteps, this.selectedStep, width, theme));

		const selected = combined.steps[this.selectedStep];
		if (selected && selected.output !== selected.input) {
			const stepDiff = diffWords(selected.input, selected.output, {
				originalTokens: selected.originalTokens,
				compressedTokens: selected.compressedTokens,
			});
			lines.push(theme.fg("dim", "── diff (selected step) ──"));
			lines.push(...diffLines(stepDiff, DIFF_MAX_ROWS, width, theme));
		}

		if (result.encoders.arraysCompared > 0) {
			const enc = result.encoders;
			lines.push(
				renderLine(
					`encoders (${enc.arraysCompared} arrays): json ${enc.json.tokens}t · gcf ${enc.gcf.tokens}t` +
						(enc.toon ? ` · toon ${enc.toon.tokens}t` : "") +
						theme.fg("success", `  winner: ${enc.winner}`),
					width,
				),
			);
		}
		if (result.preserved.length > 0) {
			lines.push(
				renderLine(
					theme.fg("dim", `preserved: ${result.preserved.map((b) => `${b.kind}: ${b.preview}`).join(" · ").slice(0, width - 12)}`),
					width,
				),
			);
		}
		if (this.heatMode !== "off" && result.heatmap.length > 0) {
			lines.push(...heatmapLines(result.heatmap, 30, width, theme));
		}
		return lines;
	}

	private toggleLabel(key: string, on: boolean): string {
		return on ? `[x] ${key} ` : `[ ] ${key} `;
	}

	handleInput(data: string): boolean {
		const key = keyName(data);
		if (this.focus === "editor") {
			if (key === "escape" || key === "ctrl+e") {
				this.focus = "controls";
				this.onFocusedEditorChange(false);
				this.env.tui.requestRender();
				return true;
			}
			if (key === "ctrl+r") {
				this.run();
				return true;
			}
			this.editor.handleInput(data);
			this.env.tui.requestRender();
			return true;
		}

		// controls focus
		if (key === "ctrl+r" || key === "r") {
			this.run();
			return true;
		}
		if (key === "e" || key === "ctrl+e") {
			this.focus = "editor";
			this.onFocusedEditorChange(true);
			this.env.tui.requestRender();
			return true;
		}
		const laneIndex = "12345".indexOf(key);
		if (laneIndex !== -1) {
			this.toggleLane(LIVE_LANES[laneIndex]!);
			return true;
		}
		if (key === "*") {
			const anyOff = LIVE_LANES.some((lane) => !this.enabledLanes[lane]);
			for (const lane of LIVE_LANES) this.enabledLanes[lane] = anyOff;
			this.persistLanes();
			this.env.tui.requestRender();
			return true;
		}
		const config = this.env.getConfig();
		const gateKeys: Record<string, "fidelityGate" | "fuzzyDedup" | "riskGate" | "quantumLock"> = {
			f: "fidelityGate",
			d: "fuzzyDedup",
			g: "riskGate",
			l: "quantumLock",
		};
		const gateKey = gateKeys[key];
		if (gateKey) {
			void this.env.updateConfig((c) => ({ ...c, gates: { ...c.gates, [gateKey]: !c.gates[gateKey] } }));
			return true;
		}
		if (key === "m") {
			const order: HeatmapMode[] = ["off", "ultra", "universal"];
			this.heatMode = order[(order.indexOf(this.heatMode) + 1) % order.length]!;
			this.env.tui.requestRender();
			return true;
		}
		if (key === "up" || key === "down") {
			const delta = key === "up" ? -1 : 1;
			const max = this.result ? this.result.combined.steps.length - 1 : 0;
			this.selectedStep = Math.max(0, Math.min(max, this.selectedStep + delta));
			this.env.tui.requestRender();
			return true;
		}
		if (key === "space") {
			if (this.result) this.replay.toggle(this.result.combined.steps.length);
			this.env.tui.requestRender();
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
		void config;
		return false;
	}

	private toggleLane(lane: LiveLane): void {
		this.enabledLanes[lane] = !this.enabledLanes[lane];
		this.persistLanes();
		this.env.tui.requestRender();
	}

	private persistLanes(): void {
		void this.env.updateConfig((c) => ({
			...c,
			engines: {
				dedup: this.enabledLanes.dedup,
				rtk: this.enabledLanes.rtk,
				truncate: this.enabledLanes.truncate,
				caveman: this.enabledLanes.caveman,
			},
		}));
	}

	/** Buffer text with paste atoms expanded to their real content. */
	playText(): string {
		let text = this.editor.getText();
		for (const [label, expansion] of this.editor.atoms) {
			text = text.replaceAll(label, expansion);
		}
		return text;
	}

	run(): void {
		const text = this.playText();
		if (text.trim().length === 0) {
			this.runError = "no input text";
			this.env.tui.requestRender();
			return;
		}
		this.runError = undefined;
		const model = this.env.ctx.model;
		const started = performance.now();
		const config = this.env.getConfig();

		const perLane = {} as Record<LiveLane, StepResult>;
		for (const lane of LIVE_LANES) {
			perLane[lane] = ENGINE_BY_LANE[lane].apply({ text, role: "tool" }, { model });
		}
		const lanes = LIVE_LANES.filter((lane) => this.enabledLanes[lane]);
		const combined = runPipeline(text, "tool", lanes, {
			model,
			postCheck: config.gates.fidelityGate ? (step) => fidelityCheck(step).step : undefined,
		});
		const originalTokens = combined.steps[0]?.originalTokens ?? perLane.dedup.originalTokens;
		const outputTokens = combined.output === text ? originalTokens : countText(combined.output, model);
		const diff = diffWords(text, combined.output, { originalTokens, compressedTokens: outputTokens });
		const heatmap = this.heatMode === "off" ? [] : buildHeatmap(text, diff, this.heatMode);
		this.result = {
			text,
			originalTokens,
			perLane,
			combined,
			diff,
			heatmap,
			encoders: compareEncoders(text, model),
			preserved: extractPreservedBlocks(text),
			durationMs: performance.now() - started,
		};
		this.selectedStep = 0;
		this.replay.reset();
		this.env.setSharedText(text);
		this.env.tui.requestRender();
	}
}
