import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Theme, TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionUiComponent, ExtensionUiComponentFactory } from "@oh-my-pi/pi-tui/chat/extension-types";
import type { StudioConfig } from "./config";
import type { RunRecord, RunStore } from "./live/store";
import { fmtSavings, fmtTokens, renderLine } from "./studio/render-utils";

const WIDGET_KEY = "compress-studio";
const REFRESH_INTERVAL_MS = 1_000;

class CompressWidgetComponent implements ExtensionUiComponent {
	#lines: readonly string[] = [];
	#builtAt = 0;

	constructor(
		private readonly store: RunStore,
		private readonly configProvider: () => StudioConfig,
	) {}

	invalidate(): void {
		this.#builtAt = 0;
	}

	render(width: number): readonly string[] {
		const now = Date.now();
		if (now - this.#builtAt < REFRESH_INTERVAL_MS) return this.#lines;
		this.#builtAt = now;

		const config = this.configProvider();
		const totals = this.store.sessionTotals();
		const lines: string[] = [
			`── compress-studio · ${config.strategy} · ${config.enabled ? "ON" : "OFF"} ──`,
			`saved ${fmtTokens(totals.compressedTokens)} tok (${fmtSavings(totals.savingsPercent)}) · req ${totals.requests}`,
		];
		const last: RunRecord | undefined = totals.lastRun;
		if (last) {
			if (last.accepted) {
				const engines = last.steps.filter((s) => !s.rejected).map((s) => s.engine).join("→");
				lines.push(`last: ${engines || "pass-through"} ${fmtSavings(last.savingsPercent)} · ${Math.round(last.durationMs)}ms`);
			} else {
				lines.push(`last: fallback (${last.fallbackReason ?? "unknown"})`);
			}
		}
		this.#lines = lines.map((line) => renderLine(line, width));
		return this.#lines;
	}
}

/** Installs/removes the below-editor widget and throttles its repaints. */
export class StudioWidget {
	#tui: TUI | undefined;
	#store: RunStore;
	#configProvider: () => StudioConfig;

	constructor(store: RunStore, configProvider: () => StudioConfig) {
		this.#store = store;
		this.#configProvider = configProvider;
	}

	ensureInstalled(ctx: ExtensionContext): void {
		const factory: ExtensionUiComponentFactory = (tui: TUI, _theme: Theme) => {
			this.#tui = tui;
			return new CompressWidgetComponent(this.#store, this.#configProvider);
		};
		ctx.ui.setWidget(WIDGET_KEY, factory, { placement: "belowEditor" });
	}

	remove(ctx: ExtensionContext): void {
		this.#tui = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	/** Called by the capture path after each run; repaints at most 1×/sec. */
	notifyRun(): void {
		const tui = this.#tui;
		if (!tui) return;
		tui.requestRender();
	}
}
