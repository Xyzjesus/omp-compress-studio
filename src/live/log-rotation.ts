import * as fs from "node:fs/promises";

/**
 * Caps an append-only JSONL log: when the file grows past `maxBytes`, rewrite
 * it with only the newest `keepLines` lines. Fire-and-forget safe: any error
 * (missing file, race with the writer) is swallowed — rotation is best-effort.
 */
export async function rotateLogIfHuge(file: string, maxBytes: number, keepLines: number): Promise<void> {
	const stat = await fs.stat(file).catch(() => undefined);
	if (!stat || stat.size <= maxBytes) return;
	const content = await Bun.file(file).text();
	const lines = content.split("\n");
	// keepLines entries + the trailing empty element produced by the final "\n".
	const keep = lines.slice(-(keepLines + 1)).join("\n");
	await Bun.write(file, keep.endsWith("\n") ? keep : `${keep}\n`);
}
