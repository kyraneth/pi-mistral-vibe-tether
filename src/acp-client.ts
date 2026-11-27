/**
 * The ACP (Agent Client Protocol) client for `vibe-acp`.
 *
 * The official client speaks JSON-RPC 2.0 over stdio. This module owns one
 * process connection: request/response correlation, `session/update`
 * notifications, retry notifications, and the server-initiated
 * `session/request_permission` request. It has no retry policy, no deadlines
 * and no interpretation of the content; the provider decides what a turn means.
 */

import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { isResponse, isServerRequest, parseFrame } from "./stream-parser.js";

/** An ACP error frame, preserving the server code and payload for classification. */
export class AcpRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  readonly method: string;

  constructor(message: string, options: { code?: number; data?: unknown; method: string }) {
    super(message);
    this.name = "AcpRpcError";
    this.code = options.code;
    this.data = options.data;
    this.method = options.method;
  }
}

export interface AcpHandlers {
  /** A `session/update` notification, already unwrapped. */
  onUpdate(update: any, params: any): void;
  /**
   * ACP asks the client whether the model may run one tool call. The answer is
   * the client's authority decision; the provider owns it.
   */
  onPermissionRequest(params: any): { outcome: "allowed" | "denied" } | Promise<{ outcome: "allowed" | "denied" }>;
  /** A `_session/retrying` notification: the server is retrying the turn. */
  onRetrying?(params: any): void;
  /** Protocol faults that no request is waiting for (bad frame, unknown method). */
  onDiagnostic(message: string, level: "warn" | "error"): void;
}

const { name, version } = createRequire(import.meta.url)("../package.json") as { name: string; version: string };
export const CLIENT_INFO = { name, version } as const;

/** ACP wire capability set: this client reads and writes Pi's side only. */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; method: string }
  >();
  private readonly rl;
  private disposed = false;

  constructor(
    readonly proc: ChildProcess,
    private readonly handlers: AcpHandlers,
  ) {
    this.rl = createInterface({ input: proc.stdout! });
    this.rl.on("line", (line) => this.onLine(line));
    proc.stdin?.on("error", () => {
      /* the exit handler owns the diagnostic */
    });
    // A process that dies mid-request must reject every waiter, not hang them.
    proc.once("exit", (code, signal) =>
      this.dispose(
        signal ? `vibe-acp was killed (signal ${signal})` : `vibe-acp exited (${code ?? "unknown"}) before answering`,
      ),
    );
    proc.once("error", (error) => this.dispose(`vibe-acp failed: ${error.message}`));
  }

  request(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<any> {
    if (this.disposed) return Promise.reject(new Error("ACP connection closed"));
    if (options?.signal?.aborted) {
      return Promise.reject(new Error(`ACP request ${method} aborted`));
    }
    const id = this.nextId++;
    const signal = options?.signal;
    return new Promise((resolve, reject) => {
      let settled = false;
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      const settleResolve = (value: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      onAbort = () => {
        this.pending.delete(id);
        settleReject(new Error(`ACP request ${method} aborted`));
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      this.pending.set(id, { resolve: settleResolve, reject: settleReject, method });
      this.write({ jsonrpc: "2.0", id, method, params }, (error) => {
        this.pending.delete(id);
        settleReject(error);
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private record(dir: "out" | "in", message: unknown): void {
    const target = process.env.PI_MISTRAL_VIBE_TETHER_DUMP;
    if (!target) return;
    try {
      appendFileSync(`${target}/frames.jsonl`, `${JSON.stringify({ dir, message })}\n`);
    } catch {
      /* diagnostic only */
    }
  }

  private write(message: unknown, onWriteError?: (error: Error) => void): void {
    if (this.disposed) return;
    this.record("out", message);
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      const reason = !stdin ? "stdin is unavailable" : stdin.destroyed ? "stdin is destroyed" : "stdin is not writable";
      const error = new Error(`vibe-acp stdin write failed: ${reason}`);
      this.handlers.onDiagnostic(`vibe-acp stdin write failed: ${reason}`, "error");
      onWriteError?.(error);
      return;
    }
    try {
      const data = `${JSON.stringify(message)}\n`;
      stdin.write(data, (error?: Error | null) => {
        if (error) {
          this.handlers.onDiagnostic(`vibe-acp stdin write failed: ${error.message}`, "error");
          onWriteError?.(error);
        }
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.handlers.onDiagnostic(`vibe-acp stdin write failed: ${err.message}`, "error");
      onWriteError?.(err);
    }
  }

  private onLine(line: string): void {
    try {
      this.record("in", JSON.parse(line));
    } catch {
      this.record("in", { raw: line });
    }
    const frame = parseFrame(line);
    if ("fault" in frame) {
      this.handlers.onDiagnostic(`vibe-acp ACP frame: ${frame.fault}`, "warn");
      return;
    }
    if (isResponse(frame)) {
      const id = Number(frame.id);
      const waiter = this.pending.get(id);
      if (!waiter) {
        this.handlers.onDiagnostic(`vibe-acp answered unknown request id ${frame.id}`, "warn");
        return;
      }
      this.pending.delete(id);
      if (frame.error) {
        const message =
          typeof frame.error.message === "string" ? frame.error.message : "ACP request failed";
        waiter.reject(
          new AcpRpcError(message, {
            code: frame.error.code,
            data: frame.error.data,
            method: waiter.method,
          }),
        );
      } else {
        waiter.resolve(frame.result ?? {});
      }
      return;
    }
    if (isServerRequest(frame)) {
      this.answer(frame as { id: number | string; method: string; params?: any });
      return;
    }
    if (frame.method === "session/update") {
      this.handlers.onUpdate(frame.params?.update, frame.params);
      return;
    }
    if (frame.method === "_session/retrying") {
      this.handlers.onRetrying?.(frame.params);
      return;
    }
    // A notification this client does not subscribe to is not turn content.
    this.handlers.onDiagnostic(
      `vibe-acp ACP notification ${String(frame.method)} ignored`,
      "warn",
    );
  }

  private answer(request: { id: number | string; method: string; params?: any }): void {
    if (request.method === "session/request_permission") {
      void Promise.resolve(this.handlers.onPermissionRequest(request.params))
        .then((decision) => {
          if (decision.outcome === "allowed") {
            const optionId = this.allowOption(request.params);
            if (!optionId) {
              this.handlers.onDiagnostic(
                "vibe-acp requested permission without an allow_once option; denying",
                "warn",
              );
              this.write({
                jsonrpc: "2.0",
                id: request.id,
                result: { outcome: { outcome: "cancelled" } },
              });
              return;
            }
            this.write({
              jsonrpc: "2.0",
              id: request.id,
              result: { outcome: { outcome: "selected", optionId } },
            });
            return;
          }
          this.write({ jsonrpc: "2.0", id: request.id, result: { outcome: { outcome: "cancelled" } } });
        })
        .catch(() => {
          this.write({
            jsonrpc: "2.0",
            id: request.id,
            result: { outcome: { outcome: "cancelled" } },
          });
        });
      return;
    }
    this.handlers.onDiagnostic(`vibe-acp requested unsupported client method ${request.method}`, "warn");
    this.write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Pi tether does not implement this client method" },
    });
  }

  /** The `allow_once` option the server actually offered, by id. */
  private allowOption(params: any): string | undefined {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const option = options.find((o) => o?.kind === "allow_once");
    return typeof option?.optionId === "string" && option.optionId.length > 0 ? option.optionId : undefined;
  }

  /** Reject every outstanding request: the connection is gone. */
  dispose(reason = "ACP connection closed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rl.close();
    for (const [, waiter] of this.pending) waiter.reject(new Error(reason));
    this.pending.clear();
  }
}
