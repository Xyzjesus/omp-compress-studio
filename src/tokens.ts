import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";

export type TokenizerModel = Pick<Model, "id" | "tokenizer"> | null | undefined;

const MAX_CACHED_COUNTERS = 32;
const counters = new Map<string, Tokenizer>();

/** Cached Tokenizer per model id (null model = byte-estimate fallback counter). */
export function getTokenCounter(model?: TokenizerModel): Tokenizer {
	const key = model?.id ?? "";
	let counter = counters.get(key);
	if (!counter) {
		counter = new Tokenizer(model ?? null);
		counters.set(key, counter);
		if (counters.size > MAX_CACHED_COUNTERS) {
			const oldest = counters.keys().next().value;
			if (oldest !== undefined) counters.delete(oldest);
		}
	}
	return counter;
}

/** Native omp token count for a text under the target model's tokenizer. */
export function countText(text: string, model?: TokenizerModel): number {
	return getTokenCounter(model).countTokens(text);
}
