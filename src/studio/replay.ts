export type ReplaySpeed = 0.3 | 1 | 3;

const SPEED_STEPS: ReplaySpeed[] = [0.3, 1, 3];
const BASE_TICK_MS = 400;

/**
 * Step-by-step waterfall replay. `frame` counts how many steps are visible.
 * The tick loop pauses when `playing` flips and dies with `dispose()`.
 */
export class ReplayState {
	frame = 0;
	playing = false;
	speed: ReplaySpeed = 1;
	#disposed = false;

	constructor(private readonly onFrame: () => void) {}

	get active(): boolean {
		return this.frame > 0;
	}

	start(maxFrames: number): void {
		this.frame = Math.min(this.frame, maxFrames);
		if (this.playing || maxFrames === 0) return;
		this.playing = true;
		void this.#loop(maxFrames);
	}

	pause(): void {
		this.playing = false;
	}

	toggle(maxFrames: number): void {
		if (this.playing) this.pause();
		else this.start(maxFrames);
	}

	reset(): void {
		this.pause();
		this.frame = 0;
		this.onFrame();
	}

	speedDown(): void {
		const idx = SPEED_STEPS.indexOf(this.speed);
		this.speed = SPEED_STEPS[Math.max(0, idx - 1)]!;
		this.onFrame();
	}

	speedUp(): void {
		const idx = SPEED_STEPS.indexOf(this.speed);
		this.speed = SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, idx + 1)]!;
		this.onFrame();
	}

	#loop(maxFrames: number): Promise<void> {
		return (async () => {
			while (!this.#disposed && this.playing && this.frame < maxFrames) {
				this.frame++;
				this.onFrame();
				await Bun.sleep(BASE_TICK_MS / this.speed);
			}
			this.playing = false;
		})().catch(() => {
			this.playing = false;
		});
	}

	dispose(): void {
		this.#disposed = true;
		this.playing = false;
	}
}
