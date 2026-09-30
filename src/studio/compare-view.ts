import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Theme, TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionUiComponent } from "@oh-my-pi/pi-tui/chat/extension-types";
import type { StudioConfig } from "../config";
import { LIVE_LANES, ENGINE_BY_LANE, type LiveLane } from "../engines/pipeline";
import type { StepResult } from "../engines/types";
import type { JudgeBatchResult, JudgeResult } from "../judge";
import { judgeFidelityBatch } from "../judge";
import { fmtTokens, fmtSavings, keyName, renderLine } from "./render-utils";
import { stepToRow, waterfallLines } from "./waterfall";

export interface CompareEnv {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	getConfig(): StudioConfig;
	updateConfig(producer: (config: StudioConfig) => StudioConfig): Promise<void>;
	runDialog<T>(open: () => Promise<T>): Promise<T>;
	getSharedText(): string;
}

interface CompareRow {
	lane: LiveLane;
	step: StepResult;
	verdict?: JudgeResult;
}

/** A/B all lanes on the shared Play text; optional LLM-judge fidelity pass. */
export class CompareView implements ExtensionUiComponent {
	rows: CompareRow[] | undefined;
	verifyState: "idle" | "running" | "done" = "idle";
	verify: JudgeBatchResult | undefined;
	verifyError: string | undefined;
	notice: string | undefined;

	#env: CompareEnv;

	constructor(env: CompareEnv) {
		this.#env = env;
	}

	invalidate(): void {}
	dispose(): void {}

	handleInput(data: string): boolean {
		const key = keyName(data);
		if (key === "ctrl+r" || key === "r") {
			this.run();
			return true;
		}
		if (key === "ctrl+v" || key === "v") {
			void this.verify_();
			return true;
		}
		if (key === "ctrl+m" || key === "m") {
			void this.promptJudgeModel();
			return true;
		}
		return false;
	}

	run(): void {
		const text = this.#env.getSharedText();
		if (text.trim().length === 0) {
			this.notice = "no shared text — paste text in Play first";
			this.#env.tui.requestRender();
			return;
		}
		this.notice = undefined;
		const model = this.#env.ctx.model;
		this.rows = LIVE_LANES.map((lane) => ({
			lane,
			step: ENGINE_BY_LANE[lane].apply({ text, role: "tool" }, { model }),
		})).sort((a, b) => b.step.savingsPercent - a.step.savingsPercent || b.step.compressedTokens - a.step.compressedTokens);
		this.verifyState = "idle";
		this.verify = undefined;
		this.#env.tui.requestRender();
	}

	async verify_(): Promise<void> {
		if (this.verifyState === "running") return;
		if (!this.rows) {
			this.notice = "run first (Ctrl+R)";
			this.#env.tui.requestRender();
			return;
		}
		const text = this.#env.getSharedText();
		const pairs = this.rows
			.filter((row) => !row.step.rejected && row.step.output !== text)
			.map((row) => ({ id: row.lane, original: text, compressed: row.step.output }));
		if (pairs.length === 0) {
			this.notice = "no compressed outputs to verify";
			this.#env.tui.requestRender();
			return;
		}
		this.verifyState = "running";
		this.verifyError = undefined;
		this.#env.tui.requestRender();
		try {
			const batch = await judgeFidelityBatch(pairs, this.#env.ctx, this.#env.getConfig());
			this.verify = batch;
			this.verifyState = "done";
			for (const result of batch.results) {
				const row = this.rows.find((r) => r.lane === result.id);
				if (row) row.verdict = result;
			}
		} catch (err) {
			this.verifyError = err instanceof Error ? err.message : String(err);
			this.verifyState = "idle";
		}
		this.#env.tui.requestRender();
	}

	async promptJudgeModel(): Promise<void> {
		const models = this.#env.ctx.models.list();
		const options = ["(session model)", ...models.map((model) => `${model.provider}/${model.id}`)];
		const selected = await this.#env.runDialog(() => this.#env.ctx.ui.select("Judge model", options));
		if (selected === undefined) return;
		const spec = selected === "(session model)" ? "" : selected;
		await this.#env.updateConfig((c) => ({ ...c, judgeModel: spec }));
		this.notice = spec.length > 0 ? `judge model: ${spec}` : "judge model: session model";
		this.#env.tui.requestRender();
	}

	render(width: number): readonly string[] {
		const theme = this.#env.theme;
		const lines: string[] = [];
		lines.push(
			renderLine(
				theme.fg("dim", "Ctrl+R/r run all engines · Ctrl+V/v verify (LLM judge) · Ctrl+M/m judge model (pick from session models)"),
				width,
			),
		);
		const judgeModel = this.#env.getConfig().judgeModel || `${this.#env.ctx.model?.id ?? "(none)"} (session)`;
		lines.push(renderLine(theme.fg("dim", `judge: ${judgeModel} · cap $${this.#env.getConfig().costCapUsd}`), width));

		if (this.notice) lines.push(theme.fg("warning", `⚠ ${this.notice}`));
		if (this.verifyError) lines.push(theme.fg("error", `✗ ${this.verifyError}`));
		if (!this.rows) {
			lines.push(theme.fg("dim", "Ctrl+R to compare all engines"));
			return lines;
		}

		lines.push(renderLine(
			`${"engine".padEnd(10)}${"−savings".padStart(9)}${"retention".padStart(10)}${"out tok".padStart(9)}  verdict`,
			width,
		));
		for (const row of this.rows) {
			const retention = row.step.originalTokens > 0
				? (row.step.compressedTokens / row.step.originalTokens) * 100
				: 100;
			let verdictCell = theme.fg("dim", "—");
			if (row.verdict?.verdict === "same") verdictCell = theme.fg("success", "SAME");
			else if (row.verdict?.verdict === "materially-differs") verdictCell = theme.fg("error", "MATERIALLY_DIFFERS");
			else if (row.verdict?.skippedCapped) verdictCell = theme.fg("dim", "—(cap)");
			else if (row.verdict?.verdict === "unparseable") verdictCell = theme.fg("warning", "unparseable");
			else if (row.step.rejected) verdictCell = theme.fg("dim", `[${row.step.rejectReason}]`);
			const line =
				`${row.lane.padEnd(10)}` +
				theme.fg(row.step.savingsPercent > 0 ? "success" : "dim", fmtSavings(row.step.savingsPercent).padStart(9)) +
				`${(retention.toFixed(1) + "%").padStart(10)}` +
				fmtTokens(row.step.compressedTokens).padStart(9) +
				"  " +
				verdictCell;
			lines.push(renderLine(line, width));
		}

		if (this.verifyState === "running") lines.push(theme.fg("accent", "verifying…"));
		if (this.verify) {
			const spent = `spent $${this.verify.totalUsd.toFixed(4)} of $${this.#env.getConfig().costCapUsd}` +
				(this.verify.capped ? theme.fg("warning", "  [capped]") : "");
			lines.push(renderLine(spent, width));
		}

		const top = this.rows[0];
		if (top && top.step.output !== this.#env.getSharedText()) {
			lines.push(theme.fg("dim", `best: ${top.lane}`));
			lines.push(...waterfallLines([stepToRow(top.step)], 1, 0, width, theme));
		}
		return lines;
	}
}
