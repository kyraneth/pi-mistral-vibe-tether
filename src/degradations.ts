/**
 * Disclosures for everything the ACP transport cannot honor verbatim.
 *
 * Every disclosure records a session ledger entry on every occurrence.
 * Log-only standing route facts (`surface: "log"` for systemOverhead,
 * builtinSchemas, slashCommandCollision) stay in the ledger, `/vibe-status`,
 * and README without on-screen notices; per-event notices (`surface: "screen"`)
 * also notify the user deduplicated once per session and cause (except
 * parked-process exits, which set `dedupe: false` to notify every time).
 * Standing transport limitations (unsupported temperature/maxTokens overrides
 * and image/text block separation) are documented in README and
 * `/vibe-status` via PERMANENT_ROUTE_FACTS, but actual occurrences are
 * per-event screen notices. Setting the strict environment flag turns every
 * disclosure on either surface into an immediate refusal instead.
 */

import { sanitizeUntrustedDiagnostic } from "./errors.js";

export const DISCLOSURE_ENTRY_TYPE = "pi-mistral-vibe-tether:disclosure";

export const STRICT_ENV = "PI_MISTRAL_VIBE_TETHER_STRICT";

/** Estimated token budget for one tool result before the transport spills it. */
export const VIBE_LARGE_OUTPUT_MAX_CHARS = 16_000;

export type DisclosureSurface = "screen" | "log";

export interface DisclosureRecord {
  key: string;
  message: string;
  surface?: DisclosureSurface;
  detail?: Record<string, unknown>;
  timestamp: number;
}

export interface Disclosure {
  key: string;
  message: string;
  surface: DisclosureSurface;
  dedupe?: boolean;
  detail?: Record<string, unknown>;
}

/**
 * Standing route facts: recorded in the session ledger and shown in
 * `/vibe-status`, documented in README. Only systemOverhead, builtinSchemas
 * and slashCommandCollision are log-only disclosures; the other two facts
 * (unsupported controls, prompt-block separation) fire as screen notices on
 * actual occurrences. Strict mode still refuses every one of them; see
 * `emitDisclosure`.
 */
export const PERMANENT_ROUTE_FACTS: readonly string[] = [
  "Mistral Vibe adds its own harness capability guidance around Pi's system prompt; Pi owns the prompt base.",
  "Mistral Vibe exposes its local built-in programmatic tool wrappers and residual tool declarations alongside authorized Pi tools on mcp_pi; the tether appends a programmatic MCP routing note after Pi's verbatim system prompt base in prompts/pi.md, and only Pi-declared tools are authorized to run.",
  "Mistral Vibe ACP separates images from text blocks and joins text with blank lines; interleaved block order is not preserved verbatim.",
  "Mistral Vibe ACP does not honor Pi's explicit temperature/maxTokens overrides; proceeding with Vibe's default.",
  "Mistral Vibe ACP intercepts leading slash commands; the tether wraps prompt text so it reaches the model.",
];

// Scope one-time notices to Pi's session, not the disposable ACP connection.
const seenBySession = new Map<string, Set<string>>();
// Anonymous calls (no sessionId) dedupe by reporting scope identity without
// leaking a fresh processKey into the session map.
let seenByScope = new WeakMap<object, Set<string>>();

export function strictTransport(): boolean {
  return process.env[STRICT_ENV] === "1";
}

export function rememberDisclosure(sessionId: string, key: string): boolean {
  const seen = seenBySession.get(sessionId) ?? new Set<string>();
  if (seen.has(key)) return false;
  seen.add(key);
  seenBySession.set(sessionId, seen);
  return true;
}

export function rememberDisclosureForScope(scope: object, key: string): boolean {
  const seen = seenByScope.get(scope) ?? new Set<string>();
  if (seen.has(key)) return false;
  seen.add(key);
  seenByScope.set(scope, seen);
  return true;
}

export function resetDisclosuresForTests(): void {
  seenBySession.clear();
  seenByScope = new WeakMap<object, Set<string>>();
}

export function emitDisclosure(input: {
  sessionId?: string;
  reportingScope?: object | null;
  key: string;
  message: string;
  surface?: DisclosureSurface;
  detail?: Record<string, unknown>;
  dedupe?: boolean;
  notify?: (message: string) => void;
  recordDisclosure?: (entry: DisclosureRecord) => void;
  strictMessage?: string;
}): void {
  const surface: DisclosureSurface = input.surface ?? "screen";
  input.recordDisclosure?.({
    key: input.key,
    message: input.message,
    surface,
    detail: input.detail,
    timestamp: Date.now(),
  });
  if (strictTransport()) throw new Error(input.strictMessage ?? input.message);
  if (surface === "log") return;
  if (input.dedupe !== false) {
    if (input.sessionId) {
      if (!rememberDisclosure(input.sessionId, input.key)) return;
    } else {
      const scope = input.reportingScope ?? input.notify ?? input.recordDisclosure;
      if (scope !== null && scope !== undefined && (typeof scope === "object" || typeof scope === "function")) {
        if (!rememberDisclosureForScope(scope, input.key)) return;
      }
    }
  }
  if (input.notify) input.notify(input.message);
  else console.warn(`[pi-mistral-vibe-tether] ${input.message}`);
}

export function systemOverheadDisclosure(): Disclosure {
  return {
    key: "vibe-system-overhead",
    surface: "log",
    message:
      "Mistral Vibe adds its own harness capability guidance around Pi's system prompt; Pi owns the prompt base.",
  };
}

export function builtinSchemasDisclosure(): Disclosure {
  return {
    key: "vibe-builtin-schemas",
    surface: "log",
    message:
      "Mistral Vibe exposes its local built-in programmatic tool wrappers (run_typescript / search_tool_functions) and residual tool declarations alongside authorized Pi tools on mcp_pi; the tether appends a programmatic MCP routing note after Pi's verbatim system prompt base in prompts/pi.md, and only Pi-declared tools are authorized to run.",
  };
}

export function toolResultSpillDisclosure(
  tool: string,
  chars: number,
): Disclosure {
  return {
    key: "vibe-tool-result-spill",
    surface: "screen",
    message: `Tool result for ${tool} is ${chars} characters (over Mistral Vibe's 16,000-character / ~4,000-token threshold), so Vibe may summarize or spill it to a file excerpt before the model sees it; Pi kept the full result.`,
  };
}

export function autoCompactionDisclosure(): Disclosure {
  return {
    key: "vibe-auto-compaction",
    surface: "screen",
    message:
      "Mistral Vibe ran automatic compaction on its session context (which may middle-cut recent text or replace older images); Pi kept the full transcript and will reimport it on the next turn.",
  };
}

export function unsupportedControlDisclosure(control: string): Disclosure {
  return {
    key: `vibe-unsupported-control:${control}`,
    surface: "screen",
    message: `Mistral Vibe ACP does not honor Pi's explicit ${control} override; proceeding with Vibe's default.`,
  };
}

export function coldReplayDisclosure(options?: { omittedThinking?: boolean }): Disclosure {
  if (options?.omittedThinking === true) {
    return {
      key: "vibe-cold-replay:omitted-thinking",
      surface: "screen",
      message:
        "Mistral Vibe ACP has no native role-preserving history import; Pi replayed prior turns as structured context and omitted prior thinking blocks.",
    };
  }
  return {
    key: "vibe-cold-replay",
    surface: "screen",
    message:
      "Mistral Vibe ACP has no native role-preserving history import; Pi replayed prior turns as structured context.",
  };
}

export function promptBlockSeparationDisclosure(): Disclosure {
  return {
    key: "vibe-prompt-block-separation",
    surface: "screen",
    message:
      "Mistral Vibe ACP separates images from text blocks and joins text with blank lines; interleaved block order is not preserved verbatim.",
  };
}

export function imageAttachmentLimitDisclosure(count: number, limit: number): Disclosure {
  return {
    key: "vibe-image-attachment-limit",
    surface: "screen",
    message: `Mistral Vibe 3.1.5 allows at most ${limit} images per prompt (vibe/utils/images.py MAX_IMAGES_PER_MESSAGE, vibe/acp/image_blocks.py:22-27); ${count} images were attached with a limit of ${limit}, so the tether refused this prompt rather than silently dropping attachments.`,
  };
}

export function olderImagesDisclosure(): Disclosure {
  return {
    key: "vibe-older-images",
    surface: "screen",
    message:
      "Mistral Vibe replaces older images in multi-turn context with text placeholders; Pi kept the original attachments.",
  };
}

export function slashCommandCollisionDisclosure(command: string): Disclosure {
  return {
    key: "vibe-slash-command-collision",
    surface: "log",
    message: `Mistral Vibe ACP intercepts leading slash command ${command}; wrapped prompt text so it reaches the model.`,
  };
}

export interface ParkedProcessExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr?: string;
}

export function parkedProcessExitDisclosure(info: {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string | null;
}): Disclosure {
  const code = info.code ?? null;
  const signal = info.signal ?? null;
  const stderrDiagnostic = sanitizeUntrustedDiagnostic(info.stderr ?? "");
  const reason = signal
    ? `was killed (signal ${signal})`
    : code !== null
      ? `exited unexpectedly with code ${code}`
      : `exited unexpectedly`;
  return {
    key: "vibe-parked-process-exit",
    surface: "screen",
    dedupe: false,
    detail: { code, signal, ...(stderrDiagnostic ? { stderrDiagnostic } : {}) },
    message: `Parked vibe-acp process ${reason}; its Vibe session cannot be reused, so Pi's history is replayed into a fresh session.`,
  };
}

export function findToolResultSpills(
  tool: string,
  result: {
    content: Array<{ type: "text"; text: string } | { type: "image" }>;
  },
): Array<{ tool: string; chars: number }> {
  let chars = 0;
  for (const block of result.content) {
    if (block.type === "text") chars += block.text.length;
  }
  return chars > VIBE_LARGE_OUTPUT_MAX_CHARS ? [{ tool, chars }] : [];
}
