import type { StepResult } from "./types";
import { cavemanEngine, cavemanLiteEngine } from "./caveman";
import { dedupEngine } from "./dedup";
import { rtkEngine } from "./rtk";
import { truncateEngine } from "./truncate";
import type { CompressionEngine, EngineInput, EngineApplyOptions } from "./types";

/** Lane order = tab order in the studio; caveman runs last (prose over structural). */
export const LIVE_LANES = ["dedup", "rtk", "truncate", "caveman", "lite"] as const;

export type LiveLane = (typeof LIVE_LANES)[number];

export const ENGINE_BY_LANE: Record<LiveLane, CompressionEngine> = {
	dedup: dedupEngine,
	rtk: rtkEngine,
	truncate: truncateEngine,
	caveman: cavemanEngine,
	lite: cavemanLiteEngine,
};

export interface PipelineResult {
	steps: StepResult[];
	output: string;
}

/** Optional per-step postcheck; returns the step (possibly rolled back). */
export type StepPostCheck = (step: StepResult) => StepResult;

/**
 * Cascade: each engine receives the previous engine's output; rejected steps
 * pass the text through unchanged. Gates are the caller's job (capture/studio
 * wrap steps via `postCheck`), except per-engine options passed through.
 */
export function runPipeline(
	text: string,
	role: EngineInput["role"],
	lanes: readonly LiveLane[],
	opts?: EngineApplyOptions & {
		isShellTool?: boolean;
		postCheck?: StepPostCheck;
	},
): PipelineResult {
	const steps: StepResult[] = [];
	let current = text;
	for (const lane of lanes) {
		const engine = ENGINE_BY_LANE[lane];
		if (!engine) continue;
		let step = engine.apply({ text: current, role, isShellTool: opts?.isShellTool }, {
			cavemanIntensity: opts?.cavemanIntensity,
			model: opts?.model,
		});
		if (opts?.postCheck) step = opts.postCheck(step);
		steps.push(step);
		if (!step.rejected && step.output !== current) {
			current = step.output;
		}
	}
	return { steps, output: current };
}
