/** QuantumLock: stabilize high-entropy tokens so engines cannot mangle them. */

interface QuantumPattern {
	category: string;
	regex: RegExp;
}

/** Fixed evaluation order: jwt before bearer, ids before hex, hex before ts. */
const PATTERNS: QuantumPattern[] = [
	{
		category: "jwt",
		regex: /\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}(?![A-Za-z0-9_-])/g,
	},
	{ category: "api_key", regex: /\b(?:sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,200}\b/g },
	{ category: "api_key", regex: /\bBearer[ \t]{1,4}[A-Za-z0-9._-]{16,400}\b/g },
	{
		category: "uuid",
		regex: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
	},
	{ category: "request_id", regex: /\b(?:req|trace|span|corr|request)[-_:][A-Za-z0-9]{6,128}\b/g },
	{ category: "long_hex", regex: /\b[0-9a-f]{16,128}\b/g },
	{ category: "unix_ts", regex: /\b1[0-9]{9}(?:[0-9]{3})?\b/g },
];

export interface QuantumStats {
	fragments: number;
	categories: Record<string, number>;
}

export interface QuantumLock {
	text: string;
	restore: (text: string) => string;
	stats: QuantumStats;
}

const PLACEHOLDER_RE = /⟦Q(\d+)⟧/g;

/** Replace every recognized high-entropy token with a ⟦Q<i>⟧ placeholder. */
export function quantumLock(text: string): QuantumLock {
	const values: string[] = [];
	const categories: Record<string, number> = {};
	let locked = text;
	for (const { category, regex } of PATTERNS) {
		locked = locked.replace(regex, (match) => {
			const placeholder = `⟦Q${values.length}⟧`;
			values.push(match);
			categories[category] = (categories[category] ?? 0) + 1;
			return placeholder;
		});
	}
	return {
		text: locked,
		restore: (t) => t.replace(PLACEHOLDER_RE, (_ph: string, idx: string) => values[Number(idx)] ?? _ph),
		stats: { fragments: values.length, categories },
	};
}
