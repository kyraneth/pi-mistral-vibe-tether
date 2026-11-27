import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MCP_SERVER_NAME,
  sessionMcpServer,
  writeToolSchema,
} from "../src/mcp-config.js";
import {
  handoffSecretFile,
  registerHandoffTarget,
  startHandoffBroker,
  stopHandoffBroker,
  unregisterHandoffTarget,
} from "../src/handoff-broker.js";
import { cleanupRuntimeDir, resetRuntimeDirForTests } from "../src/runtime-dir.js";

const SERVER_PATH = fileURLToPath(
  new URL("../src/mcp-schema-server.cjs", import.meta.url),
);

const SESSION_ID = "mcp-handoff-session";
const TOOLS = [
  {
    name: "allowed_tool",
    description: "A tool Pi declared for this session",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
];

interface JsonRpcResponse {
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

function startMcpServer(
  toolsPath: string,
  socketPath: string,
  sessionId: string,
  secretPath: string,
): {
  child: ChildProcessWithoutNullStreams;
  request: (id: number, method: string, params?: unknown) => Promise<JsonRpcResponse>;
  stop: () => Promise<void>;
} {
  const child = spawn(process.execPath, [
    SERVER_PATH,
    toolsPath,
    socketPath,
    sessionId,
    secretPath,
  ]);
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        const message = JSON.parse(line) as JsonRpcResponse;
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  return {
    child,
    request(id, method, params) {
      return new Promise<JsonRpcResponse>((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`,
        );
      });
    },
    async stop() {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
        setTimeout(resolve, 2000).unref();
      });
    },
  };
}

describe("schema-only MCP server + handoff broker", () => {
  let brokerSocket = "";
  let server: ReturnType<typeof startMcpServer> | undefined;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    resetRuntimeDirForTests();
    brokerSocket = await startHandoffBroker();
    registerHandoffTarget(
      SESSION_ID,
      {
        onHandoffCall(invocation) {
          invocation.respond({
            content: [{ type: "text", text: `ran:${invocation.name}` }],
          });
        },
      },
      ["allowed_tool"],
    );
    const toolsPath = writeToolSchema(SESSION_ID, TOOLS);
    server = startMcpServer(
      toolsPath,
      brokerSocket,
      SESSION_ID,
      handoffSecretFile(),
    );
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    unregisterHandoffTarget(SESSION_ID);
    await stopHandoffBroker();
    cleanupRuntimeDir();
    resetRuntimeDirForTests();
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort test cleanup */
      }
    }
  });

  it("answers initialize with the tether server identity", async () => {
    const response = await server!.request(1, "initialize");
    expect(response.error).toBeUndefined();
    expect(response.result.protocolVersion).toBe("2024-11-05");
    expect(response.result.serverInfo.name).toBe(
      "pi-mistral-vibe-tether-tools",
    );
    expect(typeof response.result.serverInfo.version).toBe("string");
    expect(response.result.serverInfo.version.length).toBeGreaterThan(0);
  });

  it("advertises exactly the staged Pi tools", async () => {
    const response = await server!.request(2, "tools/list");
    expect(response.error).toBeUndefined();
    expect(response.result.tools).toEqual(TOOLS);
  });

  it("proxies an authorized tools/call to Pi and returns its result", async () => {
    const response = await server!.request(3, "tools/call", {
      name: "allowed_tool",
      arguments: { query: "hello" },
    });
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBeFalsy();
    expect(response.result.content).toEqual([
      { type: "text", text: "ran:allowed_tool" },
    ]);
  });

  it("rejects a tool name Pi did not declare for the session", async () => {
    const response = await server!.request(4, "tools/call", {
      name: "undeclared_tool",
      arguments: {},
    });
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    const text = response.result.content[0]?.text ?? "";
    expect(text).toMatch(/not declared/i);
  });

  it("answers ping, and rejects calls carrying a wrong secret", async () => {
    const ping = await server!.request(5, "ping");
    expect(ping.error).toBeUndefined();
    expect(ping.result).toEqual({});

    const wrongSecretDir = mkdtempSync(join(tmpdir(), "t-wrong-secret-"));
    tempDirs.push(wrongSecretDir);
    const wrongSecretPath = join(wrongSecretDir, "secret");
    writeFileSync(wrongSecretPath, "wrong-secret-value", { mode: 0o600 });
    const toolsPath = writeToolSchema(SESSION_ID, TOOLS);
    const impostor = startMcpServer(
      toolsPath,
      brokerSocket,
      SESSION_ID,
      wrongSecretPath,
    );
    try {
      const rejected = await impostor.request(6, "tools/call", {
        name: "allowed_tool",
        arguments: {},
      });
      expect(rejected.error).toBeUndefined();
      expect(rejected.result.isError).toBe(true);
      const text = rejected.result.content[0]?.text ?? "";
      expect(text).toMatch(/unauthorized/i);
    } finally {
      await impostor.stop();
    }
  });
});

describe("session MCP server staging", () => {
  it("builds the mcpServers entry with an array env", () => {
    expect(MCP_SERVER_NAME).toBe("pi");
    const serverEntry = sessionMcpServer({
      toolsPath: "/tmp/tools.json",
      socketPath: "/tmp/handoff.sock",
      sessionId: "sess-1",
      secretPath: "/tmp/secret",
    });
    expect(serverEntry.name).toBe("pi");
    expect(serverEntry.command).toBe(process.execPath);
    expect(serverEntry.args[0]).toContain("mcp-schema-server.cjs");
    expect(serverEntry.args[1]).toBe("/tmp/tools.json");
    expect(serverEntry.args[2]).toBe("/tmp/handoff.sock");
    expect(serverEntry.args[3]).toBe("sess-1");
    expect(serverEntry.args[4]).toBe("/tmp/secret");
    expect(Array.isArray(serverEntry.env)).toBe(true);
    expect(serverEntry.env).toEqual([]);
  });
});
