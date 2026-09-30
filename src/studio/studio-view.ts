import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import type { KeybindingsManager, Theme, TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionUiComponent } from "@oh-my-pi/pi-tui/chat/extension-types";
import type { StudioConfig } from "../config";
import type { RunRecord, RunStore } from "../live/store";
import { keyName, renderLine } from "./render-utils";
import { CompareView } from "./compare-view";
import { LiveView } from "./live-view";
import { PlayView } from "./play-view";
import { SettingsView } from "./settings-view";

const TABS = ["play", "compare", "live", "settings"] as const;
type TabId = (typeof TABS)[number];

export interface StudioEnv {
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	store: RunStore;
	getConfig(): StudioConfig;
	/** Mutate + atomically persist + refresh the widget. */
	updateConfig(producer: (config: StudioConfig) => StudioConfig): Promise<void>;
	setSharedText(text: string): void;
	getSharedText(): string;
	recentRuns(): readonly RunRecord[];
	refreshWidget(): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/**
	 * Runs a ctx.ui dialog (select/input) while telling the modal input router
	 * to let keystrokes through to the dialog instead of the studio.
	 */
	runDialog<T>(open: () => Promise<T>): Promise<T>;
	close(): void;
}

interface TabView extends ExtensionUiComponent {
	handleInput(data: string): boolean;
}

/** Root overlay: tab bar + delegation; Tab/Shift+Tab switch tabs, Esc closes. */
export class StudioView implements ExtensionUiComponent {
	#disposed = false;
	#tabIndex = 0;
	#views: Record<TabId, TabView>;

	#env: StudioEnv;

	constructor(env: StudioEnv) {
		this.#env = env;
		const play = new PlayView(env, () => {});
		const compare = new CompareView(env);
		const live = new LiveView(env);
		const settings = new SettingsView(env);
		this.#views = { play, compare, live, settings };
	}

	get #tab(): TabId {
		return TABS[this.#tabIndex]!;
	}

	invalidate(): void {}

	#syncSharedText(): void {
		this.#env.setSharedText((this.#views.play as PlayView).playText());
	}

	dispose(): void {
		this.#disposed = true;
		this.#syncSharedText();
		for (const view of Object.values(this.#views)) view.dispose?.();
	}

	handleInput(data: string): boolean {
		fs.appendFileSync("/tmp/studio-keys.log", `StudioView data=${JSON.stringify(data)} tab=${this.#tab}\n`);
		if (this.#disposed) return true;
		const key = keyName(data);
		if (key === "tab" || key === "shift+tab") {
			const dir = key === "tab" ? 1 : TABS.length - 1;
			this.#syncSharedText();
			this.#tabIndex = (this.#tabIndex + dir) % TABS.length;
			this.#env.tui.requestRender();
			return true;
		}
		const view = this.#views[this.#tab];
		const handled = view.handleInput(data) === true;
		if (!handled && key === "escape") {
			this.#env.close();
			return true;
		}
		this.#env.tui.requestRender();
		return true;
	}

	render(width: number): readonly string[] {
		const theme = this.#env.theme;
		const lines: string[] = [];
		const tabs = TABS.map((tab, i) =>
			i === this.#tabIndex ? theme.fg("accent", `[ ${tab} ]`) : theme.fg("dim", `  ${tab}  `),
		).join("");
		lines.push(renderLine(`compress-studio  ${tabs}${theme.fg("dim", "   Tab: switch · Esc: close")}`, width));
		lines.push(theme.fg("border", "─".repeat(Math.max(10, width))));
		lines.push(...this.#views[this.#tab].render(width));
		return lines;
	}
}
