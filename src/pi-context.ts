/**
 * Pi <-> Vibe context translation.
 *
 * Pi owns the transcript; the transport receives prompt blocks. Prior turns
 * are imported as structured text (plus their images) on a fresh session,
 * and the current user turn is forwarded natively. Thinking never crosses:
 * Pi owns history and a vendor signature cannot be reconstructed.
 */

import { projectionHash } from "pi-tether-core/request";

export { piContext } from "pi-tether-core/pi-context";

/** Maximum images Vibe will carry in one request window. */
// Measured vendor limit: Mistral Vibe 3.1.5 vibe/utils/images.py MAX_IMAGES_PER_MESSAGE = 8, enforced in vibe/acp/image_blocks.py:22-27.
export const VIBE_MAX_REQUEST_IMAGES = 8;
/** Per-prompt attachment limit (same measured vendor limit). */
export const VIBE_MAX_PROMPT_IMAGES = VIBE_MAX_REQUEST_IMAGES;

/** Count image blocks with string data across all messages. */
export function countImages(messages: any[]): number {
  let count = 0;
  for (const message of messages ?? []) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "image" && typeof block.data === "string") count += 1;
    }
  }
  return count;
}

/** True when the warm context exceeds Vibe's request image window. */
export function hasWarmImageWindowOverflow(messages: any[]): boolean {
  return hasOlderImages(messages) && countImages(messages) > VIBE_MAX_REQUEST_IMAGES;
}

/** Count image blocks in one prompt (ACP prompt blocks). */
export function countBlockImages(blocks: readonly PromptBlock[]): number {
  let count = 0;
  for (const block of blocks ?? []) {
    if ((block as any)?.type === "image") count += 1;
  }
  return count;
}

/** True if any message has a thinking block in array content. */
export function hasThinkingBlocks(messages: any[]): boolean {
  for (const message of messages ?? []) {
    const content = (message as any)?.content;
    if (Array.isArray(content) && content.some((block: any) => block?.type === "thinking")) return true;
  }
  return false;
}

/**
 * True when prompt blocks interleave images and text in a way Vibe will
 * not preserve verbatim: Vibe extracts images separately and joins text
 * blocks with blank lines, so a text block after an image changes the
 * observable order / grouping.
 */
export function hasPromptBlockSeparation(blocks: readonly PromptBlock[]): boolean {
  let seenImage = false;
  for (const block of blocks ?? []) {
    if (block?.type === "image") seenImage = true;
    else if (block?.type === "text" && seenImage) return true;
  }
  return false;
}

/** One ACP prompt content block. ACP defines text and image parts. */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Fingerprint exactly the import projection, not Pi-only representations. */
export function historyHash(messages: any[]): string {
  return projectionHash(replayPiMessages(messages));
}

/**
 * Import in order, including every image and tool result. Never replay
 * thinking: Pi owns history and a vendor signature cannot be reconstructed.
 *
 * This is the text the transport receives for a fresh session. A parked
 * session only receives the delta after its acknowledged prefix.
 */
export function replayPiMessages(messages: any[]): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  for (const message of messages) {
    blocks.push({
      type: "text",
      text:
        message.role === "toolResult"
          ? `TOOL RESULT (${message.toolName}, id=${message.toolCallId}, error=${!!message.isError}):`
          : `${message.role.toUpperCase()}:`,
    });
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content ?? []);
    for (const block of content) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
      } else if (block.type === "toolCall") {
        blocks.push({
          type: "text",
          text: `TOOL CALL ${block.name} id=${block.id}: ${JSON.stringify(block.arguments)}`,
        });
      }
      // Thinking blocks are skipped: they are Pi's, not the transport's.
    }
  }
  return blocks;
}

function messageHasImage(message: any): boolean {
  const content = message?.content;
  if (Array.isArray(content)) {
    return content.some(
      (block: any) => block?.type === "image" && typeof block.data === "string",
    );
  }
  return false;
}

/** True when an image lives before the final user message (older turns). */
export function hasOlderImages(messages: any[]): boolean {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return false;
  return messages.slice(0, lastUserIndex).some(messageHasImage);
}

/** Built-in slash commands the transport intercepts before prompting. */
export const VIBE_SLASH_COMMANDS = [
  "/help",
  "/compact",
  "/reload",
  "/log",
  "/mcp",
  "/proxy-setup",
  "/retry",
  "/leanstall",
  "/unleanstall",
  "/data-retention",
] as const;

const SLASH_PREFIX = "User message (literal text, not a Vibe command):\n";

/**
 * Wrap a leading built-in slash command so the transport forwards the text
 * to the model instead of executing it. Detection runs on the trimmed text
 * and is case-insensitive; the command must be followed by end-of-string or
 * whitespace so `/compactx` stays ordinary text.
 */
export function guardLeadingSlashCommand(text: string): {
  text: string;
  matchedCommand?: string;
} {
  const trimmed = text.trim();
  const lowered = trimmed.toLowerCase();
  for (const command of VIBE_SLASH_COMMANDS) {
    if (lowered === command) {
      return { text: `${SLASH_PREFIX}${trimmed}`, matchedCommand: command };
    }
    if (lowered.startsWith(command)) {
      const next = lowered[command.length];
      if (next !== undefined && /\s/.test(next)) {
        return { text: `${SLASH_PREFIX}${trimmed}`, matchedCommand: command };
      }
    }
  }
  return { text };
}
