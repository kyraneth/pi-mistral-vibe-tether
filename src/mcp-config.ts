/**
 * Staging for the schema-only MCP server the ACP client is given.
 *
 * The client never runs Pi's tools itself. It gets one MCP server named `pi`
 * whose `tools/list` is exactly the tools Pi's current request carries and
 * whose `tools/call` blocks on the local broker until Pi has executed the
 * tool. The schema is written per ACP session so two Pi sessions in one
 * process can never advertise each other's tool surface.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existingSessionDir, sessionDir } from "./data-dir.js";
import { removeTreeSync } from "./runtime-dir.js";

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** One MCP server entry in the shapes the ACP `session/new` request accepts. */
export interface AcpMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export const MCP_SERVER_NAME = "pi";

const SERVER_PATH = fileURLToPath(
  new URL("./mcp-schema-server.cjs", import.meta.url),
);

export function writeToolSchema(
  sessionId: string,
  tools: readonly ToolDefinition[],
  baseDir?: string,
): string {
  if (baseDir && baseDir.endsWith(".json")) {
    mkdirSync(dirname(baseDir), { recursive: true, mode: 0o700 });
    writeFileSync(baseDir, JSON.stringify(tools, null, 1), { mode: 0o600 });
    return baseDir;
  }
  const dir = baseDir ?? sessionDir(sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "tools.json");
  writeFileSync(path, JSON.stringify(tools, null, 1), { mode: 0o600 });
  return path;
}

/** The `mcpServers` entry handed to `session/new`. */
export function sessionMcpServer(input: {
  toolsPath: string;
  socketPath: string;
  sessionId: string;
  secretPath: string;
}): AcpMcpServerStdio {
  return {
    name: MCP_SERVER_NAME,
    command: process.execPath,
    args: [
      SERVER_PATH,
      input.toolsPath,
      input.socketPath,
      input.sessionId,
      input.secretPath,
    ],
    env: [],
  };
}

export function removeSessionFiles(sessionId: string): void {
  const dir = existingSessionDir(sessionId);
  if (!dir) return;
  try {
    removeTreeSync(dir);
  } catch {
    /* leftover staging is inert; the next spawn uses a fresh directory */
  }
}
