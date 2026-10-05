import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { OverlayHandle } from "@oh-my-pi/pi-tui";
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

	let overlayHandle: OverlayHandle | undefined;

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
				else widget.remove(ctx);
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
			pickModel: (options, initialIndex) => {
				if (!component || closed) return Promise.resolve(undefined);
				return component.openModelPicker(options, initialIndex);
			},
			runDialog: (open) => {
				dialogDepth++;
				// Host dialogs (select/input) render in the editor slot, underneath
				// this fullscreen overlay — hide the studio so the dialog is visible
				// and can take focus/keys; restore when the last dialog closes.
				overlayHandle?.setHidden(true);
				tui.requestRender();
				return open().finally(() => {
					dialogDepth--;
					if (dialogDepth === 0) overlayHandle?.setHidden(false);
					tui.requestRender();
				});
			},
			close,
		};
		component = new StudioView(env);
		return component;
	}, {
		overlay: true,
		overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 },
		onHandle: (handle) => {
			overlayHandle = handle;
		},
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
					const strategy: Strategy = enabled && state.config.strategy === "off" ? "interactive" : state.config.strategy;
					state.config = strategy === state.config.strategy
						? { ...state.config, enabled }
						: applyStrategyPreset({ ...state.config, enabled }, strategy);
					try {
						await saveConfig(state.config);
					} catch (err) {
						logger.error("compress-studio: config save failed", { error: String(err) });
						ctx.ui.notify("compress-studio: failed to save config", "error");
						return;
					}
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

	// Cache telemetry: finalized assistant messages carry the provider usage
	// (input/output/cacheRead/cacheWrite). This is what makes compression's
	// cache-invalidation cost visible next to its token savings.
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message?.role === "assistant" && "usage" in message) {
			const usage = message.usage;
			if (usage && typeof usage === "object") {
				store.recordUsage({
					input: typeof usage.input === "number" ? usage.input : 0,
					output: typeof usage.output === "number" ? usage.output : 0,
					cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
					cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
				});
			}
		}
	});

	// Config may already have enabled=true from a previous session — the widget
	// (and live compression) must come up with the session, not after /on.
	pi.on("session_start", (_event, ctx) => {
		if (state.config.enabled) widget.ensureInstalled(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		widget.remove(ctx);
	});
}
