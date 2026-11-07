/**
 * Message conversion: harness `Message[]` → the gateway's Vercel AI SDK
 * ModelMessage schema.
 *
 * The gateway speaks Vercel AI SDK's ModelMessage schema (not Anthropic's
 * content-block shape). Verified by reading the CLI bundle's own converter
 * and by hitting the gateway with both shapes — the Anthropic shape errors
 * with "messages do not match the ModelMessage[] schema."
 *
 * Shape:
 *   user:      { role: "user",      content: [{ type: "text", text }, { type: "image", image, mediaType }] }
 *   assistant: { role: "assistant", content: [{ type: "text", text }, { type: "reasoning", text }, { type: "tool-call", toolCallId, toolName, input }] }
 *   tool:      { role: "tool",      content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value } }] }
 *
 * Assistant thinking blocks ride back as `reasoning` parts, exactly like the
 * CLI (1.88.5 `toWireMessages` maps `thinking` → `{type:"reasoning"}`). Most
 * reasoning models preserve earlier reasoning server-side, but some (e.g.
 * `reflection/beam:free`) 400 with "Missing required parameter:
 * 'messages[N].reasoning_content'" without it — so the extension always
 * sends the parts, matching the CLI.
 */
import type { Message } from "@oh-my-pi/pi-ai";

type UserContent = { type: "text"; text: string } | { type: "image"; image: string; mediaType?: string };

type AssistantContent =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> };

type ToolContent = {
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	output: { type: "text"; value: string } | { type: "error-text"; value: string };
};

type CmdMessage =
	| { role: "user"; content: UserContent[] }
	| { role: "assistant"; content: AssistantContent[] }
	| { role: "tool"; content: ToolContent[] };

export function convertMessages(messages: Message[], textOnly = false): CmdMessage[] {
	const out: CmdMessage[] = [];
	// Track tool call names by id so tool-result messages can fill `toolName`
	const toolNameById = new Map<string, string>();

	// For text-only models: find the index of the last message (user or toolResult)
	// that carries images, so only that one keeps image placeholders.
	let lastImageMsgIdx = -1;
	if (textOnly) {
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (
				m.role === "user" &&
				Array.isArray(m.content) &&
				m.content.some((b: { type?: string }) => b.type === "image")
			) {
				lastImageMsgIdx = i;
			} else if (
				m.role === "toolResult" &&
				Array.isArray(m.content) &&
				m.content.some((b: { type?: string }) => b.type === "image")
			) {
				lastImageMsgIdx = i;
			}
		}
	}

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "user") {
			const content: UserContent[] = [];
			const hasImages =
				Array.isArray(msg.content) && msg.content.some((b: { type?: string }) => b.type === "image");
			const isLastImage = textOnly && i === lastImageMsgIdx;
			if (typeof msg.content === "string") {
				content.push({ type: "text", text: msg.content });
			} else {
				for (const block of msg.content) {
					if (block.type === "text") content.push({ type: "text", text: block.text });
					else if (block.type === "image") {
						if (!textOnly) {
							content.push({
								type: "image",
								image: `data:${block.mimeType};base64,${block.data}`,
								mediaType: block.mimeType,
							});
						} else if (isLastImage) {
							content.push({
								type: "text",
								text: `<attached_image index="${content.length}" mediaType="${block.mimeType}" />`,
							});
						}
						// else: drop the image (older message)
					}
				}
			}
			if (content.length === 0 && hasImages && textOnly) {
				content.push({ type: "text", text: "[image omitted: the active model is text-only]" });
			}
			if (content.length > 0) out.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const content: AssistantContent[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text) content.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					if (block.thinking) content.push({ type: "reasoning", text: block.thinking });
				} else if (block.type === "toolCall") {
					toolNameById.set(block.id, block.name);
					content.push({
						type: "tool-call",
						toolCallId: block.id,
						toolName: block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (content.length > 0) out.push({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			const text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			const images: UserContent[] = msg.content
				.filter((c): c is { type: "image"; data: string; mimeType: string } => c.type === "image")
				.map((c) => ({ type: "image", image: `data:${c.mimeType};base64,${c.data}`, mediaType: c.mimeType }));
			const block: ToolContent = {
				type: "tool-result",
				toolCallId: msg.toolCallId,
				toolName: toolNameById.get(msg.toolCallId) ?? msg.toolName ?? "unknown",
				output: { type: msg.isError ? "error-text" : "text", value: text },
			};
			// Merge consecutive tool-result messages into one role:"tool" message
			const last = out[out.length - 1];
			if (last && last.role === "tool") {
				last.content.push(block);
			} else {
				out.push({ role: "tool", content: [block] });
			}
			// The ModelMessage schema has no image output for tool results — the
			// CLI does the same: image blocks ride back as their own user message.
			if (images.length > 0) {
				if (!textOnly) {
					out.push({ role: "user", content: images });
				} else {
					const isLastImage = i === lastImageMsgIdx;
					const imgContent: UserContent[] = [];
					if (isLastImage) {
						images.forEach((img, idx) => {
							const mt = (img as { mediaType?: string }).mediaType ?? "image";
							imgContent.push({
								type: "text",
								text: `<attached_image index="${idx}" mediaType="${mt}" />`,
							});
						});
					}
					if (imgContent.length === 0) {
						imgContent.push({ type: "text", text: "[image omitted: the active model is text-only]" });
					}
					out.push({ role: "user", content: imgContent });
				}
			}
		}
	}
	return out;
}
