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
