import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export type Strategy = "off" | "lite" | "standard" | "aggressive" | "ultra" | "rtk" | "stacked" | "omniroute";
export type CavemanIntensity = "lite" | "full" | "ultra";

export interface EngineToggles {
	dedup: boolean;
	rtk: boolean;
	truncate: boolean;
	caveman: boolean;
	/** Lossless content-addressed dedup of repeated blocks (OmniRoute "Standard Savings" stage 1). */
	sessionDedup: boolean;
}

export interface GateToggles {
	fidelityGate: boolean;
	riskGate: boolean;
	quantumLock: boolean;
	fuzzyDedup: boolean;
}

export interface StudioConfig {
	/** Live compression of outgoing provider payloads. Off until the user opts in. */
	enabled: boolean;
	/** Last applied preset. Presets write `engines`/`cavemanIntensity`; runtime truth is those flags. */
	strategy: Strategy;
	/** Per-engine switches — the runtime source of truth for the live pipeline. */
	engines: EngineToggles;
	/** Intensity for the caveman prose engine. */
	cavemanIntensity: CavemanIntensity;
	/** v1: system prompt is never touched. Kept as a field so flipping it later is config-only. */
	preserveSystemPrompt: boolean;
	gates: GateToggles;
	heatmapDefault: "ultra" | "universal";
	/** Judge model spec (`provider/id`). Empty = current session model. */
	judgeModel: string;
	/** Hard cap for judge spend per Compare verify run, USD. */
	costCapUsd: number;
	/** Append full before/after texts of every live run to debug.jsonl. */
	debug: boolean;
}

export const DEFAULT_CONFIG: StudioConfig = {
	enabled: false,
	strategy: "stacked",
	engines: { dedup: true, rtk: true, truncate: true, caveman: true, sessionDedup: true },
	cavemanIntensity: "full",
	preserveSystemPrompt: true,
	gates: { fidelityGate: true, riskGate: true, quantumLock: true, fuzzyDedup: true },
	heatmapDefault: "ultra",
	judgeModel: "",
	costCapUsd: 0.1,
	debug: false,
};

export const STRATEGIES: readonly Strategy[] = [
	"off",
	"lite",
	"standard",
	"aggressive",
	"ultra",
	"rtk",
	"stacked",
	"omniroute",
];

/**
 * Preset expansion: what each strategy writes into `engines`/`cavemanIntensity`.
 * Live capture reads `config.engines`, never this table.
 */
export const STRATEGY_PRESETS: Record<
	Strategy,
	{ engines: EngineToggles; cavemanIntensity: CavemanIntensity }
> = {
	off: { engines: { dedup: false, rtk: false, truncate: false, caveman: false, sessionDedup: false }, cavemanIntensity: "full" },
	lite: { engines: { dedup: false, rtk: false, truncate: false, caveman: true, sessionDedup: false }, cavemanIntensity: "lite" },
	standard: { engines: { dedup: false, rtk: false, truncate: false, caveman: true, sessionDedup: false }, cavemanIntensity: "full" },
	aggressive: { engines: { dedup: false, rtk: true, truncate: false, caveman: true, sessionDedup: false }, cavemanIntensity: "full" },
	ultra: { engines: { dedup: true, rtk: true, truncate: true, caveman: true, sessionDedup: true }, cavemanIntensity: "ultra" },
	rtk: { engines: { dedup: false, rtk: true, truncate: false, caveman: false, sessionDedup: false }, cavemanIntensity: "full" },
	stacked: { engines: { dedup: true, rtk: true, truncate: true, caveman: true, sessionDedup: true }, cavemanIntensity: "full" },
	/** OmniRoute "Standard Savings" parity: session-dedup + lite tool truncation (their default combo). */
	omniroute: { engines: { dedup: false, rtk: false, truncate: true, caveman: false, sessionDedup: true }, cavemanIntensity: "lite" },
};

/** Returns a new config with the preset's engine stack applied (preset only; flags are the runtime truth). The "off" preset also disables live compression. */
export function applyStrategyPreset(config: StudioConfig, strategy: Strategy): StudioConfig {
	const preset = STRATEGY_PRESETS[strategy];
	return {
		...config,
		strategy,
		engines: { ...preset.engines },
		cavemanIntensity: preset.cavemanIntensity,
		...(strategy === "off" ? { enabled: false } : {}),
	};
}

export function configPath(): string {
	return path.join(getAgentDir(), "compress-studio", "config.json");
}

export function runsPath(): string {
	return path.join(getAgentDir(), "compress-studio", "runs.jsonl");
}

export function debugPath(): string {
	return path.join(getAgentDir(), "compress-studio", "debug.jsonl");
}

const INTENSITIES: Record<CavemanIntensity, true> = { lite: true, full: true, ultra: true };

function isCavemanIntensity(value: string): value is CavemanIntensity {
	return value in INTENSITIES;
}

function isHeatmapDefault(value: string): value is "ultra" | "universal" {
	return value === "ultra" || value === "universal";
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

/** Merge a parsed (possibly partial/corrupt) object onto defaults; every field is validated. */
export function sanitizeConfig(raw: unknown): StudioConfig {
	const src = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const engines = typeof src.engines === "object" && src.engines !== null ? (src.engines as Record<string, unknown>) : {};
	const gates = typeof src.gates === "object" && src.gates !== null ? (src.gates as Record<string, unknown>) : {};
	const strategy = str(src.strategy, DEFAULT_CONFIG.strategy);
	const intensity = str(src.cavemanIntensity, DEFAULT_CONFIG.cavemanIntensity);
	const heatmap = str(src.heatmapDefault, DEFAULT_CONFIG.heatmapDefault);
	return {
		enabled: bool(src.enabled, DEFAULT_CONFIG.enabled),
		strategy: strategy in STRATEGY_PRESETS ? (strategy as Strategy) : DEFAULT_CONFIG.strategy,
		engines: {
			dedup: bool(engines.dedup, DEFAULT_CONFIG.engines.dedup),
			rtk: bool(engines.rtk, DEFAULT_CONFIG.engines.rtk),
			truncate: bool(engines.truncate, DEFAULT_CONFIG.engines.truncate),
			caveman: bool(engines.caveman, DEFAULT_CONFIG.engines.caveman),
			sessionDedup: bool(engines.sessionDedup, DEFAULT_CONFIG.engines.sessionDedup),
		},
		cavemanIntensity: isCavemanIntensity(intensity) ? intensity : DEFAULT_CONFIG.cavemanIntensity,
		preserveSystemPrompt: bool(src.preserveSystemPrompt, DEFAULT_CONFIG.preserveSystemPrompt),
		gates: {
			fidelityGate: bool(gates.fidelityGate, DEFAULT_CONFIG.gates.fidelityGate),
			riskGate: bool(gates.riskGate, DEFAULT_CONFIG.gates.riskGate),
			quantumLock: bool(gates.quantumLock, DEFAULT_CONFIG.gates.quantumLock),
			fuzzyDedup: bool(gates.fuzzyDedup, DEFAULT_CONFIG.gates.fuzzyDedup),
		},
		heatmapDefault: isHeatmapDefault(heatmap) ? heatmap : DEFAULT_CONFIG.heatmapDefault,
		judgeModel: str(src.judgeModel, DEFAULT_CONFIG.judgeModel),
		costCapUsd: Math.min(5, Math.max(0.01, num(src.costCapUsd, DEFAULT_CONFIG.costCapUsd))),
		debug: bool(src.debug, DEFAULT_CONFIG.debug),
	};
}

/** Load config; missing/corrupt file yields defaults. */
export async function loadConfig(): Promise<StudioConfig> {
	try {
		const raw = await Bun.file(configPath()).json();
		return sanitizeConfig(raw);
	} catch {
		return { ...DEFAULT_CONFIG, engines: { ...DEFAULT_CONFIG.engines }, gates: { ...DEFAULT_CONFIG.gates } };
	}
}

let saveQueue: Promise<void> = Promise.resolve();
let saveCounter = 0;

/** Atomic save to an explicit path: unique temp sibling + rename. */
export async function saveConfigTo(file: string, config: StudioConfig): Promise<void> {
	const tmp = `${file}.${process.pid}.${++saveCounter}.tmp`;
	await Bun.write(tmp, `${JSON.stringify(config, null, "\t")}\n`);
	await fs.rename(tmp, file);
}

/** Atomic save, serialized so concurrent callers cannot interleave renames. */
export function saveConfig(config: StudioConfig): Promise<void> {
	const run = saveQueue.then(() => saveConfigTo(configPath(), config));
	saveQueue = run.catch(() => {});
	return run;
}
