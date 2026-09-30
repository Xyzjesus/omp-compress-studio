import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
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
	 * In-studio model picker: renders inside the studio overlay and takes keys
	 * through the studio's own input router. Unlike ctx.ui.select it cannot be
	 * starved of focus or hidden under other surfaces.
	 */
	pickModel(options: readonly string[], initialIndex?: number): Promise<string | undefined>;
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

interface ModelPicker {
	options: readonly string[];
	selected: number;
	resolve: (value: string | undefined) => void;
}

/** Root overlay: tab bar + delegation; Tab/Shift+Tab switch tabs, Esc closes. */
export class StudioView implements ExtensionUiComponent {
	#disposed = false;
	#tabIndex = 0;
	#views: Record<TabId, TabView>;
	#picker: ModelPicker | undefined;

	#env: StudioEnv;

	constructor(env: StudioEnv) {
		this.#env = env;
		const play = new PlayView(env, () => {});
		const compare = new CompareView(env);
		const live = new LiveView(env);
		const settings = new SettingsView(env);
		this.#views = { play, compare, live, settings };
	}

	/** Opens the in-studio picker; resolves with the chosen option or undefined. */
	openModelPicker(options: readonly string[], initialIndex = 0): Promise<string | undefined> {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		this.#picker = {
			options,
			selected: Math.max(0, Math.min(initialIndex, options.length - 1)),
			resolve,
		};
		this.#env.tui.requestRender();
		return promise;
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
		if (this.#disposed) return true;
		if (this.#picker) {
			this.#handlePickerInput(data);
			return true;
		}
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

	#handlePickerInput(data: string): void {
		const picker = this.#picker!;
		const key = keyName(data);
		if (key === "up") {
			picker.selected = Math.max(0, picker.selected - 1);
		} else if (key === "down") {
			picker.selected = Math.min(picker.options.length - 1, picker.selected + 1);
		} else if (key === "enter") {
			this.#picker = undefined;
			picker.resolve(picker.options[picker.selected]);
		} else if (key === "escape") {
			this.#picker = undefined;
			picker.resolve(undefined);
		}
		// Everything else is swallowed while the picker is open.
		this.#env.tui.requestRender();
	}

	#renderPicker(width: number): readonly string[] {
		const theme = this.#env.theme;
		const picker = this.#picker!;
		const maxVisible = 15;
		const start = Math.max(0, Math.min(picker.selected - maxVisible + 1, picker.options.length - maxVisible));
		const end = Math.min(picker.options.length, start + maxVisible);
		const lines = [
			renderLine(theme.fg("accent", "Judge model"), width),
			renderLine(theme.fg("dim", "↑/↓ select · enter apply · esc cancel"), width),
		];
		for (let i = start; i < end; i++) {
			const marker = i === picker.selected ? theme.fg("accent", "▶ ") : "  ";
			lines.push(renderLine(`${marker}${picker.options[i]!}`, width));
		}
		lines.push(renderLine(theme.fg("dim", `(${picker.selected + 1}/${picker.options.length})`), width));
		return lines;
	}

	render(width: number): readonly string[] {
		const theme = this.#env.theme;
		const lines: string[] = [];
		if (this.#picker) {
			lines.push(renderLine(`compress-studio${theme.fg("dim", "   Tab: switch · Esc: close")}`, width));
			lines.push(theme.fg("border", "─".repeat(Math.max(10, width))));
			lines.push(...this.#renderPicker(width));
			return lines;
		}
		const tabs = TABS.map((tab, i) =>
			i === this.#tabIndex ? theme.fg("accent", `[ ${tab} ]`) : theme.fg("dim", `  ${tab}  `),
		).join("");
		lines.push(renderLine(`compress-studio  ${tabs}${theme.fg("dim", "   Tab: switch · Esc: close")}`, width));
		lines.push(theme.fg("border", "─".repeat(Math.max(10, width))));
		lines.push(...this.#views[this.#tab].render(width));
		return lines;
	}
}
