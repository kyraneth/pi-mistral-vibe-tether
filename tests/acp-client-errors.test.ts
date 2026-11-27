import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { parseFrame, isResponse, isServerRequest } from "../src/stream-parser.js";
import { AcpClient, AcpRpcError, CLIENT_CAPABILITIES, CLIENT_INFO } from "../src/acp-client.js";
import {
  UNAUTHENTICATED,
  RATE_LIMITED,
  CONFIGURATION_ERROR,
  CONVERSATION_LIMIT,
  CONTEXT_TOO_LONG,
  REFUSAL,
  COMPACTION_FAILED,
  INVALID_IMAGE_ATTACHMENT,
  IMAGES_NOT_SUPPORTED,
  INTERNAL_ERROR,
  VibeProcessExitError,
  classifyVibeError,
  formatVibeError,
} from "../src/errors.js";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { OVERFLOW_PREFIX, isOverflowError, rewriteOverflowMessage } from "../src/overflow.js";

function fakeProc(): any {
  const proc: any = new (EventEmitter as any)();
  proc.stdout = new PassThrough();
  proc.stdin = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 4242;
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = () => true;
  // Captured client writes (JSON-RPC frames sent to the server).
  proc.written = [] as string[];
  proc.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) proc.written.push(line);
    }
  });
  return proc;
}

function serverSend(proc: any, obj: unknown): void {
  proc.stdout.write(`${JSON.stringify(obj)}\n`);
}

describe("stream-parser", () => {
  it("parses a JSON-RPC object frame", () => {
    const frame = parseFrame('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(frame).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("reports an empty frame as a fault", () => {
    expect(parseFrame("   ")).toEqual({ fault: "empty frame" });
  });

  it("reports a non-JSON frame as a fault", () => {
    const frame = parseFrame("not json at all");
    expect("fault" in (frame as any)).toBe(true);
  });

  it("reports a non-object frame as a fault", () => {
    expect("fault" in (parseFrame("[1,2,3]") as any)).toBe(true);
    expect("fault" in (parseFrame('"just a string"') as any)).toBe(true);
    expect("fault" in (parseFrame("42") as any)).toBe(true);
  });

  it("distinguishes responses from server requests", () => {
    expect(isResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: "abc", error: { code: -1, message: "x" } })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 1, method: "session/update" })).toBe(false);
    expect(isResponse({ jsonrpc: "2.0", method: "session/update" })).toBe(false);
    expect(isServerRequest({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: {} })).toBe(true);
    expect(isServerRequest({ jsonrpc: "2.0", method: "session/update" })).toBe(false);
    expect(isServerRequest({ jsonrpc: "2.0", id: null, method: "m" })).toBe(false);
  });
});

describe("AcpClient request/response", () => {
  it("resolves a successful RPC response", async () => {
    const proc = fakeProc();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    const pending = client.request("initialize", { protocolVersion: 1 });
    serverSend(proc, { jsonrpc: "2.0", id: 1, result: { agentId: "x" } });
    await expect(pending).resolves.toEqual({ agentId: "x" });
    expect(proc.written[0]).toContain('"method":"initialize"');
    client.dispose();
  });

  it("rejects with AcpRpcError preserving code, data and method", async () => {
    const proc = fakeProc();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    const pending = client.request("session/prompt", { sessionId: "s1" });
    serverSend(proc, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: RATE_LIMITED, message: "rate limit exceeded", data: { provider: "vibe", model: "mistral-large-4-0" } },
    });
    const err: unknown = await pending.then(
      () => new Error("expected rejection"),
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(AcpRpcError);
    const rpcErr = err as AcpRpcError;
    expect(rpcErr.code).toBe(RATE_LIMITED);
    expect(rpcErr.data).toEqual({ provider: "vibe", model: "mistral-large-4-0" });
    expect(rpcErr.method).toBe("session/prompt");
    expect(rpcErr.message).toContain("rate limit exceeded");
    client.dispose();
  });

  it("rejects with AcpRpcError for the quota shape used by the server", async () => {
    const proc = fakeProc();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    const pending = client.request("session/prompt", {});
    serverSend(proc, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: INTERNAL_ERROR, message: "usage_limit quota exhausted", data: { reason: "quota" } },
    });
    const err: unknown = await pending.then(
      () => new Error("expected rejection"),
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(AcpRpcError);
    expect((err as AcpRpcError).code).toBe(INTERNAL_ERROR);
    expect((err as AcpRpcError).data).toEqual({ reason: "quota" });
    client.dispose();
  });
});

describe("AcpClient notifications and permission", () => {
  it("routes session/update to onUpdate", () => {
    const proc = fakeProc();
    const onUpdate = vi.fn();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate,
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    serverSend(proc, {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    });
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
    );
    client.dispose();
  });

  it("routes _session/retrying to onRetrying", () => {
    const proc = fakeProc();
    const onRetrying = vi.fn();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onRetrying,
      onDiagnostic() {},
    });
    serverSend(proc, {
      jsonrpc: "2.0",
      method: "_session/retrying",
      params: { sessionId: "s1", attempt: 1, delayMs: 500 },
    });
    expect(onRetrying).toHaveBeenCalledOnce();
    expect(onRetrying.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ attempt: 1 }));
    client.dispose();
  });

  it("answers an allowed permission with the offered allow_once optionId", async () => {
    const proc = fakeProc();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "allowed" as const }),
      onDiagnostic() {},
    });
    serverSend(proc, {
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: {
        options: [
          { optionId: "allow-1", kind: "allow_once", name: "Allow once" },
          { optionId: "deny-1", kind: "reject_once", name: "Deny once" },
        ],
      },
    });
    // Give the async permission answer a tick to write.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(proc.written.length).toBeGreaterThan(0);
    const answer = JSON.parse(proc.written[proc.written.length - 1]!);
    expect(answer.id).toBe(99);
    expect(answer.result?.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
    client.dispose();
  });

  it("answers a denied permission as cancelled", async () => {
    const proc = fakeProc();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    serverSend(proc, {
      jsonrpc: "2.0",
      id: 100,
      method: "session/request_permission",
      params: { options: [{ optionId: "allow-1", kind: "allow_once" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answer = JSON.parse(proc.written[proc.written.length - 1]!);
    expect(answer.id).toBe(100);
    expect(answer.result?.outcome).toEqual({ outcome: "cancelled" });
    client.dispose();
  });

  it("denies permission when no allow_once option is offered", async () => {
    const proc = fakeProc();
    const onDiagnostic = vi.fn();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "allowed" as const }),
      onDiagnostic,
    });
    serverSend(proc, {
      jsonrpc: "2.0",
      id: 101,
      method: "session/request_permission",
      params: { options: [{ optionId: "other", kind: "allow_always" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answer = JSON.parse(proc.written[proc.written.length - 1]!);
    expect(answer.id).toBe(101);
    expect(answer.result?.outcome).toEqual({ outcome: "cancelled" });
    expect(onDiagnostic).toHaveBeenCalledWith(
      "vibe-acp requested permission without an allow_once option; denying",
      "warn",
    );
    client.dispose();
  });

  it("denies permission when the allow_once optionId is empty", async () => {
    const proc = fakeProc();
    const onDiagnostic = vi.fn();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "allowed" as const }),
      onDiagnostic,
    });
    serverSend(proc, {
      jsonrpc: "2.0",
      id: 102,
      method: "session/request_permission",
      params: { options: [{ optionId: "", kind: "allow_once" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answer = JSON.parse(proc.written[proc.written.length - 1]!);
    expect(answer.id).toBe(102);
    expect(answer.result?.outcome).toEqual({ outcome: "cancelled" });
    expect(onDiagnostic).toHaveBeenCalledWith(
      "vibe-acp requested permission without an allow_once option; denying",
      "warn",
    );
    client.dispose();
  });

  it("advertises the protocol client info and capabilities", () => {
    expect(CLIENT_CAPABILITIES).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    expect(typeof CLIENT_INFO.name).toBe("string");
    expect(typeof CLIENT_INFO.version).toBe("string");
    expect(CLIENT_INFO.name.length).toBeGreaterThan(0);
  });
});

describe("AcpClient process exit", () => {
  it("rejects pending requests with the signal-kill message", async () => {
    const proc = fakeProc();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    const pending = client.request("session/prompt", {});
    const watched = pending.then(
      () => new Error("expected rejection"),
      (caught: unknown) => caught,
    );
    proc.emit("exit", null, "SIGKILL");
    const err = (await watched) as Error;
    expect(err.message).toBe("vibe-acp was killed (signal SIGKILL)");
  });

  it("rejects pending requests with the exit-code message", async () => {
    const proc = fakeProc();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    const pending = client.request("session/prompt", {});
    const watched = pending.then(
      () => new Error("expected rejection"),
      (caught: unknown) => caught,
    );
    proc.emit("exit", 3, null);
    const err = (await watched) as Error;
    expect(err.message).toBe("vibe-acp exited (3) before answering");
  });
});

describe("AcpClient request lifecycle", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const proc = fakeProc();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    const controller = new AbortController();
    controller.abort();
    let settled = false;
    const pending = client.request("initialize", {}, { signal: controller.signal }).then(
      () => {
        settled = true;
        return new Error("expected rejection");
      },
      (caught: unknown) => {
        settled = true;
        return caught;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(true);
    const err = (await pending) as Error;
    expect(err.message).toBe("ACP request initialize aborted");
    expect(proc.written).toHaveLength(0);
    client.dispose();
  });

  it("rejects a pending request when the signal aborts (silent child)", async () => {
    const proc = fakeProc();
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    const controller = new AbortController();
    let settled = false;
    const pending = client.request("initialize", {}, { signal: controller.signal }).then(
      () => {
        settled = true;
        return new Error("expected rejection");
      },
      (caught: unknown) => {
        settled = true;
        return caught;
      },
    );
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(true);
    const err = (await pending) as Error;
    expect(err.message).toBe("ACP request initialize aborted");
    // Aborting after settle must not cause further errors.
    controller.abort();
    client.dispose();
  });

  it("rejects immediately when stdin.write throws synchronously and reports an error diagnostic", async () => {
    const proc = fakeProc();
    const onDiagnostic = vi.fn();
    proc.stdin.write = () => {
      throw new Error("boom");
    };
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic,
    });
    let settled = false;
    let rejection: unknown;
    const pending = client.request("initialize", {}).then(
      () => {
        settled = true;
      },
      (caught: unknown) => {
        settled = true;
        rejection = caught;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(true);
    await pending;
    expect(rejection).toBeInstanceOf(Error);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.any(String), "error");
    client.dispose();
  });

  it("rejects immediately when stdin is destroyed and reports an error diagnostic", async () => {
    const proc = fakeProc();
    const onDiagnostic = vi.fn();
    proc.stdin.destroy();
    // PassThrough.destroy() flips destroyed/writable asynchronously in some
    // Node versions; ensure the flags are observable for the write guard.
    proc.stdin.destroyed = true;
    proc.stdin.writable = false;
    const client = new AcpClient(proc as unknown as ChildProcess, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic,
    });
    let settled = false;
    let rejection: unknown;
    const pending = client.request("session/new", {}).then(
      () => {
        settled = true;
      },
      (caught: unknown) => {
        settled = true;
        rejection = caught;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(true);
    await pending;
    expect(rejection).toBeInstanceOf(Error);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.any(String), "error");
    client.dispose();
  });
});

describe("classifyVibeError", () => {
  function rpcError(code: number, message: string, data?: unknown): AcpRpcError {
    return new AcpRpcError(message, { code, data, method: "session/prompt" });
  }

  it("classifies a rate limit code as retryable", () => {
    const classified = classifyVibeError(rpcError(RATE_LIMITED, "rate limit exceeded"));
    expect(classified.kind).toBe("rate_limit");
    expect(classified.code).toBe(RATE_LIMITED);
    expect(classified.retryable).toBe(true);
  });

  it("classifies an opaque rate-limit code as rate_limit (typed-rate)", () => {
    const classified = classifyVibeError(
      new AcpRpcError("upstream temporarily busy", { code: RATE_LIMITED, method: "session/prompt" }),
    );
    expect(classified.kind).toBe("rate_limit");
    expect(classified.code).toBe(RATE_LIMITED);
    expect(classified.retryable).toBe(true);
  });

  it("classifies an opaque context-overflow code as context_overflow", () => {
    const classified = classifyVibeError(
      new AcpRpcError("opaque upstream fault", { code: CONTEXT_TOO_LONG, method: "session/prompt" }),
    );
    expect(classified.kind).toBe("context_overflow");
    expect(classified.code).toBe(CONTEXT_TOO_LONG);
    expect(classified.retryable).toBe(false);
  });

  it("classifies 429 and rate-limit text as rate_limit", () => {
    expect(classifyVibeError(new Error("RESOURCE_EXHAUSTED (code 429): too many requests")).kind).toBe("rate_limit");
    expect(classifyVibeError(new Error("rate-limit hit")).kind).toBe("rate_limit");
    expect(classifyVibeError(new Error("Rate limit exceeded")).kind).toBe("rate_limit");
  });

  it("classifies quota text as non-retryable with an actionable message", () => {
    for (const message of [
      "usage_limit reached",
      "quota exhausted",
      "credit balance low",
      "billing error",
      "402 payment required",
      "allowance exhausted",
      "budget exhausted for this plan",
    ]) {
      const classified = classifyVibeError(new Error(message));
      expect(classified.kind).toBe("quota_limit");
      expect(classified.retryable).toBe(false);
      expect(classified.message).toContain("Vibe allowance");
      expect(classified.message).toContain("/vibe-status");
    }
  });

  it("never conflates quota_limit with rate_limit or context_overflow", () => {
    const quota = classifyVibeError(rpcError(INTERNAL_ERROR, "usage_limit quota exhausted"));
    expect(quota.kind).toBe("quota_limit");
    expect(quota.kind).not.toBe("rate_limit");
    expect(quota.kind).not.toBe("context_overflow");
    const rate = classifyVibeError(new Error("rate limit exceeded"));
    expect(rate.kind).not.toBe("quota_limit");
    expect(rate.kind).not.toBe("context_overflow");
  });

  it("classifies overflow by code and by text as non-retryable", () => {
    expect(classifyVibeError(rpcError(CONTEXT_TOO_LONG, "context too long")).kind).toBe("context_overflow");
    expect(classifyVibeError(new Error("prompt is too long: 210000 tokens")).kind).toBe("context_overflow");
    expect(classifyVibeError(new Error("context window exceeded")).kind).toBe("context_overflow");
    expect(classifyVibeError(new Error("Context too long for mistral-large-4-0")).kind).toBe("context_overflow");
    const classified = classifyVibeError(new Error("prompt is too long"));
    expect(classified.retryable).toBe(false);
  });

  it("classifies compaction, auth, image and refusal by code", () => {
    expect(classifyVibeError(rpcError(COMPACTION_FAILED, "compaction failed")).kind).toBe("compaction_failed");
    expect(classifyVibeError(rpcError(UNAUTHENTICATED, "unauthenticated")).kind).toBe("auth");
    expect(classifyVibeError(new Error("invalid API key")).kind).toBe("auth");
    expect(classifyVibeError(new Error("missing API key; sign in first")).kind).toBe("auth");
    expect(classifyVibeError(rpcError(INVALID_IMAGE_ATTACHMENT, "bad image")).kind).toBe("image");
    expect(classifyVibeError(rpcError(IMAGES_NOT_SUPPORTED, "images not supported")).kind).toBe("image");
    expect(classifyVibeError(rpcError(REFUSAL, "refused by policy")).kind).toBe("refusal");
  });

  it("classifies a signal kill and a process exit distinctly", () => {
    expect(classifyVibeError(new Error("vibe-acp was killed (signal SIGKILL)")).kind).toBe("signal_kill");
    expect(classifyVibeError(new Error("vibe-acp exited (2) before answering")).kind).toBe("exit");
  });

  it("maps configuration and conversation-limit codes to internal and exposes the documented codes", () => {
    expect(CONFIGURATION_ERROR).toBe(-31002);
    expect(CONVERSATION_LIMIT).toBe(-31003);
    expect(INTERNAL_ERROR).toBe(-32603);
    expect(classifyVibeError(rpcError(CONFIGURATION_ERROR, "bad config")).kind).toBe("internal");
    expect(classifyVibeError(rpcError(INTERNAL_ERROR, "boom")).kind).toBe("internal");
  });

  it("formats errors as an actionable string", () => {
    expect(formatVibeError(new Error("quota exhausted"))).toContain("/vibe-status");
    expect(formatVibeError(rpcError(RATE_LIMITED, "rate limit"))).toContain("rate limit");
    expect(formatVibeError("plain failure")).toContain("plain failure");
  });
});

describe("overflow rewriting", () => {
  const PROVIDER = "mistral-vibe";

  it("recognizes the supported overflow phrasings", () => {
    expect(isOverflowError("prompt is too long: 210000 tokens")).toBe(true);
    expect(isOverflowError("context window exceeded")).toBe(true);
    expect(isOverflowError("Context too long for mistral-large-4-0")).toBe(true);
    expect(isOverflowError(`${OVERFLOW_PREFIX}: prompt is too long`)).toBe(false);
  });

  it("never matches rate limit or quota phrasing", () => {
    expect(isOverflowError("RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).")).toBe(false);
    expect(isOverflowError("usage_limit quota exhausted")).toBe(false);
    expect(isOverflowError("rate limit exceeded")).toBe(false);
    expect(isOverflowError("billing allowance exhausted")).toBe(false);
  });

  it("rewrites an overflow assistant error for its own provider", () => {
    const rewritten = rewriteOverflowMessage(
      { role: "assistant", provider: PROVIDER, stopReason: "error", errorMessage: "prompt is too long" },
      PROVIDER,
    );
    expect(rewritten?.message.errorMessage).toBe(`${OVERFLOW_PREFIX}: prompt is too long`);
  });

  it("never rewrites rate limit or quota errors", () => {
    expect(
      rewriteOverflowMessage(
        { role: "assistant", provider: PROVIDER, stopReason: "error", errorMessage: "rate limit exceeded" },
        PROVIDER,
      ),
    ).toBeUndefined();
    expect(
      rewriteOverflowMessage(
        { role: "assistant", provider: PROVIDER, stopReason: "error", errorMessage: "usage_limit quota exhausted" },
        PROVIDER,
      ),
    ).toBeUndefined();
  });

  it("leaves non-error and foreign providers alone", () => {
    expect(
      rewriteOverflowMessage(
        { role: "assistant", provider: PROVIDER, stopReason: "stop", errorMessage: "prompt is too long" },
        PROVIDER,
      ),
    ).toBeUndefined();
    expect(
      rewriteOverflowMessage(
        { role: "assistant", provider: "other", stopReason: "error", errorMessage: "prompt is too long" },
        PROVIDER,
      ),
    ).toBeUndefined();
  });
});

describe("typed ACP beats marker text", () => {
  it("AcpRpcError CONTEXT_TOO_LONG with signal-like text classifies as context_overflow and sanitizes", () => {
    const err = new AcpRpcError("killed (signal simulated)" + String.fromCharCode(27) + "[31m AUDIT_MARKER", { code: CONTEXT_TOO_LONG, method: "session/prompt" });
    const classified = classifyVibeError(err);
    expect(classified.kind).toBe("context_overflow");
    expect(classified.kind).not.toBe("signal_kill");
    expect(classified.code).toBe(CONTEXT_TOO_LONG);
    expect(classified.retryable).toBe(false);
    const formatted = formatVibeError(err);
    expect(formatted).toContain("context_length_exceeded");
    expect(formatted.includes(String.fromCharCode(27))).toBe(false);
  });

  it("AcpRpcError INTERNAL_ERROR with signal-like prose classifies as internal, not signal_kill, and formatVibeError strips ASCII controls", () => {
    const err = new AcpRpcError("killed (signal simulated)" + String.fromCharCode(27) + "[31m PROSE", { code: INTERNAL_ERROR, method: "session/prompt" });
    const classified = classifyVibeError(err);
    expect(classified.kind).toBe("internal");
    expect(classified.kind).not.toBe("signal_kill");
    expect(classified.code).toBe(INTERNAL_ERROR);
    expect(classified.code).toBe(-32603);
    const formatted = formatVibeError(err);
    expect(formatted).toContain("-32603");
    expect(formatted).toContain("Mistral Vibe ACP error");
    expect(/[\x00-\x1f\x7f]/.test(formatted)).toBe(false);
  });
});

describe("review3 process-exit provenance (Finding 3)", () => {
  it("VibeProcessExitError with overflow stderr never classifies as overflow", () => {
    const err = new VibeProcessExitError({ code: null, signal: "SIGKILL", stderr: "previous diagnostic: context window exceeded\n" });
    expect(err.message).toBe("vibe-acp was killed (signal SIGKILL)");
    expect(err.message).not.toMatch(/context/i);
    expect((err as any).signal).toBe("SIGKILL");
    expect((err as any).exitCode).toBe(null);
    expect((err as any).stderrDiagnostic).toContain("previous diagnostic: context window exceeded");
    expect(/[\x00-\x1f\x7f]/.test((err as any).stderrDiagnostic)).toBe(false);
    const classified: any = classifyVibeError(err);
    expect(classified.kind).toBe("signal_kill");
    expect(classified.kind).not.toBe("context_overflow");
    expect(classified.message).toBe("vibe-acp was killed (signal SIGKILL)");
    expect(classified.stderrDiagnostic).toContain("previous diagnostic: context window exceeded");
    expect(classified.exitCode).toBe(null);
    expect(classified.signal).toBe("SIGKILL");
    const formatted = formatVibeError(err);
    expect(formatted).toBe("vibe-acp was killed (signal SIGKILL)");
    expect(formatted).not.toMatch(/context/i);
    expect(isOverflowError(formatted)).toBe(false);
    expect(isOverflowError(err.message)).toBe(false);
    expect(isOverflowError(classified.message)).toBe(false);
    const asOutput: any = { role: "assistant", provider: "mistral-vibe", stopReason: "error", errorMessage: formatted, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    expect(isContextOverflow(asOutput)).toBe(false);
    expect(rewriteOverflowMessage({ role: "assistant", provider: "mistral-vibe", stopReason: "error", errorMessage: formatted } as any, "mistral-vibe", "mistral-vibe")).toBeUndefined();
  });

  it("VibeProcessExitError exit without signal is exit and never overflow", () => {
    const err = new VibeProcessExitError({ code: 3, signal: null, stderr: "boom\ncontext window exceeded" });
    expect(err.message).toBe("vibe-acp exited unexpectedly with code 3");
    expect(err.message).not.toMatch(/context/i);
    const classified: any = classifyVibeError(err);
    expect(classified.kind).toBe("exit");
    expect(classified.kind).not.toBe("context_overflow");
    expect(classified.message).toBe("vibe-acp exited unexpectedly with code 3");
    expect(classified.stderrDiagnostic).toContain("context window exceeded");
    expect(classified.exitCode).toBe(3);
    expect(classified.signal).toBe(null);
    expect(formatVibeError(err)).toBe("vibe-acp exited unexpectedly with code 3");
    expect(isOverflowError(formatVibeError(err))).toBe(false);
  });

  it("generic process-exit string with overflow stderr strips stderr and never overflows", () => {
    const raw = new Error("vibe-acp was killed (signal SIGKILL): [untrusted vibe-acp stderr: previous diagnostic: context window exceeded]");
    const classified: any = classifyVibeError(raw);
    expect(classified.kind).toBe("signal_kill");
    expect(classified.kind).not.toBe("context_overflow");
    expect(classified.message).toBe("vibe-acp was killed (signal SIGKILL)");
    expect(classified.stderrDiagnostic).toContain("previous diagnostic: context window exceeded");
    expect(formatVibeError(raw)).toBe("vibe-acp was killed (signal SIGKILL)");
    const formatted = formatVibeError(raw);
    expect(isOverflowError(classified.message)).toBe(false);
    const asOutput: any = { role: "assistant", provider: "mistral-vibe", stopReason: "error", errorMessage: formatted, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    expect(isContextOverflow(asOutput)).toBe(false);
    expect(rewriteOverflowMessage({ role: "assistant", provider: "mistral-vibe", stopReason: "error", errorMessage: formatted } as any, "mistral-vibe", "mistral-vibe")).toBeUndefined();
  });

  it("process-exit guards in isOverflowError and rewriteOverflowMessage", () => {
    expect(isOverflowError("vibe-acp was killed (signal SIGKILL): context window exceeded")).toBe(false);
    expect(isOverflowError("vibe-acp exited (2) before answering: context window exceeded")).toBe(false);
    expect(isOverflowError("vibe-acp exited unexpectedly with code 3: context window exceeded")).toBe(false);
    expect(isOverflowError("vibe-acp exited with code 3: context window exceeded")).toBe(false);
    expect(rewriteOverflowMessage({ role: "assistant", provider: "mistral-vibe", stopReason: "error", errorMessage: "prompt is too long", processExit: { kind: "signal_kill" } } as any, "mistral-vibe", "mistral-vibe")).toBeUndefined();
  });
});
