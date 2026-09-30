import { parseKey, replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

/** Tab-expand + width-truncate for any row rendered in the studio. */
export function renderLine(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text), width);
}

/**
 * Protocol-aware key name ("escape", "tab", "ctrl+r", "up", …). Falls back to
 * the raw data so printable characters ("r", "1", "*") pass through whether
 * they arrive plain or via the kitty keyboard protocol.
 */
export function keyName(data: string): string {
	return parseKey(data) ?? data;
}

/** 980 / 12.3k / 3.4M */
export function fmtTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

/** −34.2% (savings sign baked in). */
export function fmtSavings(percent: number): string {
	return `−${percent.toFixed(1)}%`;
}

/** 812 B / 12.3 kB / 3.4 MB */
export function fmtBytes(bytes: number): string {
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
	if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} kB`;
	return `${bytes} B`;
}

/** Block bar: filled ▓ for fraction, light ░ for the remainder. */
export function bar(fraction: number, width: number): string {
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.round(clamped * width);
	return `${"▓".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function padEndVisible(text: string, width: number): string {
	const visible = Bun.stringWidth(text);
	return visible >= width ? text : text + " ".repeat(width - visible);
}
