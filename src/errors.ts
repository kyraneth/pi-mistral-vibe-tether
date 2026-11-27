/**
 * Typed ACP error classification for `vibe-acp`.
 *
 * Rate limits retry, quota and allowance exhaustion does not: retrying an
 * exhausted Vibe allowance cannot succeed, while rewriting it as an overflow
 * would compact the conversation. This module keeps those causes distinct.
 * Signal and exit causes come from the process handle, not from the server.
 */

import { AcpRpcError } from "./acp-client.js";
import { isOverflowError } from "./overflow.js";

export const UNAUTHENTICATED = -32000;
export const RATE_LIMITED = -31001;
export const CONFIGURATION_ERROR = -31002;
export const CONVERSATION_LIMIT = -31003;
export const CONTEXT_TOO_LONG = -31004;
export const REFUSAL = -31005;
export const COMPACTION_FAILED = -31006;
export const INVALID_IMAGE_ATTACHMENT = -31007;
export const IMAGES_NOT_SUPPORTED = -31008;
export const INTERNAL_ERROR = -32603;

export type VibeErrorKind =
  | "rate_limit"
  | "quota_limit"
  | "context_overflow"
  | "compaction_failed"
  | "auth"
  | "image"
  | "refusal"
  | "signal_kill"
  | "exit"
  | "internal";

export interface ClassifiedVibeError {
  kind: VibeErrorKind;
  code?: number;
  message: string;
  retryable: boolean;
  stderrDiagnostic?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

function extractCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "code" in (error as Record<string, unknown>)) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in (error as Record<string, unknown>)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "unknown error");
}

const QUOTA_PATTERNS: RegExp[] = [
  /usage[_\s-]*limit/i,
  /quota/i,
  /credit/i,
  /billing/i,
  /402/,
  /allowance/i,
  /budget\s+exhausted/i,
];

const RATE_PATTERNS: RegExp[] = [
  /429/,
  /rate[\s_-]*limit/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /invalid.*api.*key/i,
  /missing.*api.*key/i,
  /unauthenticated/i,
  /invalid key/i,
  /sign in/i,
];

const IMAGE_PATTERNS: RegExp[] = [
  /invalid image/i,
  /images? not supported/i,
  /image.*not supported/i,
  /image attachment/i,
];

/**
 * Make untrusted child / wire text safe to embed in a user-facing error.
 * Replaces ASCII control characters with spaces, collapses whitespace,
 * trims, and truncates long output cleanly with an ellipsis.
 */
export function sanitizeUntrustedDiagnostic(raw: string): string {
  const MAX = 1000;
  let cleaned = String(raw ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > MAX) {
    let cut = cleaned.slice(0, MAX);
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > Math.floor(MAX / 2)) cut = cut.slice(0, lastSpace);
    cleaned = cut.trimEnd() + "…";
  }
  return cleaned;
}

export class VibeProcessExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrDiagnostic?: string;
  constructor(options: { code?: number | null; signal?: NodeJS.Signals | null; stderr?: string | null }) {
    const code = options?.code ?? null;
    const signal = options?.signal ?? null;
    const stderr = options?.stderr ?? "";
    super(signal ? `vibe-acp was killed (signal ${signal})` : `vibe-acp exited unexpectedly with code ${code ?? "unknown"}`);
    this.name = "VibeProcessExitError";
    this.exitCode = code;
    this.signal = signal;
    const sanitized = sanitizeUntrustedDiagnostic(stderr);
    if (sanitized) this.stderrDiagnostic = sanitized;
  }
}

function withTetherPrefix(prefix: string, message: string): string {
  const sanitized = sanitizeUntrustedDiagnostic(message);
  if (!sanitized) return prefix;
  if (sanitized.startsWith("Mistral Vibe")) return sanitized;
  return `${prefix}: ${sanitized}`;
}

function actionableQuotaMessage(message: string): string {
  if (/allowance/i.test(message) && message.includes("/vibe-status")) return message;
  return `${message} (Vibe allowance may be exhausted; check /vibe-status.)`;
}

function extractTrailingStderr(message: string, prefixLen: number): string | undefined {
  const bracket = message.match(/\[untrusted vibe-acp stderr:\s*([\s\S]*?)\]\s*$/);
  if (bracket) {
    const sanitized = sanitizeUntrustedDiagnostic(bracket[1] ?? "");
    return sanitized || undefined;
  }
  const colonIdx = message.indexOf(":", prefixLen);
  if (colonIdx >= 0) {
    let rest = message.slice(colonIdx + 1).trim();
    if (rest.startsWith("[untrusted vibe-acp stderr:") && rest.endsWith("]")) {
      rest = rest.slice("[untrusted vibe-acp stderr:".length, -1).trim();
    }
    return rest ? sanitizeUntrustedDiagnostic(rest) : undefined;
  }
  if (message.length > prefixLen) {
    const rest = message.slice(prefixLen).trim();
    return rest ? sanitizeUntrustedDiagnostic(rest) : undefined;
  }
  return undefined;
}

function parseNumericExitCode(token: string): number | null {
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/** Classify an ACP or process cause without conflating quota, rate and overflow. */
export function classifyVibeError(error: unknown): ClassifiedVibeError {
  // First, typed process exit wins over every text pattern.
  if (error instanceof VibeProcessExitError) {
    return {
      kind: error.signal ? "signal_kill" : "exit",
      message: error.message,
      retryable: false,
      stderrDiagnostic: error.stderrDiagnostic,
      exitCode: error.exitCode,
      signal: error.signal,
    };
  }
  const code = extractCode(error);
  const message = extractMessage(error);
  const isTypedAcp = error instanceof AcpRpcError || typeof code === "number";
  // Typed ACP codes always beat marker/prose text: check explicit codes first.
  if (code === RATE_LIMITED) {
    return { kind: "rate_limit", code, message, retryable: true };
  }
  if (code === CONTEXT_TOO_LONG) {
    return { kind: "context_overflow", code, message, retryable: false };
  }
  if (code === UNAUTHENTICATED) {
    return { kind: "auth", code, message, retryable: false };
  }
  if (code === INVALID_IMAGE_ATTACHMENT || code === IMAGES_NOT_SUPPORTED) {
    return { kind: "image", code, message, retryable: false };
  }
  if (code === REFUSAL) {
    return { kind: "refusal", code, message, retryable: false };
  }
  if (code === COMPACTION_FAILED) {
    return { kind: "compaction_failed", code, message, retryable: false };
  }
  // For non-typed errors, process-exit prefixes beat quota/rate/auth/overflow prose.
  if (!isTypedAcp) {
    let m = message.match(/^vibe-acp was killed \(signal ([^)]+)\)/);
    if (m) {
      const signal = m[1] as NodeJS.Signals;
      return {
        kind: "signal_kill",
        code,
        message: `vibe-acp was killed (signal ${signal})`,
        retryable: false,
        stderrDiagnostic: extractTrailingStderr(message, m[0].length),
        exitCode: null,
        signal,
      };
    }
    m = message.match(/^vibe-acp exited \(([^)]+)\) before answering/);
    if (m) {
      const token = m[1];
      return {
        kind: "exit",
        code,
        message: `vibe-acp exited (${token}) before answering`,
        retryable: false,
        stderrDiagnostic: extractTrailingStderr(message, m[0].length),
        exitCode: parseNumericExitCode(token),
        signal: null,
      };
    }
    m = message.match(/^vibe-acp exited(?: unexpectedly)? with code ([^\s:]+)/);
    if (m) {
      const token = m[1].replace(/[.,;)\]]+$/g, "");
      return {
        kind: "exit",
        code,
        message: `vibe-acp exited unexpectedly with code ${token}`,
        retryable: false,
        stderrDiagnostic: extractTrailingStderr(message, m[0].length),
        exitCode: parseNumericExitCode(token),
        signal: null,
      };
    }
  }
  // For non-specific codes (INTERNAL_ERROR or other numeric) or non-typed
  // errors, fall through to prose-pattern classification.
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "quota_limit", code, message: actionableQuotaMessage(message), retryable: false };
  }
  if (RATE_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "rate_limit", code, message, retryable: true };
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "auth", code, message, retryable: false };
  }
  if (IMAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "image", code, message, retryable: false };
  }
  if (isOverflowError(message) || message.includes("context_length_exceeded")) {
    return { kind: "context_overflow", code, message, retryable: false };
  }
  return { kind: "internal", code, message, retryable: true };
}

/** The user-facing sentence for a classified cause. */
export function formatVibeError(error: unknown): string {
  const classified = classifyVibeError(error);
  switch (classified.kind) {
    case "signal_kill":
      return sanitizeUntrustedDiagnostic(classified.message);
    case "exit":
      return sanitizeUntrustedDiagnostic(classified.message);
    case "rate_limit":
      if (/rate[\s_-]*limit|429/i.test(classified.message)) {
        return sanitizeUntrustedDiagnostic(classified.message);
      }
      return `Mistral Vibe rate limit exceeded (ACP code ${classified.code}): ${sanitizeUntrustedDiagnostic(classified.message)}`;
    case "context_overflow":
      if (
        isOverflowError(classified.message) ||
        classified.message.includes("context_length_exceeded")
      ) {
        return sanitizeUntrustedDiagnostic(classified.message);
      }
      return `context_length_exceeded: prompt is too long (ACP code ${classified.code}): ${sanitizeUntrustedDiagnostic(classified.message)}`;
    case "quota_limit":
      return sanitizeUntrustedDiagnostic(classified.message);
    case "auth":
      return withTetherPrefix("Mistral Vibe authentication failed", classified.message);
    case "image":
      return withTetherPrefix("Mistral Vibe image error", classified.message);
    case "refusal":
      return withTetherPrefix("Mistral Vibe refused the request", classified.message);
    case "compaction_failed":
      return withTetherPrefix("Mistral Vibe automatic compaction failed", classified.message);
    case "internal":
      if (typeof classified.code === "number") {
        return `Mistral Vibe ACP error (code ${classified.code}): ${sanitizeUntrustedDiagnostic(classified.message)}`;
      }
      return sanitizeUntrustedDiagnostic(classified.message);
  }
}
