import { describe, expect, test } from "bun:test";
import { applyCaveman } from "../src/engines/caveman";

describe("caveman engine", () => {
	test("rules fire on prose while fenced code stays intact", () => {
		const code = "```js\nconst retries = 3;\nfunction connect(url) {\n  return fetch(url, { retries });\n}\n```";
		const text = `Hi there, I want to make sure to configure the service due to the fact that the default is a bit fragile.\n\n${code}\n\nVery long documentation follows here.`;
		const step = applyCaveman({ text, role: "user" }, { cavemanIntensity: "full" });
		expect(step.rejected).toBeUndefined();
		// articles runs before qualifier_removal, so "a bit" becomes "bit" first
		expect(step.rulesApplied).toContain("redundant_phrasing");
		expect(step.rulesApplied).toContain("articles");
		expect(step.rulesApplied).toContain("redundant_openers");
		expect(step.output).toContain("ensure ");
		expect(step.output).toContain("because ");
		expect(step.output).toContain(code);
		expect(step.output).not.toContain("make sure to");
	});

	test("protected structure skips rule phase", () => {
		const text = "See the docs at section 1.2 and call connect() to apply the settings now please.";
		const step = applyCaveman({ text, role: "user" }, { cavemanIntensity: "full" });
		expect(step.rejected).toBe(true);
		expect(step.rejectReason).toBe("no-gain");
		expect(step.output).toBe(text);
	});

	test("short input is skipped", () => {
		const step = applyCaveman({ text: "just a short line", role: "user" });
		expect(step.rejected).toBe(true);
		expect(step.rejectReason).toBe("too-short");
	});

	test("code-dominant text is skipped", () => {
		const text = [
			"function alpha() {",
			"    const beta = 1;",
			"    return beta;",
			"}",
			"function gamma() {",
			"    return alpha();",
			"}",
		].join("\n");
		const step = applyCaveman({ text, role: "user" });
		expect(step.rejected).toBe(true);
		expect(step.rejectReason).toBe("code-dominant");
	});

	test("ultra intensity adds cleanup artifacts", () => {
		const text = "I need to explain this very clearly, and also fix each and every single issue quickly now.";
		const full = applyCaveman({ text, role: "user" }, { cavemanIntensity: "full" });
		const ultra = applyCaveman({ text, role: "user" }, { cavemanIntensity: "ultra" });
		expect(full.rulesApplied).toContain("redundant_quantifiers");
		expect(ultra.output.length).toBeLessThanOrEqual(full.output.length);
		expect(ultra.output).toContain("each");
	});
});

describe("caveman ru", () => {
	test("mixed text with cyrillic majority never applies en rules", () => {
		const text = "Спасибо, что помог. Я бы хотел very slowly реализовать подход, make sure to не сломать кейс.";
		const step = applyCaveman({ text, role: "user" }, { cavemanIntensity: "full" });
		expect(step.rulesApplied).not.toContain("articles");
		expect(step.rulesApplied).not.toContain("redundant_phrasing");
		expect(step.rulesApplied).not.toContain("emphasis_removal");
		expect(step.rulesApplied).not.toContain("pleasantries");
		expect(step.rulesApplied).toContain("ru_pleasantries");
		expect(step.output).toContain("very slowly");
		expect(step.output).toContain("make sure to");
	});

	test("manual ru rules compress greeting, emphasis, qualifiers, parentheticals", () => {
		const text = "Привет! Конечно, очень важно проверить это. Кроме того, как бы сказать, что всё работает.";
		const step = applyCaveman({ text, role: "user" }, { cavemanIntensity: "full" });
		expect(step.rulesApplied).toContain("ru_redundant_openers");
		expect(step.rulesApplied).toContain("ru_emphasis");
		expect(step.rulesApplied).toContain("ru_qualifiers");
		expect(step.output).toBe("Важно проверить это. Сказать, что всё работает.");
		expect(step.output).not.toMatch(/,,|\s,/);
	});

	test("framed hedging removal absorbs comma frame", () => {
		const text = "Сборка, возможно, займёт дополнительное время, прежде чем всё завершится.";
		const step = applyCaveman({ text, role: "user" }, { cavemanIntensity: "full" });
		expect(step.rulesApplied).toContain("ru_hedging");
		expect(step.output).toBe("Сборка займёт дополнительное время, прежде чем всё завершится.");
	});

	test("ru pipeline is idempotent", () => {
		const text = "Привет! Конечно, очень важно проверить это. Кроме того, как бы сказать, что всё работает.";
		const once = applyCaveman({ text, role: "user" }, { cavemanIntensity: "full" }).output;
		const twice = applyCaveman({ text: once, role: "user" }, { cavemanIntensity: "full" }).output;
		expect(twice).toBe(once);
	});

	test("protected spans gate skips ru rule phase entirely", () => {
		const text = "См. src/engines/caveman.ts, версия 1.2.3. Очень важно.";
		const step = applyCaveman({ text, role: "user" }, { cavemanIntensity: "full" });
		expect(step.rejected).toBe(true);
		expect(step.rejectReason).toBe("no-gain");
		expect(step.output).toBe(text);
	});

	test("word-form classes fire wf_hedges and wf_determiners", () => {
		// «очевидно» is wordform-only (manual ru_hedging doesn't list it) so ru_wf_hedges must be the firing rule.
		const text = "Этот файл, очевидно, довольно большой для сборки и требует проверки.";
		const step = applyCaveman({ text, role: "user" }, { cavemanIntensity: "full" });
		expect(step.rulesApplied).toContain("ru_wf_hedges");
		expect(step.rulesApplied).toContain("ru_wf_determiners");
		expect(step.output).toBe("Файл довольно большой для сборки и требует проверки.");
		expect(step.output).not.toMatch(/,,|\s,/);
	});
});
