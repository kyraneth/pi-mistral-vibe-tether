/**
 * Pi's side of the tool handoff.
 *
 * ACP client → MCP `tools/call` → schema-only server
 * (src/mcp-schema-server.cjs) → this broker's socket → the provider, which
 * surfaces a normal Pi `toolCall`. Pi executes the tool and returns the result
 * to the same blocked MCP call, so the ACP turn continues in-process instead of
 * being restarted with a partial transcript.
 *
 * The socket lives in this process's private 0700 runtime directory and every
 * request must carry a 256-bit secret compared in constant time: anything that
 * can reach the socket could otherwise ask Pi to run a tool.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { secretMatches } from "pi-tether-core/security";
import { acceptInvocation } from "pi-tether-core/socket-transport";
import { RUNTIME_FILE_MODE, runtimeFile } from "./runtime-dir.js";

export interface HandoffResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface HandoffInvocation {
  /** Pi-side tool call id; the same id the assistant message carries. */
  piCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Answer the blocked MCP call. Safe once; later calls are ignored. */
  respond(result: HandoffResult): void;
}

export interface HandoffTarget {
  onHandoffCall(invocation: HandoffInvocation): void;
}

const targets = new Map<string, { target: HandoffTarget; names: ReadonlySet<string> }>();
const openSockets = new Set<Socket>();
let server: Server | undefined;
let socketPath: string | undefined;
let secretPath: string | undefined;
let starting: Promise<string> | undefined;
let secret: string | undefined;

export function registerHandoffTarget(
  sessionId: string,
  target: HandoffTarget,
  names: readonly string[],
): void {
  targets.set(sessionId, { target, names: new Set(names) });
}

export function unregisterHandoffTarget(sessionId: string): void {
  targets.delete(sessionId);
}

export function handoffSecretFile(): string {
  if (!secretPath) throw new Error("handoff broker has not started");
  return secretPath;
}

function errorResult(text: string): HandoffResult {
  return { content: [{ type: "text", text }], isError: true };
}

function handle(socket: Socket): void {
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
  acceptInvocation<HandoffResult>(socket, (line, finish) => {
    let answered = false;
    const done = (result: HandoffResult) => {
      if (answered) return;
      answered = true;
      finish(result);
    };
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      done(errorResult("Malformed invocation"));
      return;
    }
    if (!secretMatches(secret ?? "", message?.secret)) {
      done(errorResult("Unauthorized invocation"));
      return;
    }
    if (message?.type !== "call") {
      done(errorResult("Invalid invocation"));
      return;
    }
    const binding = typeof message.session === "string" ? targets.get(message.session) : undefined;
    if (!binding) {
      done(errorResult("Pi is not attached to this session; tool not executed"));
      return;
    }
    const name = message.name;
    const args = message.arguments;
    if (typeof name !== "string" || !name || !args || typeof args !== "object" || Array.isArray(args)) {
      done(errorResult("Invalid tool invocation"));
      return;
    }
    if (!binding.names.has(name)) {
      done(errorResult("Tool not declared for this Pi session; tool not executed"));
      return;
    }
    binding.target.onHandoffCall({
      piCallId: randomUUID(),
      name,
      arguments: args,
      respond: done,
    });
  });
}

/** Start once; later calls return the same socket path. */
export function startHandoffBroker(): Promise<string> {
  if (starting) return starting;
  starting = (async () => {
    secret = randomBytes(32).toString("hex");
    socketPath = runtimeFile("handoff.sock");
    secretPath = runtimeFile("handoff.secret");
    writeFileSync(secretPath, secret, { mode: RUNTIME_FILE_MODE });
    chmodSync(secretPath, RUNTIME_FILE_MODE);
    const srv = createServer(handle);
    server = srv;
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(socketPath, () => {
        srv.removeListener("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    srv.unref();
    return socketPath;
  })();
  return starting;
}

export async function stopHandoffBroker(): Promise<void> {
  for (const socket of openSockets) {
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  }
  openSockets.clear();
  targets.clear();
  const srv = server;
  const path = socketPath;
  server = undefined;
  starting = undefined;
  if (srv?.listening) await new Promise<void>((resolve) => srv.close(() => resolve()));
  if (path) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

/** Test seam. */
export function brokerSocketPath(): string | undefined {
  return socketPath;
}
