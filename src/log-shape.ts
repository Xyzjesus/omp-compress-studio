/**
 * Log-shape detection: build/diagnostic/log output has recognizable line
 * shapes — timestamps, severity tokens, compiler diagnostics, progress
 * counters. File content read into a tool block is often such a log; two
 * consumers key off it:
 *
 * - rtk treats log-shaped text as command output (structural stages run even
 *   when the block did not come from a shell tool);
 * - the fidelity gate exempts needles whose every occurrence sits on a
 *   log-shaped line — log noise is compressible by contract, so head/tail
 *   truncation may drop it without rollback.
 */

/** `cat -n`-style line-number prefixes stripped before shape tests. */
const LINE_NUMBER_PREFIX_RE = /^\s*\d+\t/;

const LOG_LINE_RES: RegExp[] = [
	// ISO timestamp prefix: `2026-09-30T08:01:00Z`, `[2026-09-30 08:01:00]`
	/^\s*\[?\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?\]?/,
	// Severity-token prefix: `INFO …`, `[warn] …`, `error: …`
	/^\s*[\[(]?(?:debug|trace|verbose|info|warn(?:ing)?|error|fatal|notice)\b[\]):]?\s/i,
	// Tool-prefixed severity: `npm WARN deprecated …`, `make ERROR …`
	/^\s*\w[\w./+-]*\s+(?:debug|trace|verbose|info|warn(?:ing)?|error|fatal|notice)\b[\]):]?\s/i,
	// Compiler diagnostic labels: `warning: unused …`, `error[E0308]: …`, `note: …`, `help: …`
	/^\s*(?:warning|error|note|help)(?:\[[A-Z\d]+\])?\s*:/i,
	// rustc source locations and diagnostic gutters
	/^\s*-->\s/,
	/^\s*\|\s?/,
	// rustc footnote labels: `= note: …`, `= help: …`
	/^\s*=\s(?:note|help)\s*:/,
	// Progress counters: `[12/40] Building …`
	/^\s*\[\d+(?:\/\d+)?\]\s/,
	// Build-tool verb lines: `Compiling crate-x v1.2.3`
	/^\s*(?:Compiling|Building|Linking|Packing|Running)\s/,
];

export function isLogLine(line: string): boolean {
	const stripped = line.replace(LINE_NUMBER_PREFIX_RE, "");
	return LOG_LINE_RES.some((re) => re.test(stripped));
}

const MIN_LOG_LINES = 8;
const MIN_LOG_RATIO = 0.6;

/** True when non-empty lines are dominated (≥60%) by log-shaped lines. */
export function isLogShaped(text: string): boolean {
	const lines = text.split("\n");
	let nonEmpty = 0;
	let logLines = 0;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		nonEmpty++;
		if (isLogLine(line)) logLines++;
	}
	return nonEmpty >= MIN_LOG_LINES && logLines / nonEmpty >= MIN_LOG_RATIO;
}
