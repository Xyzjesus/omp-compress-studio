/** RiskGate: mask spans engines must not touch; hard-skip doc-level risk categories. */

export interface RiskStats {
	spansProtected: number;
	categories: string[];
}

export interface RiskMaskResult {
	masked: string;
	restore: (text: string) => string;
	stats: RiskStats;
	/** Set when a doc-level category fired and the whole block must skip compression. */
	docLevelReject?: string;
}

interface SpanRule {
	category: string;
	regex: RegExp;
}

const SPAN_RULES: SpanRule[] = [
	{ category: "stack_trace", regex: /^\s+at\s+.+:\d+/gm },
	{ category: "private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
	{
		category: "secret_assignment",
		regex: /^[\w.-]*(?:secret|password|token|api[_-]?key)\w*\s*[:=]\s*\S+$/gim,
	},
];

const DOC_RULES: Array<{ category: string; test: (text: string) => boolean }> = [
	{
		category: "k8s_secret",
		test: (t) => /kind:\s*Secret\b/.test(t) && /\bdata:/.test(t),
	},
	{
		category: "db_migration",
		test: (t) => (t.match(/CREATE TABLE|ALTER TABLE|ADD COLUMN|DROP (?:TABLE|COLUMN)/gi)?.length ?? 0) >= 2,
	},
	{
		category: "legal",
		test: (t) => (t.match(/CONFIDENTIAL|PRIVILEGED AND PROPRIETARY/g)?.length ?? 0) >= 2,
	},
];

const MIN_SIGNALS: Record<string, number> = {
	stack_trace: 2,
	private_key: 1,
	secret_assignment: 2,
};

/**
 * Doc-level categories (k8s Secret manifests, migrations, legal text) reject
 * compression outright; span-level categories are masked for the pipeline and
 * restored afterwards.
 */
export function applyRiskMask(text: string): RiskMaskResult {
	for (const rule of DOC_RULES) {
		if (rule.test(text)) {
			return {
				masked: text,
				restore: (t) => t,
				stats: { spansProtected: 0, categories: [rule.category] },
				docLevelReject: `risk:${rule.category}`,
			};
		}
	}

	const values: string[] = [];
	const categories: string[] = [];
	let masked = text;
	for (const rule of SPAN_RULES) {
		const matches = masked.match(rule.regex) ?? [];
		if (matches.length < (MIN_SIGNALS[rule.category] ?? 1)) continue;
		categories.push(rule.category);
		masked = masked.replace(rule.regex, (match) => {
			const placeholder = `⟦risk_${rule.category}${values.length}⟧`;
			values.push(match);
			return placeholder;
		});
	}

	return {
		masked,
		restore: (t) => t.replace(/⟦risk_([a-z_]+)(\d+)⟧/g, (_ph, _cat: string, idx: string) => values[Number(idx)] ?? _ph),
		stats: { spansProtected: values.length, categories },
	};
}
