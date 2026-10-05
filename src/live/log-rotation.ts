import * as fs from "node:fs/promises";

/**
 * Caps an append-only JSONL log by BYTES: when the file grows past
 * `maxBytes`, rewrite it with only the newest whole lines that fit in
 * `keepBytes`. A line-count cap cannot bound size — one multi-MB debug entry
 * × 150 kept lines is how debug.jsonl reached 45MB under a 25MB cap.
 * Fire-and-forget safe: any error (missing file, race with the writer) is
 * swallowed — rotation is best-effort.
 */
export async function rotateLogIfHuge(file: string, maxBytes: number, keepBytes: number): Promise<void> {
	const stat = await fs.stat(file).catch(() => undefined);
	if (!stat || stat.size <= maxBytes) return;
	const content = await Bun.file(file).text();
	const lines = content.split("\n");
	const kept: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (line === "" && i === lines.length - 1) continue; // trailing split artifact
		const cost = Buffer.byteLength(line, "utf8") + 1;
		if (size + cost > keepBytes && kept.length > 0) break;
		size += cost;
		kept.unshift(line);
	}
	await Bun.write(file, kept.length > 0 ? `${kept.join("\n")}\n` : "");
}
