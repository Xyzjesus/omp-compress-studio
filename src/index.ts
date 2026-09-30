import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import { applyStrategyPreset, loadConfig, saveConfig, type Strategy, type StudioConfig } from "./config";
import { handleBeforeProviderRequest } from "./live/capture";
import { RunStore } from "./live/store";
import type { StudioEnv } from "./studio/studio-view";
import { StudioView } from "./studio/studio-view";
import { fmtTokens, fmtSavings } from "./studio/render-utils";
import { StudioWidget } from "./widget";

const ARGUMENTS = ["on", "off", "status"] as const;

async function openStudio(ctx: ExtensionCommandContext, state: { config: StudioConfig }, store: RunStore, widget: StudioWidget): Promise<void> {
	let sharedText = "";
	let component: StudioView | undefined;
	let closed = false;
	let dialogDepth = 0;

	// Fullscreen-modal input router: deliver keystrokes to the studio no matter
	// which component holds TUI focus (async editor rebuilds steal focus from
	// overlays, which used to leave the studio key-dead). Context dialogs
	// (select/input opened via runDialog) pass through untouched.
	const removeInputRouter = ctx.ui.onTerminalInput((data) => {
		if (closed || !component || dialogDepth > 0) return undefined;
		component.handleInput(data);
		return { consume: true };
	});

	await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
		const close = () => {
			if (closed) return;
			closed = true;
			removeInputRouter();
			done(undefined);
		};
		const env: StudioEnv = {
			ctx,
			tui,
			theme,
			keybindings,
			store,
			getConfig: () => state.config,
			updateConfig: async (producer) => {
				state.config = producer(state.config);
				try {
					await saveConfig(state.config);
				} catch (err) {
					logger.error("compress-studio: config save failed", { error: String(err) });
					ctx.ui.notify("compress-studio: failed to save config", "error");
					return;
				}
				if (state.config.enabled) widget.ensureInstalled(ctx);
			},
			setSharedText: (text) => {
				sharedText = text;
			},
			getSharedText: () => sharedText,
			recentRuns: () => store.recent(),
			refreshWidget: () => {
				if (state.config.enabled) widget.ensureInstalled(ctx);
				else widget.remove(ctx);
			},
			notify: (message, type) => ctx.ui.notify(message, type),
			runDialog: (open) => {
				dialogDepth++;
				return open().finally(() => {
					dialogDepth--;
				});
			},
			close,
		};
		component = new StudioView(env);
		return component;
	}, {
		overlay: true,
		overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 },
	});
	closed = true;
	removeInputRouter();
}

export default async function compressStudio(pi: ExtensionAPI): Promise<void> {
	const state = { config: await loadConfig() };
	const store = new RunStore(logger);
	const widget = new StudioWidget(store, () => state.config);

	pi.registerCommand("compress-studio", {
		description: "Compression studio: test engines, compare, live runs, settings",
		getArgumentCompletions: (prefix) =>
			ARGUMENTS.filter((arg) => arg.startsWith(prefix)).map((arg) => ({ value: arg, label: arg })),
		handler: async (args, ctx) => {
			const arg = args.trim().split(/\s+/)[0] ?? "";
			if (arg === "on" || arg === "off") {
				const enabled = arg === "on";
				if (state.config.enabled !== enabled) {
					const strategy: Strategy = enabled && state.config.strategy === "off" ? "stacked" : state.config.strategy;
					state.config = strategy === state.config.strategy
						? { ...state.config, enabled }
						: applyStrategyPreset({ ...state.config, enabled }, strategy);
					await saveConfig(state.config);
				}
				if (enabled) widget.ensureInstalled(ctx);
				else widget.remove(ctx);
				ctx.ui.notify(`compress-studio: live compression ${arg}`);
				return;
			}
			if (arg === "status") {
				const totals = store.sessionTotals();
				ctx.ui.notify(
					`compress-studio: ${state.config.enabled ? "ON" : "OFF"} · ${state.config.strategy} · ` +
						`saved ${fmtTokens(totals.compressedTokens)} tok (${fmtSavings(totals.savingsPercent)}) over ${totals.accepted}/${totals.requests} runs`,
				);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("compress-studio studio needs an interactive session", "warning");
				return;
			}
			await openStudio(ctx, state, store, widget);
		},
	});

	pi.on("before_provider_request", (event, ctx) =>
		handleBeforeProviderRequest(event, ctx, {
			getConfig: () => state.config,
			store,
			onRun: () => widget.notifyRun(),
		}),
	);

	// Config may already have enabled=true from a previous session — the widget
	// (and live compression) must come up with the session, not after /on.
	pi.on("session_start", (_event, ctx) => {
		if (state.config.enabled) widget.ensureInstalled(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		widget.remove(ctx);
	});
}
