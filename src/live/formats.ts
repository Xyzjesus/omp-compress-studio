import { isRecord } from "@oh-my-pi/pi-utils";
import { isShellToolName } from "../engines/rtk";

export type SupportedApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface BlockPath {
	message: number;
	part: number;
}

export interface ExtractedBlock {
	kind: "tool" | "user";
	path: BlockPath;
	/** How the message stores content at this path. */
	contentKind: "string" | "array";
	text: string;
	isShellTool: boolean;
	isNewestUser: boolean;
	/** Message lies after the last assistant message (OmniRoute's protected "current turn"). */
	isCurrentTurn: boolean;
}

export interface Extraction {
	blocks: ExtractedBlock[];
	/**
	 * Writes `newText` into `payload` IN PLACE and returns it. The caller owns
	 * cloning: `handleBeforeProviderRequest` clones the original payload once
	 * before the first write, so N block rewrites cost one copy, not N.
	 */
	writeBack(payload: unknown, block: ExtractedBlock, newText: string): unknown;
}

function textOfBlocks(blocks: unknown[], textField: "text" | "input_text"): string {
	return blocks
		.map((b) => (isRecord(b) && typeof b[textField] === "string" ? (b[textField] as string) : ""))
		.filter((t) => t.length > 0)
		.join("\n");
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return textOfBlocks(content, "text");
	return "";
}

/** Collect `tool_use`/`tool_calls`/`function_call` ids → names so tool outputs can be shell-gated. */
function collectToolNames(messages: unknown[], mode: "anthropic" | "openai-completions" | "openai-responses"): Map<string, string> {
	const names = new Map<string, string>();
	for (const message of messages) {
		if (!isRecord(message)) continue;
		if (mode === "anthropic" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (isRecord(part) && part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
					names.set(part.id, part.name);
				}
			}
		} else if (mode === "openai-completions" && Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls) {
				if (isRecord(call) && typeof call.id === "string" && isRecord(call.function) && typeof call.function.name === "string") {
					names.set(call.id, call.function.name);
				}
			}
		} else if (mode === "openai-responses" && isRecord(message) && message.type === "function_call") {
			if (typeof message.call_id === "string" && typeof message.name === "string") {
				names.set(message.call_id, message.name);
			}
		}
	}
	return names;
}

function extractAnthropic(payload: Record<string, unknown>): Extraction | null {
	if (!Array.isArray(payload.messages)) return null;
	const messages = payload.messages;
	const toolNames = collectToolNames(messages, "anthropic");
	let lastUserIndex = -1;
	let lastAssistantIndex = -1;
	for (let i = 0; i < messages.length; i++) {
		const role = isRecord(messages[i]) ? messages[i].role : undefined;
		if (role === "user") lastUserIndex = i;
		if (role === "assistant") lastAssistantIndex = i;
	}

	const blocks: ExtractedBlock[] = [];
	for (let m = 0; m < messages.length; m++) {
		const message = messages[m];
		if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) continue;
		const isNewestUser = m === lastUserIndex;
		const isCurrentTurn = m > lastAssistantIndex;

		if (typeof message.content === "string") {
			if (message.role === "user" && message.content.length > 0) {
				blocks.push({
					kind: "user", path: { message: m, part: 0 }, contentKind: "string",
					text: message.content, isShellTool: false, isNewestUser, isCurrentTurn,
				});
			}
			continue;
		}
		if (!Array.isArray(message.content)) continue;

		for (let p = 0; p < message.content.length; p++) {
			const part = message.content[p];
			if (!isRecord(part)) continue;

			if (part.type === "tool_result") {
				// Mixed content (e.g. text + screenshot) cannot be rewritten
				// without destroying the non-text parts — leave such blocks alone.
				if (Array.isArray(part.content) && part.content.some((p) => isRecord(p) && p.type !== "text")) {
					continue;
				}
				const text = contentToText(part.content);
				if (text.length === 0) continue;
				const toolUseId = typeof part.tool_use_id === "string" ? part.tool_use_id : undefined;
				blocks.push({
					kind: "tool", path: { message: m, part: p }, contentKind: Array.isArray(part.content) ? "array" : "string",
					text, isShellTool: isShellToolName(toolUseId ? toolNames.get(toolUseId) : undefined), isNewestUser, isCurrentTurn,
				});
			} else if (part.type === "text" && typeof part.text === "string" && message.role === "user" && part.text.length > 0) {
				blocks.push({
					kind: "user", path: { message: m, part: p }, contentKind: "array",
					text: part.text, isShellTool: false, isNewestUser, isCurrentTurn,
				});
			}
		}
	}

	return {
		blocks,
		writeBack(payload, block, newText) {
			const target = payload as Record<string, unknown>;
			const message = (target.messages as unknown[])[block.path.message] as Record<string, unknown> | undefined;
			if (!message) return payload;
			if (block.kind === "user" && !Array.isArray(message.content)) {
				message.content = newText;
				return payload;
			}
			if (!Array.isArray(message.content)) return payload;
			const content = message.content as unknown[];
			const part = content[block.path.part] as Record<string, unknown> | undefined;
			if (!part) return payload;
			if (part.type === "tool_result") {
				// keep the tool_result wrapper; only its content is replaced
				part.content = block.contentKind === "array" ? [{ type: "text", text: newText }] : newText;
			} else {
				part.text = newText;
			}
			return payload;
		},
	};
}

function extractOpenaiCompletions(payload: Record<string, unknown>): Extraction | null {
	if (!Array.isArray(payload.messages)) return null;
	const messages = payload.messages;
	const toolNames = collectToolNames(messages, "openai-completions");
	let lastUserIndex = -1;
	let lastAssistantIndex = -1;
	for (let i = 0; i < messages.length; i++) {
		const role = isRecord(messages[i]) ? messages[i].role : undefined;
		if (role === "user") lastUserIndex = i;
		if (role === "assistant") lastAssistantIndex = i;
	}

	const blocks: ExtractedBlock[] = [];
	for (let m = 0; m < messages.length; m++) {
		const message = messages[m];
		if (!isRecord(message)) continue;

		if (message.role === "tool" && typeof message.content === "string" && message.content.length > 0) {
			const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
			blocks.push({
				kind: "tool", path: { message: m, part: 0 }, contentKind: "string",
				text: message.content, isShellTool: isShellToolName(toolCallId ? toolNames.get(toolCallId) : undefined),
				isNewestUser: false, isCurrentTurn: m > lastAssistantIndex,
			});
			continue;
		}
		if (message.role !== "user") continue;
		const isNewestUser = m === lastUserIndex;
		const isCurrentTurn = m > lastAssistantIndex;
		if (typeof message.content === "string" && message.content.length > 0) {
			blocks.push({
				kind: "user", path: { message: m, part: 0 }, contentKind: "string",
				text: message.content, isShellTool: false, isNewestUser, isCurrentTurn,
			});
		} else if (Array.isArray(message.content)) {
			for (let p = 0; p < message.content.length; p++) {
				const part = message.content[p];
				if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
					blocks.push({
						kind: "user", path: { message: m, part: p }, contentKind: "array",
						text: part.text, isShellTool: false, isNewestUser, isCurrentTurn,
					});
				}
			}
		}
	}

	return {
		blocks,
		writeBack(payload, block, newText) {
			const target = payload as Record<string, unknown>;
			const message = (target.messages as unknown[])[block.path.message] as Record<string, unknown> | undefined;
			if (!message) return payload;
			if (block.contentKind === "string" || message.role === "tool") {
				message.content = newText;
				return payload;
			}
			const content = message.content as unknown[];
			const part = content[block.path.part] as Record<string, unknown> | undefined;
			if (!part) return payload;
			part.text = newText;
			return payload;
		},
	};
}

function extractOpenaiResponses(payload: Record<string, unknown>): Extraction | null {
	if (!Array.isArray(payload.input)) return null;
	const items = payload.input;
	const toolNames = collectToolNames(items, "openai-responses");

	const blocks: ExtractedBlock[] = [];
	let lastUserIndex = -1;
	let lastAssistantIndex = -1;
	for (let i = 0; i < items.length; i++) {
		if (isRecord(items[i]) && items[i].type === "message" && items[i].role === "user") lastUserIndex = i;
		if (isRecord(items[i]) && items[i].type === "message" && items[i].role === "assistant") lastAssistantIndex = i;
	}
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!isRecord(item)) continue;
		if (item.type === "function_call_output" && typeof item.output === "string" && item.output.length > 0) {
			const callId = typeof item.call_id === "string" ? item.call_id : undefined;
			blocks.push({
				kind: "tool", path: { message: i, part: 0 }, contentKind: "string",
				text: item.output, isShellTool: isShellToolName(callId ? toolNames.get(callId) : undefined),
				isNewestUser: false, isCurrentTurn: i > lastAssistantIndex,
			});
			continue;
		}
		if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) continue;
		for (let p = 0; p < item.content.length; p++) {
			const part = item.content[p];
			if (isRecord(part) && part.type === "input_text" && typeof part.text === "string" && part.text.length > 0) {
				blocks.push({
					kind: "user", path: { message: i, part: p }, contentKind: "array",
					text: part.text, isShellTool: false, isNewestUser: i === lastUserIndex, isCurrentTurn: i > lastAssistantIndex,
				});
			}
		}
	}

	return {
		blocks,
		writeBack(payload, block, newText) {
			const target = payload as Record<string, unknown>;
			const item = (target.input as unknown[])[block.path.message] as Record<string, unknown> | undefined;
			if (!item) return payload;
			if (item.type === "function_call_output") {
				item.output = newText;
				return payload;
			}
			if (!Array.isArray(item.content)) return payload;
			const part = item.content[block.path.part] as Record<string, unknown> | undefined;
			if (!part) return payload;
			part.text = newText;
			return payload;
		},
	};
}

/** Parse a provider payload into compressible blocks; null when the shape is unknown. */
export function extractBlocks(payload: unknown, api: string): Extraction | null {
	if (!isRecord(payload)) return null;
	switch (api) {
		case "anthropic-messages":
			return extractAnthropic(payload);
		case "openai-completions":
			return extractOpenaiCompletions(payload);
		case "openai-responses":
			return extractOpenaiResponses(payload);
		default:
			return null;
	}
}
