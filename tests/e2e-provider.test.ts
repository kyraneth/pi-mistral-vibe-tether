/**
 * End-to-end provider tests over a realistic fake `vibe-acp` (real ACP
 * JSON-RPC over stdio) for all ten provider scenarios, plus unit coverage of
 * the new provider modules. The fake speaks real ACP and, for tool-call
 * scenarios, spawns the real `src/mcp-schema-server.cjs` over stdio.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once as observeFixtureExit } from "node:events";

/* ---- new provider modules under test ---- */
import {
  VIBE_MAX_PROMPT_IMAGES,
  VIBE_MAX_REQUEST_IMAGES,
  VIBE_SLASH_COMMANDS,
  countBlockImages,
  countImages,
  guardLeadingSlashCommand,
  hasOlderImages,
  hasPromptBlockSeparation,
  hasThinkingBlocks,
  hasWarmImageWindowOverflow,
  historyHash,
  piContext,
  replayPiMessages,
} from "../src/pi-context.js";
import { AcpRpcError } from "../src/acp-client.js";
import { formatVibeError, sanitizeUntrustedDiagnostic } from "../src/errors.js";
import {
  cliStatus,
  cliStatusLine,
  recordStatus,
  resetStatusForTests,
} from "../src/cli-status.js";
import {
  addStartupNotice,
  takeStartupNotices,
} from "../src/startup-notices.js";
import {
  activeCliProcessCount,
  getCliProcess,
  isAuthorizedPiTool,
  queryVibeAccountStatus,
  retireAllCliProcesses,
  retireCliProcess,
} from "../src/cli-process.js";
import { streamViaAcp } from "../src/provider.js";
import { DISCLOSURE_ENTRY_TYPE, rememberDisclosure, type DisclosureRecord } from "../src/degradations.js";
import * as degradationsModule from "../src/degradations.js";
const PERMANENT_ROUTE_FACTS: readonly string[] | undefined = (degradationsModule as any).PERMANENT_ROUTE_FACTS;

/* ---- existing modules used to arrange and assert ---- */
import { sessionVibeHome } from "../src/data-dir.js";
import { cleanupRuntimeDir, resetRuntimeDirForTests, runtimeDir } from "../src/runtime-dir.js";
import { resetDisclosuresForTests, STRICT_ENV } from "../src/degradations.js";
import { resetLoginFaultForTests } from "../src/login.js";
import { FALLBACK_MODELS, modelSpecFor, parseVibeCatalogCache, setVibeCatalog, vibeCatalog } from "../src/catalog.js";
import { readCachedCatalogWithAuthority } from "../src/model-discovery.js";
import { stopHandoffBroker } from "../src/handoff-broker.js";
import { OVERFLOW_PREFIX, rewriteOverflowMessage } from "../src/overflow.js";
import { isContextOverflow } from "@earendil-works/pi-ai";
import extensionDefault from "../index.js";

const MODEL: any = {
  id: "mistral-large-4-0",
  provider: "mistral-vibe",
  api: "mistral-vibe" as any,
  baseUrl: "pi-mistral-vibe-tether",
  input: ["text", "image"],
  cost: { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0.07 },
  reasoning: true,
  contextWindow: 384000,
  maxTokens: 262144,
  thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
};

const READ_TOOL: any = {
  name: "read",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const tempDirs: string[] = [];

function track<T extends string>(dir: T): T {
  tempDirs.push(dir);
  return dir;
}

function freshDir(prefix: string): string {
  return track(mkdtempSync(join(tmpdir(), prefix)));
}

function writeHostLogin(secret = "TOPSECRET-token-value-12345\n") {
  const home = process.env.PI_MISTRAL_VIBE_TETHER_SOURCE_VIBE_HOME!;
  writeFileSync(join(home, ".env"), secret);
  return home;
}

/* ------------------------------------------------------------------ */
/* Fake vibe-acp: real ACP JSON-RPC over stdio.                        */
/* ------------------------------------------------------------------ */

const FAKE_ACP_SCRIPT = String.raw`#!/usr/bin/env node
// Realistic fake vibe-acp for provider e2e tests.
// Speaks ACP JSON-RPC over stdio, spawns the real mcp-schema-server.cjs
// over stdio for tool-call scenarios, and logs every frame to FAKE_ACP_LOG.
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

const scenario = process.env.FAKE_ACP_SCENARIO || "chat";
const logPath = process.env.FAKE_ACP_LOG || (process.env.VIBE_HOME ? process.env.VIBE_HOME + "/fake-log.jsonl" : undefined);
function log(entry) {
  if (!logPath) return;
  try { fs.appendFileSync(logPath, JSON.stringify(entry) + "\n"); } catch {}
}
function send(obj) { log({ dir: "out", msg: obj }); process.stdout.write(JSON.stringify(obj) + "\n"); }

let sessionId = "acp-session-1";
let mcpServerEntry = undefined;
let turn = 0;
let serverSeq = 9000;
let configOptions = [
  { id: "agent", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "pi", name: "Pi" }] },
  { id: "mode", currentValue: "auto", options: [{ value: "ask", name: "Ask" }, { value: "auto", name: "Auto" }] },
  { id: "model", currentValue: "mistral-large-4-0", options: [{ value: "mistral-large-4-0", name: "Mistral Large 4.0" }, { value: "mistral-medium-latest", name: "Mistral Medium Latest" }] },
  { id: "thinking", currentValue: "low", options: [{ value: "off" }, { value: "low" }, { value: "medium" }, { value: "high" }] },
];
if (scenario === "readback-absent") {
  configOptions = configOptions.filter((o) => o.id !== "model" && o.id !== "thinking");
}
if (scenario === "mode-absent") {
  configOptions = configOptions.filter((o) => o.id !== "mode");
}
if (scenario === "agent-absent") {
  configOptions = configOptions.filter((o) => o.id !== "agent");
}
if (scenario === "review3-missing-final-thinking") {
  const t = configOptions.find((o) => o.id === "thinking");
  if (t) t.currentValue = "high";
}
let currentModeId = "auto";
const availableModes = [{ id: "ask", name: "Ask" }, { id: "auto", name: "Auto" }];

function sendUpdate(update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}
function usageFor() {
  if (turn <= 1) return { inputTokens: 1000, outputTokens: 100, cachedReadTokens: 200 };
  if (turn === 2) return { inputTokens: 2600, outputTokens: 260, cachedReadTokens: 1200 };
  return { inputTokens: 4000, outputTokens: 400, cachedReadTokens: 2000 };
}

const pendingServerRequests = new Map();
function serverRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = serverSeq++;
    pendingServerRequests.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

// MCP client over stdio to the real schema server.
function callMcpTool(entry, toolName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, { stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    const pending = new Map();
    let nextId = 1;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (line.trim()) {
          try {
            const m = JSON.parse(line);
            const p = pending.get(m.id);
            if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
          } catch {}
        }
        nl = buffer.indexOf("\n");
      }
    });
    const req = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    (async () => {
      await req("initialize", {});
      await req("tools/list", {});
      const result = await req("tools/call", { name: toolName, arguments: args });
      child.kill();
      resolve(result);
    })().catch((e) => { try { child.kill(); } catch {} reject(e); });
  });
}

async function handlePrompt(id, params) {
  turn += 1;
  const promptBlocks = params.prompt || [];
  log({ dir: "prompt", turn, blocks: promptBlocks });
  if (scenario === "review3-kill-with-stderr") {
    fs.writeSync(2,"previous diagnostic: context window exceeded\n");
    process.kill(process.pid,"SIGKILL");
    return;
  }
  if (scenario === "kill") {
    // Die by signal with no answer, exactly like a killed process.
    process.kill(process.pid, "SIGKILL");
    return;
  }
  if (scenario === "ratelimit") {
    send({ jsonrpc: "2.0", id, error: { code: -31001, message: "rate limit exceeded", data: { provider: "vibe", model: "mistral-large-4-0" } } });
    return;
  }
  if (scenario === "quota") {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "usage_limit quota exhausted", data: {} } });
    return;
  }
  if (scenario === "overflow") {
    send({ jsonrpc: "2.0", id, error: { code: -31004, message: "prompt is too long: 500000 tokens", data: {} } });
    return;
  }
  if (scenario === "typed-rate") {
    send({ jsonrpc: "2.0", id, error: { code: -31001, message: "upstream busy", data: {} } });
    return;
  }
  if (scenario === "typed-overflow") {
    send({ jsonrpc: "2.0", id, error: { code: -31004, message: "upstream fault", data: {} } });
    return;
  }
  if (scenario === "fake-signal-text") {
    send({ jsonrpc: "2.0", id, error: { code: -31004, message: "killed (signal simulated)" + String.fromCharCode(27) + "[31m AUDIT_MARKER", data: {} } });
    return;
  }
  if (scenario === "context-only") {
    sendUpdate({ sessionUpdate: "usage_update", used: 650, size: 1000 });
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "context only answer" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "usage-then-error") {
    sendUpdate({ sessionUpdate: "usage_update", _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 } });
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "upstream fault", data: {} } });
    return;
  }
  if (scenario === "login-replaced") {
    try {
      const linkPath = process.env.VIBE_HOME + "/.env";
      try { fs.unlinkSync(linkPath); } catch {}
      fs.writeFileSync(linkPath, "replaced\n");
    } catch {}
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer after replacing login" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }
  if (scenario === "stderr-crash") {
    process.stderr.write("boom\x1b[31m\x07 hello\x00\x1f\x7f world \n\n more\x7f");
    process.exit(3);
    return;
  }
  if (scenario === "compaction") {
    sendUpdate({ sessionUpdate: "tool_call", toolCallId: "compact-1", title: "Compacting conversation history...", _meta: { checkpoint_kind: "compaction" } });
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer after compaction" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }
  if (scenario === "max-turn-requests") {
    send({ jsonrpc: "2.0", id, result: { stopReason: "max_turn_requests", usage: usageFor() } });
    return;
  }
  if (scenario === "permission") {
    // Two built-in requests (must be denied), then one Pi tool (must be allowed).
    const cases = [
      { callId: "call-1", toolName: "read_file" },
      { callId: "call-2", toolName: "bash" },
      { callId: "call-3", toolName: "mcp_pi.read" },
    ];
    for (const c of cases) {
      sendUpdate({ sessionUpdate: "tool_call", toolCallId: c.callId, _meta: { tool_name: c.toolName } });
      const ans = await serverRequest("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: c.callId, _meta: { tool_name: c.toolName } },
        options: [
          { optionId: "allow-1", kind: "allow_once", name: "Allow once" },
          { optionId: "deny-1", kind: "reject_once", name: "Deny once" },
        ],
      });
      log({ dir: "permission", callId: c.callId, toolName: c.toolName, answer: ans });
    }
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission done" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }
  if (scenario === "tool-with-usage" || scenario === "tool-with-usage-error") {
    sendUpdate({ sessionUpdate: "usage_update", _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 } });
    sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call-1", _meta: { tool_name: "mcp_pi.read" } });
    const ans = await serverRequest("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "call-1", _meta: { tool_name: "mcp_pi.read" } },
      options: [
        { optionId: "allow-1", kind: "allow_once", name: "Allow once" },
        { optionId: "deny-1", kind: "reject_once", name: "Deny once" },
      ],
    });
    log({ dir: "permission", callId: "call-1", toolName: "mcp_pi.read", answer: ans });
    const outcome = ans && ans.outcome && ans.outcome.outcome;
    let text = "tool done";
    if (outcome === "selected" && mcpServerEntry) {
      const result = await callMcpTool(mcpServerEntry, "read", { path: "sample.txt" });
      log({ dir: "mcp-result", result });
      const t = result && Array.isArray(result.content) ? result.content.map((c) => c.text || "").join("") : "";
      text = "tool result: " + t;
    }
    if (scenario === "tool-with-usage-error") {
      sendUpdate({ sessionUpdate: "usage_update", _meta: { promptTokens: 1000, completionTokens: 100, cachedTokens: 200 } });
      sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: "upstream fault", data: {} } });
      return;
    }
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }
  if (scenario === "tool") {
    // Ask permission for the Pi tool, then call it through the real MCP server.
    sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call-1", _meta: { tool_name: "mcp_pi.read" } });
    const ans = await serverRequest("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "call-1", _meta: { tool_name: "mcp_pi.read" } },
      options: [
        { optionId: "allow-1", kind: "allow_once", name: "Allow once" },
        { optionId: "deny-1", kind: "reject_once", name: "Deny once" },
      ],
    });
    log({ dir: "permission", callId: "call-1", toolName: "mcp_pi.read", answer: ans });
    const outcome = ans && ans.outcome && ans.outcome.outcome;
    let text = "tool done";
    if (outcome === "selected" && mcpServerEntry) {
      const result = await callMcpTool(mcpServerEntry, "read", { path: "sample.txt" });
      log({ dir: "mcp-result", result });
      const t = result && Array.isArray(result.content) ? result.content.map((c) => c.text || "").join("") : "";
      text = "tool result: " + t;
    }
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }
  // Default chat.
  sendUpdate({ sessionUpdate: "usage_update", used: usageFor().inputTokens + usageFor().outputTokens });
  const reply = "reply to: " + JSON.stringify(promptBlocks).slice(0, 400);
  sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: usageFor() } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  log({ dir: "in", msg });
  if (msg.method === undefined) {
    // A response to one of our server requests.
    const p = pendingServerRequests.get(msg.id);
    if (p) { pendingServerRequests.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message || "perm error")) : p.resolve(msg.result); }
    return;
  }
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === "session/cancel") log({ dir: "cancel", params: msg.params });
    return;
  }
  const id = msg.id;
  const params = msg.params || {};
  if (msg.method === "initialize") {
    if (scenario === "silent") return;
    send({ jsonrpc: "2.0", id, result: { agentInfo: { version: "3.1.5", name: "vibe" }, agentCapabilities: { promptCapabilities: { image: true } } } });
  } else if (msg.method === "session/new") {
    mcpServerEntry = (params.mcpServers && params.mcpServers[0]) || undefined;
    log({ dir: "session/new", cwd: params.cwd, mcpServers: params.mcpServers, hasMcp: !!mcpServerEntry });
    if (scenario === "workspace-mark") {
      const wsCwd = params.cwd || process.cwd();
      const vibeHome = process.env.VIBE_HOME;
      const marker = wsCwd + "/marker.txt";
      const existed = fs.existsSync(marker);
      log({ dir: "workspace", cwd: wsCwd, vibeHome, existed });
      try { fs.writeFileSync(marker, "mark\\n"); } catch {}
    }
    send({ jsonrpc: "2.0", id, result: { sessionId, configOptions, modes: { availableModes, currentModeId } } });
  } else if (msg.method === "session/set_config_option") {
    if (scenario === "review3-missing-final-snapshot" && params.configId === "model") {
      const lastConfirmed=configOptions.map(o=>[o.id, o.currentValue]);
      log({dir:"missing-final-snapshot", lastConfirmed, model:params.value});
      send({jsonrpc:"2.0", id, result:{}});
      return;
    }
    if (scenario === "review3-missing-final-thinking" && params.configId === "thinking") {
      const lastConfirmed=configOptions.map(o=>[o.id, o.currentValue]);
      log({dir:"missing-final-snapshot", lastConfirmed, thinking:params.value});
      send({jsonrpc:"2.0", id, result:{}});
      return;
    }
    if (scenario === "lost-authority" && params.configId === "model") {
      configOptions = configOptions.filter((o) => o.id !== "agent" && o.id !== "mode");
    }
    const opt = configOptions.find((o) => o.id === params.configId);
    if (opt) opt.currentValue = params.value;
    if (opt && params.configId === "model" && params.value === "deepseek-v4-1-flash-1017") {
      opt.options = [
        { value: "mistral-large-4-0", name: "Mistral Large 4.0" },
        { value: "mistral-medium-latest", name: "Mistral Medium Latest" },
        { value: "deepseek-v4-1-flash-1017", name: "DeepSeek V4.1 Flash" },
        { value: "mistral-medium-3.5", name: "Mistral Medium 3.5" },
        { value: "zai-glm-5-3", name: "GLM 5.3" },
        { value: "zai-glm-5-3-flash", name: "GLM 5.3 Flash" },
      ];
    }
    log({ dir: "set_config_option", configId: params.configId, value: params.value });
    send({ jsonrpc: "2.0", id, result: { configOptions } });
  } else if (msg.method === "session/set_mode") {
    log({ dir: "set_mode", modeId: params.modeId });
    if (scenario === "mode-refused") {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: "vibe-acp refused approval mode ask" } });
      return;
    }
    currentModeId = params.modeId;
    const modeOpt = configOptions.find((o) => o.id === "mode");
    if (modeOpt) modeOpt.currentValue = params.modeId;
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (msg.method === "session/prompt") {
    void handlePrompt(id, params);
  } else if (msg.method === "fixture/fence") {
    send({jsonrpc:"2.0", id, result:{}});
  } else if (msg.method === "_account/read") {
    if (scenario === "review3-half-status") {
      send({jsonrpc:"2.0", id, error:{code:-32601,message:"fixture method unsupported"}});
      return;
    }
    if (scenario === "silent-account") return;
    send({ jsonrpc: "2.0", id, result: { plan: { name: "Vibe EDU", title: "Vibe Education" }, budget: { usagePercentage: 42, resetAt: "2026-12-01T00:00:00Z", paygEnabled: false }, keyScope: "vibe:read", accessScope: "full" } });
  } else if (msg.method === "_identity/read") {
    if (scenario === "review3-half-status") return;
    if (scenario === "silent-account") return;
    send({ jsonrpc: "2.0", id, result: { workspace: "workspace-1", organization: "org-1", keyScope: "vibe:read", accessScope: "full" } });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported method " + msg.method } });
  }
});
process.on("SIGTERM", () => process.exit(0));
`;

function installFakeAcp(scenario: string) {
  const dir = freshDir("t-fake-acp-");
  const bin = join(dir, "vibe-acp");
  const log = join(dir, "fake-log.jsonl");
  writeFileSync(bin, FAKE_ACP_SCRIPT);
  chmodSync(bin, 0o755);
  process.env.PI_MISTRAL_VIBE_TETHER_CLI = bin;
  process.env.FAKE_ACP_SCENARIO = scenario;
  process.env.FAKE_ACP_LOG = log;
  return { bin, log, dir };
}

function readFakeLog(logPath: string): any[] {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, "utf8");
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* partial last line */ }
  }
  return entries;
}

interface Harness {
  notified: string[];
  ledger: DisclosureRecord[];
  notify: (m: string) => void;
  recordDisclosure: (e: DisclosureRecord) => void;
}

function harness(): Harness {
  const notified: string[] = [];
  const ledger: DisclosureRecord[] = [];
  return { notified, ledger, notify: (m) => notified.push(m), recordDisclosure: (e) => ledger.push(e) };
}

async function runTurn(model: any, context: any, opts: any): Promise<any> {
  const stream: any = streamViaAcp(model, context, opts);
  return await stream.result();
}

afterEach(async () => {
  delete process.env[STRICT_ENV];
  delete process.env.FAKE_ACP_SCENARIO;
  delete process.env.FAKE_ACP_LOG;
  delete process.env.PI_MISTRAL_VIBE_TETHER_CLI;
  await retireAllCliProcesses("test-cleanup");
  await stopHandoffBroker();
  cleanupRuntimeDir();
  resetRuntimeDirForTests();
  resetDisclosuresForTests();
  resetStatusForTests();
  resetLoginFaultForTests();
  setVibeCatalog(FALLBACK_MODELS);
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/* ================================================================== */
/* Unit coverage for the new provider modules                          */
/* ================================================================== */

describe("pi-context", () => {
  it("re-exports piContext from the core and formats replay blocks", () => {
    expect(typeof piContext).toBe("function");
    const blocks = replayPiMessages([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
          { type: "text", text: "doing it" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "file bytes" }],
      },
    ] as any);
    const texts = blocks.filter((b) => b.type === "text").map((b) => (b as any).text);
    expect(texts.some((t) => t.includes("USER:"))).toBe(true);
    expect(texts.some((t) => t.includes("ASSISTANT:"))).toBe(true);
    expect(texts.some((t) => t.includes("TOOL CALL read"))).toBe(true);
    expect(texts.some((t) => t.includes("TOOL RESULT (read"))).toBe(true);
    // Thinking is never replayed.
    expect(texts.some((t) => t.includes("secret reasoning"))).toBe(false);
  });

  it("hashes history with the projection hash", () => {
    const messages = [{ role: "user", content: "x" }];
    expect(historyHash(messages as any)).toMatch(/^[0-9a-f]{64}$/);
    expect(historyHash(messages as any)).toBe(historyHash(structuredClone(messages) as any));
  });

  it("detects older images only before the final user message", () => {
    const withOlderImage = [
      { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "text", text: "seen" }] },
      { role: "user", content: "follow up" },
    ];
    expect(hasOlderImages(withOlderImage as any)).toBe(true);
    const onlyCurrent = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
    ];
    expect(hasOlderImages(onlyCurrent as any)).toBe(false);
    const toolImageOlder = [
      { role: "toolResult", toolCallId: "c1", toolName: "snap", isError: false, content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
      { role: "user", content: "next" },
    ];
    expect(hasOlderImages(toolImageOlder as any)).toBe(true);
  });

  it("wraps leading slash commands and returns the matched command", () => {
    expect(VIBE_SLASH_COMMANDS).toEqual([
      "/help", "/compact", "/reload", "/log", "/mcp", "/proxy-setup", "/retry", "/leanstall", "/unleanstall", "/data-retention",
    ]);
    const wrapped = guardLeadingSlashCommand("/compact now please");
    expect(wrapped.matchedCommand).toBe("/compact");
    expect(wrapped.text).toBe("User message (literal text, not a Vibe command):\n/compact now please");
    expect(guardLeadingSlashCommand("  /HELP  ").matchedCommand).toBe("/help");
    expect(guardLeadingSlashCommand("/helpful tip").matchedCommand).toBeUndefined();
    expect(guardLeadingSlashCommand("hello /compact").matchedCommand).toBeUndefined();
    expect(guardLeadingSlashCommand("/compactness").matchedCommand).toBeUndefined();
    expect(guardLeadingSlashCommand("plain question").matchedCommand).toBeUndefined();
  });
});

describe("startup notices and cli status", () => {
  it("queues startup notices once and drains them", () => {
    addStartupNotice("first notice");
    addStartupNotice("first notice");
    addStartupNotice("second notice");
    expect(takeStartupNotices()).toEqual(["first notice", "second notice"]);
    expect(takeStartupNotices()).toEqual([]);
  });

  it("records and renders status, including account detail when present", () => {
    recordStatus({ binary: "/bin/vibe-acp", agentVersion: "3.1.5", agentName: "pi", offeredModels: ["m1"] });
    recordStatus({
      account: { planName: "Vibe EDU", planTitle: "Vibe Education", usagePercentage: 42, resetAt: "2026-12-01", paygEnabled: false, keyScope: "vibe:read", accessScope: "full", workspace: "ws", organization: "org" },
    });
    const s = cliStatus();
    expect(s.agentVersion).toBe("3.1.5");
    expect(s.account?.planName).toBe("Vibe EDU");
    const line = cliStatusLine();
    expect(line).toContain("3.1.5");
    expect(line).toContain("Vibe EDU");
    expect(line).toContain("42");
    expect(line).toContain(`route facts (log-only; set ${STRICT_ENV}=1 to refuse):`);
    expect(Array.isArray(PERMANENT_ROUTE_FACTS)).toBe(true);
    expect(PERMANENT_ROUTE_FACTS).toHaveLength(5);
    for (const fact of PERMANENT_ROUTE_FACTS ?? []) expect(line).toContain(fact);
    resetStatusForTests();
    expect(cliStatus()).toEqual({});
  });
});

describe("isAuthorizedPiTool", () => {
  const declared = new Set(["read"]);
  it("allows only Pi-declared tools in their MCP forms", () => {
    expect(isAuthorizedPiTool("pi_read", declared)).toBe(true);
    expect(isAuthorizedPiTool("pi.read", declared)).toBe(true);
    expect(isAuthorizedPiTool("pi_read", new Set(["read"])) ).toBe(true);
  });
  it("authorizes the sanitized MCP form for names with punctuation", () => {
    expect(isAuthorizedPiTool("pi_read_file", new Set(["read-file"]))).toBe(true);
    expect(isAuthorizedPiTool("pi_read-file", new Set(["read-file"]))).toBe(true);
  });
  it("always denies built-ins and undeclared names", () => {
    for (const name of ["read_file", "write_file", "edit", "bash", "grep", "glob", "web_fetch", "skill", "task", "run_typescript", "search_tool_functions"]) {
      expect(isAuthorizedPiTool(name, declared)).toBe(false);
      expect(isAuthorizedPiTool(name, new Set([name]))).toBe(false);
    }
    expect(isAuthorizedPiTool(undefined, declared)).toBe(false);
    expect(isAuthorizedPiTool("", declared)).toBe(false);
    expect(isAuthorizedPiTool("pi_undeclared", declared)).toBe(false);
    expect(isAuthorizedPiTool("read", declared)).toBe(false);
  });
  it("accepts Vibe 3.1.5's mcp_pi gated_tool_name and denies undeclared forms", () => {
    expect(isAuthorizedPiTool("mcp_pi.read", declared)).toBe(true);
    expect(isAuthorizedPiTool("mcp_pi.undeclared", declared)).toBe(false);
    expect(isAuthorizedPiTool("read_file", declared)).toBe(false);
    expect(isAuthorizedPiTool("mcp_pi.read_file", new Set(["read-file"]))).toBe(true);
    expect(isAuthorizedPiTool("mcp_pi._2fa", new Set(["2fa"]))).toBe(true);
    expect(isAuthorizedPiTool("pi__2fa", new Set(["2fa"]))).toBe(true);
    expect(isAuthorizedPiTool("pi.2fa", new Set(["2fa"]))).toBe(true);
  });
});

/* ================================================================== */
/* Ten end-to-end scenarios over the fake ACP                          */
/* ================================================================== */

describe("scenario 1: ordinary chat turn", () => {
  it("stages the exact prompt, discloses overhead once per session, and reports a per-turn usage delta", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const sessionId = "e2e-chat";
    const systemPrompt = "You are Pi.\nKeep this exact text.";
    const context1 = {
      systemPrompt,
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      tools: [],
    };
    const msg1: any = await runTurn(MODEL, context1, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(msg1.stopReason).toBe("stop");
    expect(msg1.errorMessage).toBeUndefined();
    expect(msg1.usage.input).toBe(800);
    expect(msg1.usage.output).toBe(100);
    expect(msg1.usage.cacheRead).toBe(200);
    // The staged system prompt file holds Pi's exact text.
    const home = (getCliProcess(sessionId) as any)?.vibeHome ?? sessionVibeHome(sessionId);
    expect(existsSync(join(home, "prompts", "pi.md"))).toBe(true);
    expect(readFileSync(join(home, "prompts", "pi.md"), "utf8")).toBe(systemPrompt);
    // Overhead disclosure is log-only: zero notify, ledgered every turn with surface log.
    expect(h.notified).toHaveLength(0);
    expect(h.ledger.filter((e) => e.key === "vibe-system-overhead")).toHaveLength(1);
    expect((h.ledger.find((e) => e.key === "vibe-system-overhead") as any)?.surface).toBe("log");

    // Second turn reuses the warm session and reports the delta, not the cumulative.
    const context2 = {
      systemPrompt,
      messages: [
        { role: "user", content: "hello", timestamp: Date.now() },
        msg1,
        { role: "user", content: "again", timestamp: Date.now() },
      ],
      tools: [],
    };
    const msg2: any = await runTurn(MODEL, context2, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(msg2.stopReason).toBe("stop");
    // Cumulative 2600/260/1200 minus previous 1000/100/200 => input 600, output 160, cache 1000.
    expect(msg2.usage.input).toBe(600);
    expect(msg2.usage.output).toBe(160);
    expect(msg2.usage.cacheRead).toBe(1000);
    const entries = readFakeLog(fake.log);
    expect(entries.filter((e) => e.dir === "session/new")).toHaveLength(1);
    expect(entries.filter((e) => e.dir === "prompt")).toHaveLength(2);
    expect(h.notified).toHaveLength(0);
    expect(h.ledger.filter((e) => e.key === "vibe-system-overhead")).toHaveLength(2);
    expect(h.ledger.filter((e) => e.key === "vibe-system-overhead").every((e: any) => e.surface === "log")).toBe(true);
    expect(activeCliProcessCount()).toBe(1);
  }, 30_000);
});

describe("scenario 2: multi-step Pi tool call through the real MCP server", () => {
  it("surfaces a Pi tool call backed by the live broker and continues the same turn", async () => {
    writeHostLogin();
    const fake = installFakeAcp("tool");
    const h = harness();
    const sessionId = "e2e-tool";
    const context1 = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "read sample.txt", timestamp: Date.now() }],
      tools: [READ_TOOL],
    };
    const msg1: any = await runTurn(MODEL, context1, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(msg1.stopReason).toBe("toolUse");
    const toolCall = msg1.content.find((b: any) => b.type === "toolCall");
    expect(toolCall).toBeDefined();
    expect(toolCall.name).toBe("read");
    expect(toolCall.arguments).toEqual({ path: "sample.txt" });
    // Built-in schemas disclosure is log-only: ledgered, never notified.
    expect(h.ledger.some((e) => e.key === "vibe-builtin-schemas" && (e as any).surface === "log")).toBe(true);
    expect(h.ledger.some((e) => e.key === "vibe-system-overhead" && (e as any).surface === "log")).toBe(true);
    expect(h.notified).toHaveLength(0);
    expect(activeCliProcessCount()).toBe(1);

    const toolResult: any = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file contents here" }],
      timestamp: Date.now(),
    };
    const msg2: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "read sample.txt", timestamp: Date.now() }, msg1, toolResult], tools: [READ_TOOL] },
      { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(msg2.stopReason).toBe("stop");
    expect(h.notified).toHaveLength(0);
    const texts = msg2.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    expect(texts).toContain("file contents here");
    // The same ACP session continued: still one session/new.
    expect(readFakeLog(fake.log).filter((e) => e.dir === "session/new")).toHaveLength(1);
  }, 30_000);
});

describe("scenario 3: permission allowlist", () => {
  it("denies built-ins with cancelled and allows the declared Pi tool with allow_once", async () => {
    writeHostLogin();
    const fake = installFakeAcp("permission");
    const h = harness();
    await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "use tools", timestamp: Date.now() }], tools: [READ_TOOL] },
      { sessionId: "e2e-perm", notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    const perms = readFakeLog(fake.log).filter((e) => e.dir === "permission");
    expect(perms.map((p) => p.toolName)).toEqual(["read_file", "bash", "mcp_pi.read"]);
    expect(perms[0].answer.outcome.outcome).toBe("cancelled");
    expect(perms[1].answer.outcome.outcome).toBe("cancelled");
    expect(perms[2].answer.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  }, 30_000);
});

describe("scenario 4: large Pi tool result spill", () => {
  it("discloses a large result normally and refuses in strict mode without releasing it", async () => {
    writeHostLogin();
    installFakeAcp("tool");
    const h = harness();
    const sessionId = "e2e-spill";
    const msg1: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "read it", timestamp: Date.now() }], tools: [READ_TOOL] },
      { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    const toolCall = msg1.content.find((b: any) => b.type === "toolCall");
    const big = "x".repeat(17_000);
    const bigResult: any = {
      role: "toolResult", toolCallId: toolCall.id, toolName: "read", isError: false,
      content: [{ type: "text", text: big }], timestamp: Date.now(),
    };
    const msg2: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "read it", timestamp: Date.now() }, msg1, bigResult], tools: [READ_TOOL] },
      { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(msg2.stopReason).toBe("stop");
    const spill = h.ledger.find((e) => e.key === "vibe-tool-result-spill");
    expect(spill).toBeDefined();
    expect((spill as any).surface).toBe("screen");
    expect(spill!.message).toContain("17000 characters");
    expect(h.notified.some((m) => m.includes("17000 characters"))).toBe(true);

    // Strict mode refuses before releasing the result.
    await retireCliProcess(sessionId, "test-cleanup-first-half");
    writeHostLogin();
    const strictFake = installFakeAcp("tool");
    const hs = harness();
    const sessionId2 = "e2e-spill-strict";
    const s1: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "read it", timestamp: Date.now() }], tools: [READ_TOOL] },
      { sessionId: sessionId2, notify: hs.notify, recordDisclosure: hs.recordDisclosure },
    );
    const sc = s1.content.find((b: any) => b.type === "toolCall");
    const strictCli: any = getCliProcess(sessionId2);
    const strictRoot = strictCli?.incarnationRoot as string;
    process.env[STRICT_ENV] = "1";
    const s2: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "read it", timestamp: Date.now() }, s1, { role: "toolResult", toolCallId: sc.id, toolName: "read", isError: false, content: [{ type: "text", text: big }], timestamp: Date.now() }], tools: [READ_TOOL] },
      { sessionId: sessionId2, notify: hs.notify, recordDisclosure: hs.recordDisclosure },
    );
    expect(s2.stopReason).toBe("error");
    expect(readFakeLog(strictFake.log).some((e) => e.dir === "mcp-result")).toBe(false);
    expect(getCliProcess(sessionId2)).toBeUndefined();
    expect(activeCliProcessCount()).toBe(0);
    expect(strictRoot).toBeTruthy();
    expect(existsSync(strictRoot)).toBe(false);
    expect(hs.ledger.some((e) => e.key === "vibe-tool-result-spill" && (e as any).surface === "screen")).toBe(true);
    delete process.env[STRICT_ENV];
  }, 60_000);
});

describe("scenario 5: Vibe auto-compaction", () => {
  it("discloses compaction, retires the session, and refuses in strict mode", async () => {
    writeHostLogin();
    installFakeAcp("compaction");
    const h = harness();
    const sessionId = "e2e-compact";
    const msg1: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "first", timestamp: Date.now() }], tools: [] },
      { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(msg1.stopReason).toBe("stop");
    expect(h.ledger.some((e) => e.key === "vibe-auto-compaction" && (e as any).surface === "screen")).toBe(true);
    expect(h.notified.some((m) => m.includes("ran automatic compaction"))).toBe(true);
    // Log-only system overhead on this turn must not notify.
    expect(h.notified.filter((m) => m.includes("harness capability guidance"))).toHaveLength(0);
    // The tainted session retires when the turn ends, so the count drops.
    expect(activeCliProcessCount()).toBe(0);

    // Strict mode refuses the compaction turn.
    writeHostLogin();
    installFakeAcp("compaction");
    process.env[STRICT_ENV] = "1";
    const hs = harness();
    const sm: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "first", timestamp: Date.now() }], tools: [] },
      { sessionId: "e2e-compact-strict", notify: hs.notify, recordDisclosure: hs.recordDisclosure },
    );
    expect(sm.stopReason).toBe("error");
    delete process.env[STRICT_ENV];
  }, 60_000);
});

describe("scenario 6: cold history replay", () => {
  it("replays prior turns on a fresh session and discloses cold replay and older images", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const sessionId = "e2e-cold";
    const withImage = {
      systemPrompt: "sys",
      messages: [
        { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: Date.now() },
        { role: "assistant", content: [{ type: "text", text: "saw it" }] },
        { role: "user", content: "and now?", timestamp: Date.now() },
      ],
      tools: [],
    };
    const msg: any = await runTurn(MODEL, withImage, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(msg.stopReason).toBe("stop");
    expect(h.ledger.some((e) => e.key === "vibe-cold-replay" && (e as any).surface === "screen")).toBe(true);
    expect(h.ledger.some((e) => e.key === "vibe-older-images" && (e as any).surface === "screen")).toBe(true);
    expect(h.notified.some((m) => m.includes("replayed prior turns"))).toBe(true);
    expect(h.notified.some((m) => m.includes("replaces older images"))).toBe(true);
    expect(h.notified.filter((m) => m.includes("harness capability guidance"))).toHaveLength(0);
    const prompts = readFakeLog(fake.log).filter((e) => e.dir === "prompt");
    expect(prompts.length).toBeGreaterThan(0);
    const blocks = prompts[0].blocks;
    const texts = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    expect(texts).toContain("USER:");
    expect(texts).toContain("ASSISTANT:");
    expect(blocks.some((b: any) => b.type === "image")).toBe(true);
    expect(texts).toContain("and now?");
  }, 30_000);
});

describe("scenario 7: leading slash-command collision", () => {
  it("wraps the prompt and discloses the collision", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "/compact hello", timestamp: Date.now() }], tools: [] },
      { sessionId: "e2e-slash", notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(msg.stopReason).toBe("stop");
    expect(h.ledger.some((e) => e.key === "vibe-slash-command-collision" && (e as any).surface === "log")).toBe(true);
    expect(h.ledger.find((e) => e.key === "vibe-slash-command-collision")!.message).toContain("/compact");
    expect(h.notified).toHaveLength(0);
    const prompts = readFakeLog(fake.log).filter((e) => e.dir === "prompt");
    const texts = prompts[0].blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    expect(texts).toContain("User message (literal text, not a Vibe command):");
    expect(texts).toContain("/compact hello");
  }, 30_000);
});

describe("scenario 8: process killed by signal", () => {
  it("reports the SIGKILL cause", async () => {
    writeHostLogin();
    installFakeAcp("kill");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
      { sessionId: "e2e-kill", notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toContain("vibe-acp was killed (signal SIGKILL)");
  }, 30_000);
});

describe("scenario 9: error separation", () => {
  it("keeps rate limit, quota, and overflow distinct, rewriting only overflow", async () => {
    writeHostLogin();
    installFakeAcp("ratelimit");
    const rateMsg: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
      { sessionId: "e2e-err-rate", notify: () => {}, recordDisclosure: () => {} },
    );
    expect(rateMsg.stopReason).toBe("error");
    expect(rateMsg.errorMessage).toContain("rate limit");
    expect(rateMsg.errorMessage).not.toContain("/vibe-status");
    expect(rewriteOverflowMessage({ role: "assistant", provider: "mistral-vibe", stopReason: "error", errorMessage: rateMsg.errorMessage }, "mistral-vibe", "mistral-vibe")).toBeUndefined();

    writeHostLogin();
    installFakeAcp("quota");
    await retireAllCliProcesses("test-cleanup");
    const quotaMsg: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
      { sessionId: "e2e-err-quota", notify: () => {}, recordDisclosure: () => {} },
    );
    expect(quotaMsg.stopReason).toBe("error");
    expect(quotaMsg.errorMessage).toContain("/vibe-status");
    expect(rewriteOverflowMessage({ role: "assistant", provider: "mistral-vibe", stopReason: "error", errorMessage: quotaMsg.errorMessage }, "mistral-vibe", "mistral-vibe")).toBeUndefined();

    writeHostLogin();
    installFakeAcp("overflow");
    await retireAllCliProcesses("test-cleanup");
    const overMsg: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
      { sessionId: "e2e-err-over", notify: () => {}, recordDisclosure: () => {} },
    );
    expect(overMsg.stopReason).toBe("error");
    expect(overMsg.errorMessage).toContain("prompt is too long");
    const rewritten = rewriteOverflowMessage(
      { role: "assistant", provider: "mistral-vibe", stopReason: "error", errorMessage: overMsg.errorMessage },
      "mistral-vibe",
      "mistral-vibe",
    );
    expect(rewritten?.message.errorMessage).toBe(`${OVERFLOW_PREFIX}: ${overMsg.errorMessage}`);
  }, 60_000);
});

describe("max-turn-requests stopReason", () => {
  it("emits an error event (not done) and retires the session", async () => {
    writeHostLogin();
    installFakeAcp("max-turn-requests");
    const h = harness();
    const sessionId = "e2e-max-turn";
    const stream: any = streamViaAcp(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
      { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    const events: any[] = [];
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();
    const msg: any = await stream.result();
    await collect;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toContain("max_turn_requests");
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(getCliProcess(sessionId)).toBeUndefined();
    expect(activeCliProcessCount()).toBe(0);
  }, 30_000);
});

describe("scenario 10: account and budget readout without reading credentials", () => {
  it("reports plan and usage via account and identity reads", async () => {
    const hostHome = writeHostLogin("TOPSECRET-token-value-12345\n");
    installFakeAcp("chat");
    const info = await queryVibeAccountStatus();
    expect(info.planName).toBe("Vibe EDU");
    expect(info.planTitle).toBe("Vibe Education");
    expect(info.usagePercentage).toBe(42);
    expect(info.resetAt).toBe("2026-12-01T00:00:00Z");
    expect(info.paygEnabled).toBe(false);
    expect(info.keyScope).toBe("vibe:read");
    expect(info.accessScope).toBe("full");
    expect(info.workspace).toBe("workspace-1");
    expect(info.organization).toBe("org-1");
    const line = cliStatusLine();
    expect(line).toContain("Vibe EDU");
    expect(line).toContain("42");
    expect(line).not.toContain("TOPSECRET");
    // The host credential file was never consumed as data by this module;
    // its content is untouched.
    expect(readFileSync(join(hostHome, ".env"), "utf8")).toBe("TOPSECRET-token-value-12345\n");
    expect(statSync(join(hostHome, ".env")).isFile()).toBe(true);
  }, 30_000);
});

describe("ephemeral session without a Pi session id", () => {
  it("streams an answer with sessionId undefined and retires the process cleanly", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
      { sessionId: undefined, notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(msg.stopReason).toBe("stop");
    expect(msg.errorMessage).toBeUndefined();
    const texts = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    expect(texts).toContain("reply to:");
    for (let i = 0; i < 50 && activeCliProcessCount() !== 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(activeCliProcessCount()).toBe(0);
  }, 30_000);
});

describe("parallel buffered handoff", () => {
  it("delivers the first tool result while surfacing the buffered second call", async () => {
    writeHostLogin();
    installFakeAcp("tool");
    const h = harness();
    const sessionId = "e2e-parallel";
    const msg1: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "read sample.txt", timestamp: Date.now() }], tools: [READ_TOOL] },
      { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(msg1.stopReason).toBe("toolUse");
    const firstCall = msg1.content.find((b: any) => b.type === "toolCall");
    expect(firstCall).toBeDefined();
    const cli: any = getCliProcess(sessionId);
    expect(cli).toBeDefined();
    // A second MCP call arrives before Pi returns the first tool result:
    // with no sink attached it must be buffered, not surfaced yet.
    const secondId = "00000000-0000-4000-8000-000000000002";
    let secondResponded = false;
    cli.onHandoffCall({
      piCallId: secondId,
      name: "read",
      arguments: { path: "second.txt" },
      respond: () => { secondResponded = true; },
    });
    expect(cli.hasPendingHandoffs).toBe(true);
    const toolResult: any = {
      role: "toolResult",
      toolCallId: firstCall.id,
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file contents here" }],
      timestamp: Date.now(),
    };
    const msg2: any = await runTurn(
      MODEL,
      { systemPrompt: "sys", messages: [{ role: "user", content: "read sample.txt", timestamp: Date.now() }, msg1, toolResult], tools: [READ_TOOL] },
      { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    // Delivering the first result surfaces the buffered second call.
    expect(msg2.stopReason).toBe("toolUse");
    const secondCall = msg2.content.find((b: any) => b.type === "toolCall");
    expect(secondCall).toBeDefined();
    expect(secondCall.id).toBe(secondId);
    expect(secondCall.name).toBe("read");
    expect(secondCall.arguments).toEqual({ path: "second.txt" });
    expect(secondResponded).toBe(false);
    expect(cli.hasPendingHandoffs).toBe(true);
  }, 30_000);
});

/* ================================================================== */
/* Pass 8A: startup never waits on Vibe                                */
/* ================================================================== */

function fakePi() {
  const handlers = new Map<string, any[]>();
  const providers: any[] = [];
  const commands: any[] = [];
  const appended: Array<{ entryType: string; data: any }> = [];
  const pi: any = {
    on: (event: string, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerProvider: (id: string, config: any) => providers.push({ id, config }),
    registerCommand: (name: string, def: any) => commands.push({ name, def }),
    registerEntryRenderer: () => {},
    appendEntry: (entryType: string, data: any) => appended.push({ entryType, data }),
  };
  return { pi, providers, commands, handlers, appended };
}

describe("Pass 8A startup: non-Mistral Pi never waits on Vibe", () => {
  it("registers cached/fallback models immediately without spawning vibe-acp", async () => {
    const dir = freshDir("t-stall-" );
    const bin = join(dir, "vibe-acp");
    const marker = join(dir, "spawned.txt");
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nconst fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(marker)},"spawned"); process.on("SIGTERM",()=>process.exit(0)); process.stdin.resume(); setInterval(()=>{},1000);\n`,
    );
    chmodSync(bin, 0o755);
    process.env.PI_MISTRAL_VIBE_TETHER_CLI = bin;
    const { pi, providers } = fakePi();
    await extensionDefault(pi as any);
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("mistral-vibe");
    expect(providers[0].config.baseUrl).toBe("pi-mistral-vibe-tether");
    expect(providers[0].config.apiKey).toBe("unused");
    expect(providers[0].config.api).toBe("mistral-vibe");
    expect(providers[0].config.models.map((m: any) => m.id)).toContain("mistral-large-4-0");
    expect(typeof providers[0].config.refreshModels).toBe("function");
    expect(typeof providers[0].config.streamSimple).toBe("function");
    expect(existsSync(marker)).toBe(false);
    const models = await providers[0].config.refreshModels({ allowNetwork: false });
    expect(models.map((m: any) => m.id)).toContain("mistral-large-4-0");
    expect(existsSync(marker)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("registers even when CLI is missing without console.error, and refresh probes only with network allowed", async () => {
    process.env.PI_MISTRAL_VIBE_TETHER_CLI = "/nonexistent/vibe-acp";
    takeStartupNotices();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { pi, providers } = fakePi();
      await extensionDefault(pi as any);
      expect(providers).toHaveLength(1);
      expect(errSpy).not.toHaveBeenCalled();
      expect(cliStatus().lastError).toBeTruthy();
      expect(takeStartupNotices().some((m) => m.includes("vibe-acp"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const { pi, providers } = fakePi();
    await extensionDefault(pi as any);
    const refreshed = await providers[0].config.refreshModels({ allowNetwork: true });
    expect(refreshed.map((m: any) => m.id)).toContain("mistral-large-4-0");
    expect(readFakeLog(fake.log).length).toBeGreaterThan(0);
  }, 30_000);
});

describe("Pass 8A fail-closed before prompting", () => {
  const ctx = (systemPrompt = "sys") => ({
    systemPrompt,
    messages: [{ role: "user", content: "inert fixture", timestamp: 1 }],
    tools: [READ_TOOL],
  });
  it("does not prompt when the ACP ask mode is refused (mode-refused)", async () => {
    writeHostLogin();
    const fake = installFakeAcp("mode-refused");
    const out: any = await runTurn(MODEL, ctx(), { sessionId: "audit-mode", ...harness() });
    const events = readFakeLog(fake.log);
    expect(events.some((e) => e.dir === "in" && e.msg?.method === "session/set_mode")).toBe(true);
    expect({ stop: out.stopReason, prompts: events.filter((e) => e.dir === "prompt").length }).toEqual({ stop: "error", prompts: 0 });
  }, 30_000);
  it("does not prompt without model and thinking acceptance evidence (readback-absent)", async () => {
    writeHostLogin();
    const fake = installFakeAcp("readback-absent");
    const out: any = await runTurn(MODEL, ctx(), { sessionId: "audit-readback", reasoning: "high", ...harness() });
    const events = readFakeLog(fake.log);
    expect(events.some((e) => e.dir === "in" && e.msg?.params?.configId === "thinking")).toBe(true);
    expect({ stop: out.stopReason, prompts: events.filter((e) => e.dir === "prompt").length }).toEqual({ stop: "error", prompts: 0 });
  }, 30_000);
});

describe("Pass 8A fresh workspace per incarnation", () => {
  it("restages an empty workspace and distinct VIBE_HOME for a replacement ACP client (workspace-mark)", async () => {
    writeHostLogin();
    const fake = installFakeAcp("workspace-mark");
    const sessionId = "audit-stage";
    const ctx = (prompt: string) => ({
      systemPrompt: prompt,
      messages: [{ role: "user", content: "inert fixture", timestamp: 1 }],
      tools: [READ_TOOL],
    });
    const a: any = await runTurn(MODEL, ctx("first prompt"), { sessionId, ...harness() });
    expect(a.stopReason).toBe("stop");
    const firstCli: any = getCliProcess(sessionId);
    expect(firstCli).toBeDefined();
    const firstRoot = firstCli.incarnationRoot;
    expect(firstRoot).toBeTruthy();
    expect(existsSync(firstRoot)).toBe(true);
    const firstVibeHome = firstCli.vibeHome;
    const b: any = await runTurn(MODEL, ctx("changed prompt"), { sessionId, ...harness() });
    expect(b.stopReason).toBe("stop");
    const observations = readFakeLog(fake.log).filter((e) => e.dir === "workspace");
    expect(observations).toHaveLength(2);
    expect({ sameCwd: observations[0].cwd === observations[1].cwd, priorFile: observations[1].existed }).toEqual({ sameCwd: false, priorFile: false });
    expect(observations[0].vibeHome).not.toBe(observations[1].vibeHome);
    expect(existsSync(firstRoot)).toBe(false);
    expect(firstVibeHome).not.toBe((getCliProcess(sessionId) as any)?.vibeHome);
  }, 30_000);
});

describe("Pass 8A parallel buffered handoff for 3+ calls", () => {
  it("does not mark the second buffered call surfaced before Pi has seen it", async () => {
    writeHostLogin();
    installFakeAcp("tool");
    const sessionId = "audit-parallel";
    const baseCtx = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "inert fixture", timestamp: 1 }],
      tools: [READ_TOOL],
    };
    const first: any = await runTurn(MODEL, baseCtx, { sessionId, ...harness() });
    expect(first.stopReason).toBe("toolUse");
    const t = first.content.find((b: any) => b.type === "toolCall");
    const cli: any = getCliProcess(sessionId)!;
    for (const id of ["audit-buffered-1", "audit-buffered-2"]) {
      cli.onHandoffCall({ piCallId: id, name: "read", arguments: { path: "fixture" }, respond: () => {} });
    }
    const result1 = { role: "toolResult", toolCallId: t.id, toolName: t.name, content: [{ type: "text", text: "ok" }] };
    const second: any = await runTurn(MODEL, { ...baseCtx, messages: [...baseCtx.messages, first, result1] }, { sessionId, ...harness() });
    const surfaced = second.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
    expect(second.stopReason).toBe("toolUse");
    expect(surfaced).toEqual(["audit-buffered-1"]);
    expect(cli.pendingHandoffIds()).toEqual(surfaced);
    const result2 = { role: "toolResult", toolCallId: "audit-buffered-1", toolName: "read", content: [{ type: "text", text: "ok" }] };
    const third: any = await runTurn(MODEL, { ...baseCtx, messages: [...baseCtx.messages, first, result1, second, result2] }, { sessionId, ...harness() });
    const surfaced3 = third.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
    expect(third.stopReason).toBe("toolUse");
    expect(surfaced3).toEqual(["audit-buffered-2"]);
    expect(cli.pendingHandoffIds()).toEqual(["audit-buffered-2"]);
    const result3 = { role: "toolResult", toolCallId: "audit-buffered-2", toolName: "read", content: [{ type: "text", text: "ok" }] };
    const fourth: any = await runTurn(MODEL, { ...baseCtx, messages: [...baseCtx.messages, first, result1, second, result2, third, result3] }, { sessionId, ...harness() });
    expect(fourth.stopReason).toBe("stop");
  }, 30_000);
});

/* ================================================================== */
/* Pass 8B: audit cases + new disclosures/sanitization                  */
/* ================================================================== */

describe("Pass 8B pi-context image helpers", () => {
  it("counts images and detects warm overflow and prompt block separation", () => {
    expect(VIBE_MAX_REQUEST_IMAGES).toBe(8);
    expect(VIBE_MAX_PROMPT_IMAGES).toBe(8);
    const msgs: any[] = [
      { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "image", data: "BB==", mimeType: "image/png" }] },
      { role: "user", content: "plain" },
    ];
    expect(countImages(msgs)).toBe(2);
    expect(countImages([{ role: "user", content: [{ type: "image", data: 123 }] }] as any)).toBe(0);
    expect(hasWarmImageWindowOverflow(msgs)).toBe(false);
    const nine: any[] = [{ role: "user", content: Array.from({ length: 9 }, () => ({ type: "image", data: "AA==", mimeType: "image/png" })) }];
    expect(countImages(nine)).toBe(9);
    expect(hasWarmImageWindowOverflow(nine)).toBe(false);
    const eight: any[] = [{ role: "user", content: Array.from({ length: 8 }, () => ({ type: "image", data: "AA==", mimeType: "image/png" })) }];
    expect(hasWarmImageWindowOverflow(eight)).toBe(false);
    expect(countBlockImages([{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "x" }])).toBe(1);
    expect(countBlockImages(Array.from({ length: 9 }, (): any => ({ type: "image", data: "AA==", mimeType: "image/png" })))).toBe(9);
    expect(hasThinkingBlocks([{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }])).toBe(true);
    expect(hasThinkingBlocks([{ role: "assistant", content: [{ type: "text", text: "hi" }] }])).toBe(false);
    expect(hasThinkingBlocks([{ role: "user", content: "plain" }])).toBe(false);
    const olderNine: any[] = [
      { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "text", text: "seen" }] },
      { role: "user", content: Array.from({ length: 8 }, () => ({ type: "image", data: "AA==", mimeType: "image/png" })) },
    ];
    expect(hasWarmImageWindowOverflow(olderNine)).toBe(true);
    expect(hasPromptBlockSeparation([{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "after" }])).toBe(true);
    expect(hasPromptBlockSeparation([{ type: "text", text: "before" }, { type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "after" }])).toBe(true);
    expect(hasPromptBlockSeparation([{ type: "text", text: "only" }, { type: "image", data: "AA==", mimeType: "image/png" }])).toBe(false);
    expect(hasPromptBlockSeparation([{ type: "text", text: "only" }])).toBe(false);
    expect(hasPromptBlockSeparation([{ type: "image", data: "AA==", mimeType: "image/png" }])).toBe(false);
  });
});

describe("Pass 8B sanitizeUntrustedDiagnostic and formatVibeError", () => {
  it("sanitizes control characters, collapses whitespace, trims and truncates", () => {
    expect(sanitizeUntrustedDiagnostic("  hello\x00\x1b[31m\x07 world \n\n  again \x7f ")).toBe("hello [31m world again");
    expect(sanitizeUntrustedDiagnostic("\x00\x1f\x7f")).toBe("");
    const long = "x".repeat(2000);
    const out = sanitizeUntrustedDiagnostic(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith("…")).toBe(true);
    expect(out.includes("\x00")).toBe(false);
  });
  it("carries typed rate and overflow codes with neutral wire text through formatVibeError", () => {
    const rate = formatVibeError(new AcpRpcError("upstream busy", { code: -31001, method: "session/prompt" }));
    expect(rate).toMatch(/rate.limit/i);
    expect(rate).toContain("upstream busy");
    const over = formatVibeError(new AcpRpcError("upstream fault", { code: -31004, method: "session/prompt" }));
    expect(over).toMatch(/context_length_exceeded/i);
    expect(over).toContain("upstream fault");
    const rateText = formatVibeError(new AcpRpcError("rate limit exceeded", { code: -31001, method: "session/prompt" }));
    expect(rateText).toBe("rate limit exceeded");
    const overText = formatVibeError(new AcpRpcError("prompt is too long: 10", { code: -31004, method: "session/prompt" }));
    expect(overText).toBe("prompt is too long: 10");
    const internal = formatVibeError(new AcpRpcError("boom", { code: -32603, method: "session/prompt" }));
    expect(internal).toContain("Mistral Vibe ACP error");
    expect(internal).toContain("-32603");
    expect(internal).not.toMatch(/rate.limit/i);
    const quota = formatVibeError(new Error("quota exhausted"));
    expect(quota).toContain("/vibe-status");
    const signal = formatVibeError(new Error("vibe-acp was killed (signal SIGKILL)"));
    expect(signal).toBe("vibe-acp was killed (signal SIGKILL)");
    const strict = formatVibeError(new Error("Mistral Vibe adds its own harness capability guidance around Pi's system prompt; Pi owns the prompt base."));
    expect(strict).toContain("harness capability guidance");
  });
});

describe("Pass 8B independent audit: required safety behavior", () => {
  const context = (systemPrompt = "sys") => ({ systemPrompt, messages: [{ role: "user", content: "inert fixture", timestamp: 1 }], tools: [READ_TOOL] });
  it("does not prompt when the ACP ask mode is refused", async () => {
    writeHostLogin();
    const fake = installFakeAcp("mode-refused");
    const out: any = await runTurn(MODEL, context(), { sessionId: "audit-mode", ...harness() });
    const events = readFakeLog(fake.log);
    expect(events.some((e: any) => e.dir === "in" && e.msg?.method === "session/set_mode")).toBe(true);
    expect({ stop: out.stopReason, prompts: events.filter((e: any) => e.dir === "prompt").length }).toEqual({ stop: "error", prompts: 0 });
  }, 30_000);
  it("does not prompt without model and thinking acceptance evidence", async () => {
    writeHostLogin();
    const fake = installFakeAcp("readback-absent");
    const out: any = await runTurn(MODEL, context(), { sessionId: "audit-readback", reasoning: "high", ...harness() });
    const events = readFakeLog(fake.log);
    expect(events.some((e: any) => e.dir === "in" && e.msg?.params?.configId === "thinking")).toBe(true);
    expect({ stop: out.stopReason, prompts: events.filter((e: any) => e.dir === "prompt").length }).toEqual({ stop: "error", prompts: 0 });
  }, 30_000);
  it("carries machine-typed rate limit and overflow to Pi even with neutral wire text", async () => {
    writeHostLogin();
    const rate = installFakeAcp("typed-rate");
    const a: any = await runTurn(MODEL, context(), { sessionId: "audit-rate", ...harness() });
    expect(readFakeLog(rate.log).some((e: any) => e.dir === "out" && e.msg?.error?.code === -31001)).toBe(true);
    expect(/rate.limit/i.test(a.errorMessage)).toBe(true);
    const over = installFakeAcp("typed-overflow");
    const b: any = await runTurn(MODEL, context(), { sessionId: "audit-overflow", ...harness() });
    expect(readFakeLog(over.log).some((e: any) => e.dir === "out" && e.msg?.error?.code === -31004)).toBe(true);
    expect(/context_length_exceeded/i.test(b.errorMessage) || !!rewriteOverflowMessage(b, "mistral-vibe")).toBe(true);
  }, 30_000);
  it("does not call reported inference usage zero when an ACP error follows it", async () => {
    writeHostLogin();
    installFakeAcp("usage-then-error");
    const out: any = await runTurn(MODEL, context(), { sessionId: "audit-error-usage", ...harness() });
    expect(out.stopReason).toBe("error");
    expect({ input: out.usage.input, output: out.usage.output, cache: out.usage.cacheRead }).toEqual({ input: 18, output: 3, cache: 4 });
  }, 30_000);
  it("verifies the login link again after the official child prompts", async () => {
    const login = writeHostLogin();
    installFakeAcp("login-replaced");
    const sessionId = "audit-linked";
    const out: any = await runTurn(MODEL, context(), { sessionId, ...harness() });
    expect(readFileSync(join(login, ".env"), "utf8")).toBe("TOPSECRET-token-value-12345\n");
    expect(out.stopReason).toBe("error");
  }, 30_000);
  it("refuses a strict first turn before any ACP launch or prompt", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    process.env[STRICT_ENV] = "1";
    const h = harness();
    const out: any = await runTurn(MODEL, context(), { sessionId: "audit-strict-first", ...h });
    expect(out.stopReason).toBe("error");
    expect(h.ledger.map((e) => e.key)).toEqual(["vibe-system-overhead"]);
    expect((h.ledger[0] as any)?.surface).toBe("log");
    expect(h.notified).toHaveLength(0);
    expect(readFakeLog(fake.log)).toEqual([]);
  }, 30_000);
  it("does not mark the second buffered call surfaced before Pi has seen it", async () => {
    writeHostLogin();
    installFakeAcp("tool");
    const sessionId = "audit-parallel-8b";
    const c = context();
    const first: any = await runTurn(MODEL, c, { sessionId, ...harness() });
    expect(first.stopReason).toBe("toolUse");
    const t = first.content.find((b: any) => b.type === "toolCall");
    const cli: any = getCliProcess(sessionId)!;
    for (const id of ["audit-buffered-1", "audit-buffered-2"]) cli.onHandoffCall({ piCallId: id, name: "read", arguments: { path: "fixture" }, respond: () => {} });
    const result = { role: "toolResult", toolCallId: t.id, toolName: t.name, content: [{ type: "text", text: "ok" }] };
    const second: any = await runTurn(MODEL, { ...c, messages: [...c.messages, first, result] }, { sessionId, ...harness() });
    const surfaced = second.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
    expect(surfaced).toEqual(["audit-buffered-1"]);
    expect(cli.pendingHandoffIds()).toEqual(surfaced);
  }, 30_000);
  it("retires a blocked MCP episode when strict mode refuses the continuation", async () => {
    writeHostLogin();
    const fake = installFakeAcp("tool");
    const sessionId = "audit-strict";
    const h = harness();
    const c = context();
    const first: any = await runTurn(MODEL, c, { sessionId, ...h });
    expect(first.stopReason).toBe("toolUse");
    const t = first.content.find((b: any) => b.type === "toolCall");
    const firstCli: any = getCliProcess(sessionId);
    const firstRoot = firstCli.incarnationRoot;
    process.env[STRICT_ENV] = "1";
    const result = { role: "toolResult", toolCallId: t.id, toolName: t.name, content: [{ type: "text", text: "a".repeat(17000) }] };
    const second: any = await runTurn(MODEL, { ...c, messages: [...c.messages, first, result] }, { sessionId, ...h });
    expect(second.stopReason).toBe("error");
    expect(readFakeLog(fake.log).some((e: any) => e.dir === "mcp-result")).toBe(false);
    expect({ parked: !!getCliProcess(sessionId), spillReason: h.ledger.some((e) => e.key === "vibe-tool-result-spill") }).toEqual({ parked: false, spillReason: true });
    expect(getCliProcess(sessionId)).toBeUndefined();
    expect(activeCliProcessCount()).toBe(0);
    expect(existsSync(firstRoot)).toBe(false);
  }, 30_000);
  it("restages a genuinely empty workspace and distinct VIBE_HOME for a replacement ACP client", async () => {
    writeHostLogin();
    const fake = installFakeAcp("workspace-mark");
    const sessionId = "audit-stage-8b";
    const a: any = await runTurn(MODEL, context("first prompt"), { sessionId, ...harness() });
    const b: any = await runTurn(MODEL, context("changed prompt"), { sessionId, ...harness() });
    expect(a.stopReason).toBe("stop"); expect(b.stopReason).toBe("stop");
    const observations = readFakeLog(fake.log).filter((e: any) => e.dir === "workspace");
    expect(observations).toHaveLength(2);
    expect({ sameCwd: observations[0].cwd === observations[1].cwd, priorFile: observations[1].existed }).toEqual({ sameCwd: false, priorFile: false });
  }, 30_000);
});

describe("Pass 8B new disclosures", () => {
  it("emits vibe-older-images on a warm turn with older plus new images over eight total", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const h = harness();
    const sessionId = "pass8b-warm-images";
    const base = { systemPrompt: "sys", tools: [] };
    const five = Array.from({ length: 5 }, () => ({ type: "image", data: "AA==", mimeType: "image/png" }));
    const first: any = await runTurn(MODEL, { ...base, messages: [{ role: "user", content: five, timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(first.stopReason).toBe("stop");
    const four = Array.from({ length: 4 }, () => ({ type: "image", data: "BB==", mimeType: "image/png" }));
    const second: any = await runTurn(MODEL, { ...base, messages: [{ role: "user", content: five, timestamp: Date.now() }, first, { role: "user", content: four, timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(second.stopReason).toBe("stop");
    expect(h.ledger.some((e) => e.key === "vibe-older-images" && (e as any).surface === "screen")).toBe(true);
    expect(h.notified.some((m) => m.includes("replaces older images"))).toBe(true);
  }, 30_000);
  it("emits vibe-prompt-block-separation for an interleaved image/text prompt", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const h = harness();
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "what is this?" }], timestamp: Date.now() }] }, { sessionId: "pass8b-separation", ...h });
    expect(out.stopReason).toBe("stop");
    expect(h.ledger.some((e) => e.key === "vibe-prompt-block-separation" && (e as any).surface === "screen")).toBe(true);
    expect(h.notified.some((m) => m.includes("separates images from text blocks"))).toBe(true);
    // Grouped [text, text, image] emits neither ledger nor screen notice.
    const grouped: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "first " }, { type: "text", text: "second " }, { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: Date.now() }] }, { sessionId: "pass8b-separation-grouped", ...harness() });
    expect(grouped.stopReason).toBe("stop");
    expect(h.ledger.filter((e) => e.key === "vibe-prompt-block-separation")).toHaveLength(1);
    expect(h.notified.filter((m) => m.includes("separates images from text blocks"))).toHaveLength(1);
  }, 30_000);
  it("mentions omitted thinking in the cold replay disclosure", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const h = harness();
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }, { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "hello" }] }, { role: "user", content: "next", timestamp: Date.now() }] }, { sessionId: "pass8b-cold-thinking", ...h });
    expect(out.stopReason).toBe("stop");
    const entry = h.ledger.find((e) => e.key === "vibe-cold-replay:omitted-thinking");
    expect(entry).toBeDefined();
    expect((entry as any).surface).toBe("screen");
    expect(entry!.message).toContain("omitted prior thinking blocks");
    expect(h.notified.some((m) => m.includes("omitted prior thinking blocks"))).toBe(true);
  }, 30_000);
});

describe("Pass 8B untrusted stderr and ephemeral retirement", () => {
  it("sanitizes untrusted child stderr with control characters on crash", async () => {
    writeHostLogin();
    installFakeAcp("stderr-crash");
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { sessionId: "pass8b-stderr", ...harness() });
    expect(out.stopReason).toBe("error");
    expect(out.errorMessage).not.toContain("untrusted vibe-acp stderr");
    expect(out.errorMessage).not.toContain("boom");
    expect(isContextOverflow(out)).toBe(false);
    expect(out.stderrDiagnostic).toContain("boom");
    expect(out.stderrDiagnostic).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(out.content[0].text).toContain("untrusted vibe-acp stderr");
    expect(out.content[0].text).toContain("boom");
    expect(out.content[0].text).not.toMatch(/[\x00-\x1f\x7f]/);
  }, 30_000);
  it("removes the ephemeral incarnation directory before the stream completes", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { sessionId: undefined, ...harness() });
    expect(out.stopReason).toBe("stop");
    expect(activeCliProcessCount()).toBe(0);
    const sessionNew = readFakeLog(fake.log).find((e: any) => e.dir === "session/new");
    expect(sessionNew).toBeDefined();
    const workspace = sessionNew.cwd as string;
    const vibeHome = dirname(workspace);
    const incarnationRoot = dirname(vibeHome);
    expect(existsSync(incarnationRoot)).toBe(false);
  }, 30_000);
});

/* ================================================================== */
/* Comprehensive regression tests                                   */
/* ================================================================== */

describe("positive confirmation of mode, agent and approval readback", () => {
  it("positive control: Vibe 3.1.5 shape set_mode returns {} and settled mode/agent/model/thinking succeed", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId: "pr8-positive", reasoning: "high", notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(out.stopReason).toBe("stop");
    const events = readFakeLog(fake.log);
    expect(events.some((e: any) => e.dir === "in" && e.msg?.method === "session/set_mode")).toBe(true);
    expect(events.filter((e: any) => e.dir === "prompt")).toHaveLength(1);
    for (const id of ["agent", "mode", "model", "thinking"]) {
      expect(events.some((e: any) => e.dir === "in" && e.msg?.method === "session/set_config_option" && e.msg?.params?.configId === id)).toBe(true);
    }
  }, 30_000);
  it("refuses on lost-authority: initially auto, set_mode returns {}, model reply hides agent and has no mode", async () => {
    writeHostLogin();
    const fake = installFakeAcp("lost-authority");
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId: "pr8-lost", ...harness() });
    const events = readFakeLog(fake.log);
    expect(events.some((e: any) => e.dir === "in" && e.msg?.method === "session/set_mode")).toBe(true);
    expect({ stop: out.stopReason, prompts: events.filter((e: any) => e.dir === "prompt").length }).toEqual({ stop: "error", prompts: 0 });
  }, 30_000);
  it("refuses when valid model is returned but mode selector is absent", async () => {
    writeHostLogin();
    const fake = installFakeAcp("mode-absent");
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId: "pr8-mode-absent", ...harness() });
    const events = readFakeLog(fake.log);
    expect({ stop: out.stopReason, prompts: events.filter((e: any) => e.dir === "prompt").length }).toEqual({ stop: "error", prompts: 0 });
  }, 30_000);
  it("refuses when valid model and mode=ask are returned but agent selector is absent", async () => {
    writeHostLogin();
    const fake = installFakeAcp("agent-absent");
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId: "pr8-agent-absent", ...harness() });
    const events = readFakeLog(fake.log);
    expect({ stop: out.stopReason, prompts: events.filter((e: any) => e.dir === "prompt").length }).toEqual({ stop: "error", prompts: 0 });
  }, 30_000);
});

describe("broker continuation usage watermark", () => {
  it("tool-with-usage sums to exactly [800,100,200] not double counted", async () => {
    writeHostLogin();
    installFakeAcp("tool-with-usage");
    const h = harness();
    const sessionId = "pr8-usage-sum";
    const base = { systemPrompt: "sys", tools: [READ_TOOL] };
    const user = { role: "user", content: "read sample.txt", timestamp: Date.now() };
    const ep1: any = await runTurn(MODEL, { ...base, messages: [user] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(ep1.stopReason).toBe("toolUse");
    expect([ep1.usage.input, ep1.usage.output, ep1.usage.cacheRead]).toEqual([18, 3, 4]);
    const tc = ep1.content.find((b: any) => b.type === "toolCall");
    const result: any = { role: "toolResult", toolCallId: tc.id, toolName: "read", isError: false, content: [{ type: "text", text: "file contents here" }], timestamp: Date.now() };
    const ep2: any = await runTurn(MODEL, { ...base, messages: [user, ep1, result] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(ep2.stopReason).toBe("stop");
    const sum = [ep1.usage.input + ep2.usage.input, ep1.usage.output + ep2.usage.output, ep1.usage.cacheRead + ep2.usage.cacheRead];
    expect(sum).toEqual([800, 100, 200]);
    expect(sum).not.toEqual([818, 103, 204]);
  }, 30_000);
  it("continuation error after mid-turn usage_update does not double count", async () => {
    writeHostLogin();
    installFakeAcp("tool-with-usage-error");
    const h = harness();
    const sessionId = "pr8-usage-error";
    const base = { systemPrompt: "sys", tools: [READ_TOOL] };
    const user = { role: "user", content: "read sample.txt", timestamp: Date.now() };
    const ep1: any = await runTurn(MODEL, { ...base, messages: [user] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(ep1.stopReason).toBe("toolUse");
    expect([ep1.usage.input, ep1.usage.output, ep1.usage.cacheRead]).toEqual([18, 3, 4]);
    const tc = ep1.content.find((b: any) => b.type === "toolCall");
    const result: any = { role: "toolResult", toolCallId: tc.id, toolName: "read", isError: false, content: [{ type: "text", text: "file contents here" }], timestamp: Date.now() };
    const ep2: any = await runTurn(MODEL, { ...base, messages: [user, ep1, result] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(ep2.stopReason).toBe("error");
    const sum = [ep1.usage.input + ep2.usage.input, ep1.usage.output + ep2.usage.output, ep1.usage.cacheRead + ep2.usage.cacheRead];
    expect(sum).toEqual([800, 100, 200]);
  }, 30_000);
});

describe("usageReport honesty", () => {
  it("context-only update reports unavailable usage with context tokens", async () => {
    writeHostLogin();
    installFakeAcp("context-only");
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId: "pr8-context-only", ...harness() });
    expect(out.stopReason).toBe("stop");
    expect([out.usage.input, out.usage.output, out.usage.cacheRead]).toEqual([0, 0, 0]);
    expect(out.usage.totalTokens).toBe(650);
    const report = (out as any).usageReport;
    expect(report.availability).toBe("unavailable");
    expect(report.spend).toBeNull();
    expect(report.contextTokens).toBe(650);
    expect(report.contextSize).toBe(1000);
    expect(report.estimatedCost).toBeNull();
  }, 30_000);
  it("unlisted model reports costKnown false and unknown basis", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const unlisted: any = { ...MODEL, id: "unlisted-model-xyz" };
    const out: any = await runTurn(unlisted, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId: "pr8-unlisted", ...harness() });
    expect(out.stopReason).toBe("stop");
    const report = (out as any).usageReport;
    expect(report.costKnown).toBe(false);
    expect(report.costBasis).toBe("unknown");
    expect(report.estimatedCost).toBeNull();
  }, 30_000);
});

describe("crash cleanup removes incarnation tree", () => {
  it("session-keyed stderr-crash removes incarnationRoot and reports zero live", async () => {
    writeHostLogin();
    const fake = installFakeAcp("stderr-crash");
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId: "pr8-crash-session", ...harness() });
    expect(out.stopReason).toBe("error");
    const sessionNew = readFakeLog(fake.log).find((e: any) => e.dir === "session/new");
    expect(sessionNew).toBeDefined();
    const workspace = sessionNew.cwd as string;
    const incarnationRoot = dirname(dirname(workspace));
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(incarnationRoot)).toBe(false);
    expect(activeCliProcessCount()).toBe(0);
    expect(getCliProcess("pr8-crash-session")).toBeUndefined();
  }, 30_000);
  it("ephemeral stderr-crash removes incarnationRoot and reports zero live", async () => {
    writeHostLogin();
    const fake = installFakeAcp("stderr-crash");
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId: undefined, ...harness() });
    expect(out.stopReason).toBe("error");
    const sessionNew = readFakeLog(fake.log).find((e: any) => e.dir === "session/new");
    expect(sessionNew).toBeDefined();
    const workspace = sessionNew.cwd as string;
    const incarnationRoot = dirname(dirname(workspace));
    for (let i = 0; i < 50 && activeCliProcessCount() !== 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(activeCliProcessCount()).toBe(0);
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(incarnationRoot)).toBe(false);
  }, 30_000);
});

describe("late abort does not kill parked process", () => {
  it("abort after stop preserves parked cli and turn 2 reuses warm process", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const sessionId = "pr8-late-abort";
    const controller = new AbortController();
    const sys = "sys";
    const msg1: any = await runTurn(MODEL, { systemPrompt: sys, messages: [{ role: "user", content: "hello", timestamp: Date.now() }], tools: [] }, { sessionId, signal: controller.signal, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(msg1.stopReason).toBe("stop");
    const cli: any = getCliProcess(sessionId);
    expect(cli).toBeDefined();
    expect(cli.proc.killed).toBe(false);
    controller.abort();
    await new Promise((r) => setTimeout(r, 250));
    expect(cli.proc.killed).toBe(false);
    expect(getCliProcess(sessionId)).toBe(cli);
    expect(activeCliProcessCount()).toBe(1);
    const msg2: any = await runTurn(MODEL, { systemPrompt: sys, messages: [{ role: "user", content: "hello", timestamp: Date.now() }, msg1, { role: "user", content: "again", timestamp: Date.now() }], tools: [] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(msg2.stopReason).toBe("stop");
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "session/new")).toHaveLength(1);
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "prompt")).toHaveLength(2);
    expect(getCliProcess(sessionId)).toBe(cli);
  }, 30_000);
});

describe("typed ACP error beats marker text", () => {
  it("fake-signal-text classifies as context_overflow and sanitizes wire text", async () => {
    writeHostLogin();
    installFakeAcp("fake-signal-text");
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId: "pr8-signal-text", ...harness() });
    expect(out.stopReason).toBe("error");
    expect(/context_length_exceeded/.test(out.errorMessage)).toBe(true);
    expect(out.errorMessage.includes(String.fromCharCode(27))).toBe(false);
  }, 30_000);
});

describe("owned cancellable /vibe-status", () => {
  it("queryVibeAccountStatus aborts silent probe and removes probe home", async () => {
    writeHostLogin();
    installFakeAcp("silent");
    const controller = new AbortController();
    const promise = queryVibeAccountStatus({ signal: controller.signal });
    const watched = promise.then(() => new Error("expected rejection"), (caught: unknown) => caught as Error);
    await new Promise((r) => setTimeout(r, 400));
    controller.abort();
    const err = await watched;
    expect(err.message).toMatch(/abort/i);
    const entries = readdirSync(runtimeDir());
    expect(entries.filter((e) => e.startsWith("account-probe-"))).toEqual([]);
  }, 30_000);
  it("extension /vibe-status cancels in-flight probe on session_shutdown", async () => {
    writeHostLogin();
    installFakeAcp("silent");
    takeStartupNotices();
    const { pi, commands, handlers } = fakePi();
    await extensionDefault(pi as any);
    const statusCmd = commands.find((c: any) => c.name === "vibe-status");
    expect(statusCmd).toBeDefined();
    const notes: string[] = [];
    const ctx: any = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
    const cmdPromise: Promise<void> = statusCmd.def.handler("", ctx);
    await new Promise((r) => setTimeout(r, 400));
    const shutdownHandlers = handlers.get("session_shutdown") ?? [];
    for (const handler of shutdownHandlers) await handler({ type: "session_shutdown" }, ctx);
    await cmdPromise;
    const entries = readdirSync(runtimeDir());
    expect(entries.filter((e) => e.startsWith("account-probe-"))).toEqual([]);
  }, 30_000);
  it("aborting a parked silent-account query rejects promptly without killing the parked process and /vibe-status settles cleanly", async () => {
    writeHostLogin();
    installFakeAcp("silent-account");
    const h = harness();
    const sessionId = "pr8-silent-account";
    const msg: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(msg.stopReason).toBe("stop");
    const cli: any = getCliProcess(sessionId);
    expect(cli).toBeDefined();
    expect(cli.alive).toBe(true);
    expect(activeCliProcessCount()).toBe(1);
    // Direct query against the parked process: aborting must reject the
    // silent _account/read/_identity/read without killing that process.
    const controller = new AbortController();
    const started = Date.now();
    const promise = queryVibeAccountStatus({ signal: controller.signal });
    const watched = promise.then(() => new Error("expected rejection"), (caught: unknown) => caught as Error);
    setTimeout(() => controller.abort(), 50);
    const err = await watched;
    expect(err.message).toMatch(/abort/i);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(cli.alive).toBe(true);
    expect(getCliProcess(sessionId)).toBe(cli);
    expect(cli.proc.killed).toBe(false);
    expect(activeCliProcessCount()).toBe(1);
    // The same parked session through the registered /vibe-status command:
    // aborting via ctx.signal must settle cleanly with an error notification.
    takeStartupNotices();
    const { pi, commands } = fakePi();
    await extensionDefault(pi as any);
    const statusCmd = commands.find((c: any) => c.name === "vibe-status");
    expect(statusCmd).toBeDefined();
    const notes: string[] = [];
    const cmdController = new AbortController();
    const ctx: any = { hasUI: true, ui: { notify: (m: string) => notes.push(m) }, signal: cmdController.signal };
    const cmdPromise: Promise<void> = statusCmd.def.handler("", ctx);
    await new Promise((r) => setTimeout(r, 50));
    cmdController.abort();
    await cmdPromise;
    expect(notes.some((m) => m.includes("vibe status unavailable"))).toBe(true);
    expect(cli.alive).toBe(true);
    expect(getCliProcess(sessionId)).toBe(cli);
    expect(activeCliProcessCount()).toBe(1);
  }, 30_000);
});

describe("warm older-images vs 8-image attachment limit", () => {
  it("0 older + 9 current is refused with vibe-image-attachment-limit and not vibe-older-images", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const nine = Array.from({ length: 9 }, () => ({ type: "image", data: "AA==", mimeType: "image/png" }));
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: nine, timestamp: Date.now() }], tools: [] }, { sessionId: "pr8-limit-cold", notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(out.stopReason).toBe("error");
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "prompt")).toHaveLength(0);
    const limit = h.ledger.find((e) => e.key === "vibe-image-attachment-limit");
    expect(limit).toBeDefined();
    expect((limit as any).surface).toBe("screen");
    expect(limit!.message).toContain("8");
    expect(h.notified.some((m) => m.includes("allows at most 8 images"))).toBe(true);
    expect(h.ledger.some((e) => e.key === "vibe-older-images")).toBe(false);
  }, 30_000);
  it("warm 0 older + 9 new refuses without killing parked cli", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const sessionId = "pr8-limit-warm";
    const base = { systemPrompt: "sys", tools: [] };
    const firstUser = { role: "user", content: "hello", timestamp: Date.now() };
    const first: any = await runTurn(MODEL, { ...base, messages: [firstUser] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(first.stopReason).toBe("stop");
    const cliBefore: any = getCliProcess(sessionId);
    expect(cliBefore).toBeDefined();
    const nine = Array.from({ length: 9 }, () => ({ type: "image", data: "AA==", mimeType: "image/png" }));
    const refused: any = await runTurn(MODEL, { ...base, messages: [firstUser, first, { role: "user", content: nine, timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(refused.stopReason).toBe("error");
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "prompt")).toHaveLength(1);
    expect(h.ledger.some((e) => e.key === "vibe-image-attachment-limit" && (e as any).surface === "screen")).toBe(true);
    expect(h.notified.some((m) => m.includes("allows at most 8 images"))).toBe(true);
    expect(h.ledger.some((e) => e.key === "vibe-older-images")).toBe(false);
    expect(getCliProcess(sessionId)).toBe(cliBefore);
    expect(activeCliProcessCount()).toBe(1);
  }, 30_000);
  it("5 older + 4 new succeeds, sends 4 images and emits vibe-older-images", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const sessionId = "pr8-older-success";
    const base = { systemPrompt: "sys", tools: [] };
    const five = Array.from({ length: 5 }, () => ({ type: "image", data: "AA==", mimeType: "image/png" }));
    const first: any = await runTurn(MODEL, { ...base, messages: [{ role: "user", content: five, timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(first.stopReason).toBe("stop");
    const four = Array.from({ length: 4 }, () => ({ type: "image", data: "BB==", mimeType: "image/png" }));
    const second: any = await runTurn(MODEL, { ...base, messages: [{ role: "user", content: five, timestamp: Date.now() }, first, { role: "user", content: four, timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(second.stopReason).toBe("stop");
    expect(h.ledger.some((e) => e.key === "vibe-older-images" && (e as any).surface === "screen")).toBe(true);
    expect(h.notified.some((m) => m.includes("replaces older images"))).toBe(true);
    const prompts = readFakeLog(fake.log).filter((e: any) => e.dir === "prompt");
    expect(prompts).toHaveLength(2);
    const secondImages = (prompts[1].blocks as any[]).filter((b: any) => b.type === "image");
    expect(secondImages).toHaveLength(4);
  }, 30_000);
});

describe("cold replay thinking omission honesty", () => {
  it("WITH prior thinking mentions omitted thinking", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const h = harness();
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }, { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "hello" }] }, { role: "user", content: "next", timestamp: Date.now() }] }, { sessionId: "pr8-cold-with", ...h });
    expect(out.stopReason).toBe("stop");
    const entry = h.ledger.find((e) => e.key === "vibe-cold-replay:omitted-thinking");
    expect(entry).toBeDefined();
    expect((entry as any).surface).toBe("screen");
    expect(entry!.message).toContain("omitted prior thinking blocks");
    expect(h.notified.some((m) => m.includes("omitted prior thinking blocks"))).toBe(true);
  }, 30_000);
  it("WITHOUT prior thinking does not mention thinking", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const h = harness();
    const out: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }, { role: "assistant", content: [{ type: "text", text: "hello" }] }, { role: "user", content: "next", timestamp: Date.now() }] }, { sessionId: "pr8-cold-without", ...h });
    expect(out.stopReason).toBe("stop");
    const entry = h.ledger.find((e) => e.key === "vibe-cold-replay");
    expect(entry).toBeDefined();
    expect((entry as any).surface).toBe("screen");
    expect(entry!.message).not.toContain("thinking");
    expect(h.notified.some((m) => m.includes("replayed prior turns"))).toBe(true);
  }, 30_000);
});

describe("anonymous dedupe via provider", () => {
  it("anonymous screen disclosure dedupes while log-only never notifies", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const h = harness();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const coldCtx = (text: string) => ({
        systemPrompt: "sys",
        messages: [
          { role: "user", content: "hi", timestamp: Date.now() },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
          { role: "user", content: text, timestamp: Date.now() },
        ],
        tools: [],
      });
      const a: any = await runTurn(MODEL, coldCtx("next"), { sessionId: undefined, notify: h.notify, recordDisclosure: h.recordDisclosure });
      expect(a.stopReason).toBe("stop");
      const b: any = await runTurn(MODEL, coldCtx("next again"), { sessionId: undefined, notify: h.notify, recordDisclosure: h.recordDisclosure });
      expect(b.stopReason).toBe("stop");
      // Screen cold replay: ledger every time, notify once for the anonymous scope.
      expect(h.ledger.filter((e) => e.key === "vibe-cold-replay" && (e as any).surface === "screen")).toHaveLength(2);
      expect(h.notified.filter((m) => m.includes("replayed prior turns"))).toHaveLength(1);
      // Log-only system overhead: ledger every time, never notify/warn anonymously.
      expect(h.ledger.filter((e) => e.key === "vibe-system-overhead" && (e as any).surface === "log")).toHaveLength(2);
      expect(h.notified.filter((m) => m.includes("harness capability guidance"))).toHaveLength(0);
      expect(h.notified).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  }, 30_000);
});

describe("screen rule: log-only turns never reach the screen", () => {
  it("interleaved image/text turn notifies on screen with prompt-block separation, grouping stays silent, and refuses in strict mode", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const msg: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "what is this?" }], timestamp: Date.now() }] }, { sessionId: "screen-rule-separation", notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(msg.stopReason).toBe("stop");
    expect(h.ledger.some((e) => e.key === "vibe-prompt-block-separation" && (e as any).surface === "screen")).toBe(true);
    expect(h.notified.some((m) => m.includes("separates images from text blocks"))).toBe(true);
    expect(h.ledger.some((e) => e.key === "vibe-system-overhead" && (e as any).surface === "log")).toBe(true);
    // Grouped [text, text, image] emits neither ledger nor screen notice.
    const groupedH = harness();
    const grouped: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "a " }, { type: "text", text: "b " }, { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: Date.now() }] }, { sessionId: "screen-rule-separation-grouped", notify: groupedH.notify, recordDisclosure: groupedH.recordDisclosure });
    expect(grouped.stopReason).toBe("stop");
    expect(groupedH.ledger.some((e) => e.key === "vibe-prompt-block-separation")).toBe(false);
    expect(groupedH.notified.some((m) => m.includes("separates images"))).toBe(false);
    const prompts = readFakeLog(fake.log).filter((e: any) => e.dir === "prompt");
    expect(prompts.length).toBeGreaterThan(0);
    // Strict: refuses before any ACP launch/prompt.
    writeHostLogin();
    const fakeStrict = installFakeAcp("chat");
    process.env[STRICT_ENV] = "1";
    const hs = harness();
    const refused: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "what is this?" }], timestamp: Date.now() }] }, { sessionId: "screen-rule-separation-strict", notify: hs.notify, recordDisclosure: hs.recordDisclosure });
    expect(refused.stopReason).toBe("error");
    expect(hs.notified).toHaveLength(0);
    expect(hs.ledger.length).toBeGreaterThan(0);
    expect(readFakeLog(fakeStrict.log).filter((e: any) => e.dir === "prompt")).toHaveLength(0);
    delete process.env[STRICT_ENV];
  }, 30_000);

  it("temperature/maxTokens override turn notifies once per session per control on screen, and refuses in strict mode", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const sessionId = "screen-rule-controls";
    // Turn 1: both controls explicitly requested -> both notify once, ledger surface screen.
    const first: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure, temperature: 0.7, maxTokens: 1234 });
    expect(first.stopReason).toBe("stop");
    expect(h.ledger.some((e) => e.key === "vibe-unsupported-control:temperature" && (e as any).surface === "screen")).toBe(true);
    expect(h.ledger.some((e) => e.key === "vibe-unsupported-control:maxTokens" && (e as any).surface === "screen")).toBe(true);
    expect(h.notified.filter((m) => m.includes("temperature"))).toHaveLength(1);
    expect(h.notified.filter((m) => m.includes("maxTokens"))).toHaveLength(1);
    expect(h.notified).toHaveLength(2);
    // Turn 2: repeating the same control does not re-notify, but still ledgers.
    const second: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }, first, { role: "user", content: "again", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure, temperature: 0.7 });
    expect(second.stopReason).toBe("stop");
    expect(h.notified.filter((m) => m.includes("temperature"))).toHaveLength(1);
    expect(h.notified).toHaveLength(2);
    expect(h.ledger.filter((e) => e.key === "vibe-unsupported-control:temperature")).toHaveLength(2);
    expect(h.ledger.filter((e) => e.key === "vibe-unsupported-control:maxTokens")).toHaveLength(1);
    // Turn 3: newly requesting the other control on a later turn DOES notify.
    const third: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }, first, { role: "user", content: "again", timestamp: Date.now() }, second, { role: "user", content: "third", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure, maxTokens: 999 });
    expect(third.stopReason).toBe("stop");
    expect(h.notified.filter((m) => m.includes("maxTokens"))).toHaveLength(1);
    expect(h.ledger.filter((e) => e.key === "vibe-unsupported-control:maxTokens")).toHaveLength(2);
    // Plain turn with neither emits neither ledger nor screen notice.
    const plainH = harness();
    const plain: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "plain", timestamp: Date.now() }] }, { sessionId: "screen-rule-controls-plain", notify: plainH.notify, recordDisclosure: plainH.recordDisclosure });
    expect(plain.stopReason).toBe("stop");
    expect(plainH.ledger.some((e) => e.key.startsWith("vibe-unsupported-control"))).toBe(false);
    expect(plainH.notified).toHaveLength(0);
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "session/new")).toHaveLength(2);
    // Strict: still records ledger and refuses before ACP launch.
    writeHostLogin();
    const fakeStrict = installFakeAcp("chat");
    process.env[STRICT_ENV] = "1";
    const hs = harness();
    const refused: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { sessionId: "screen-rule-controls-strict", notify: hs.notify, recordDisclosure: hs.recordDisclosure, temperature: 0.7 });
    expect(refused.stopReason).toBe("error");
    expect(hs.notified).toHaveLength(0);
    expect(hs.ledger.some((e) => e.key === "vibe-unsupported-control:temperature" && (e as any).surface === "screen")).toBe(true);
    expect(readFakeLog(fakeStrict.log)).toEqual([]);
    delete process.env[STRICT_ENV];
  }, 30_000);

  it("leading slash-command turn records the collision in the ledger only, and refuses in strict mode", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const h = harness();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const msg: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "/compact hello", timestamp: Date.now() }] }, { sessionId: "screen-rule-slash", notify: h.notify, recordDisclosure: h.recordDisclosure });
      expect(msg.stopReason).toBe("stop");
      expect(h.notified).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(h.ledger.some((e) => e.key === "vibe-slash-command-collision" && (e as any).surface === "log")).toBe(true);
    } finally { warnSpy.mockRestore(); }
    writeHostLogin();
    installFakeAcp("chat");
    process.env[STRICT_ENV] = "1";
    const hs = harness();
    const refused: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "/compact hello", timestamp: Date.now() }] }, { sessionId: "screen-rule-slash-strict", notify: hs.notify, recordDisclosure: hs.recordDisclosure });
    expect(refused.stopReason).toBe("error");
    expect(hs.notified).toHaveLength(0);
    expect(hs.ledger.length).toBeGreaterThan(0);
    expect(hs.ledger.every((e: any) => e.surface === "log")).toBe(true);
    delete process.env[STRICT_ENV];
  }, 30_000);
});

describe("screen rule: extension integration", () => {
  async function invokeStart(fake: ReturnType<typeof fakePi>, sessionId: string, hasUI: boolean, notifications: string[], existingEntries: any[] = []) {
    const ctx: any = {
      hasUI,
      ui: { notify: (m: string) => notifications.push(m) },
      sessionManager: { getSessionId: () => sessionId, getEntries: () => existingEntries },
      model: { provider: "mistral-vibe" },
    };
    const handlers = fake.handlers.get("session_start") ?? [];
    for (const handler of handlers) await handler({ type: "session_start", model: { provider: "mistral-vibe" } }, ctx);
    return ctx;
  }
  async function extensionTurn(fake: ReturnType<typeof fakePi>, sessionId: string, context: any) {
    const provider = fake.providers[0];
    expect(provider).toBeDefined();
    const stream: any = provider.config.streamSimple(MODEL, context, { sessionId });
    return await stream.result();
  }

  it("hasUI true: fresh and tool turns produce zero ui.notify/warn while appending log disclosures", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    takeStartupNotices();
    const fake = fakePi();
    await extensionDefault(fake.pi as any);
    const notes: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await invokeStart(fake, "ext-screen-fresh", true, notes);
      const fresh: any = await extensionTurn(fake, "ext-screen-fresh", { systemPrompt: "sys", messages: [{ role: "user", content: "hello", timestamp: Date.now() }], tools: [] });
      expect(fresh.stopReason).toBe("stop");
      await invokeStart(fake, "ext-screen-tool", true, notes);
      // Tool turn needs the tool scenario for a handoff; reuse chat fake which answers text.
      const toolMsg: any = await extensionTurn(fake, "ext-screen-tool", { systemPrompt: "sys", messages: [{ role: "user", content: "hello tool", timestamp: Date.now() }], tools: [READ_TOOL] });
      expect(toolMsg.stopReason).toBe("stop");
      expect(notes).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
      const disclosures = fake.appended.filter((a: any) => a.entryType === DISCLOSURE_ENTRY_TYPE);
      expect(disclosures.some((a: any) => a.data.key === "vibe-system-overhead" && a.data.surface === "log")).toBe(true);
      expect(disclosures.some((a: any) => a.data.key === "vibe-builtin-schemas" && a.data.surface === "log")).toBe(true);
      expect(disclosures.every((a: any) => a.data.surface === "log")).toBe(true);
    } finally { warnSpy.mockRestore(); }
    const line = cliStatusLine();
    expect(line).toContain(`route facts (log-only; set ${STRICT_ENV}=1 to refuse):`);
    for (const fact of PERMANENT_ROUTE_FACTS ?? []) expect(line).toContain(fact);
  }, 30_000);

  it("hasUI false: fresh and tool turns produce zero warn while appending log disclosures", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    takeStartupNotices();
    const fake = fakePi();
    await extensionDefault(fake.pi as any);
    const notes: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await invokeStart(fake, "ext-screen-noui-fresh", false, notes);
      const fresh: any = await extensionTurn(fake, "ext-screen-noui-fresh", { systemPrompt: "sys", messages: [{ role: "user", content: "hello", timestamp: Date.now() }], tools: [] });
      expect(fresh.stopReason).toBe("stop");
      await invokeStart(fake, "ext-screen-noui-tool", false, notes);
      const toolMsg: any = await extensionTurn(fake, "ext-screen-noui-tool", { systemPrompt: "sys", messages: [{ role: "user", content: "hello tool", timestamp: Date.now() }], tools: [READ_TOOL] });
      expect(toolMsg.stopReason).toBe("stop");
      expect(notes).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
      const disclosures = fake.appended.filter((a: any) => a.entryType === DISCLOSURE_ENTRY_TYPE);
      expect(disclosures.some((a: any) => a.data.key === "vibe-system-overhead" && a.data.surface === "log")).toBe(true);
      expect(disclosures.some((a: any) => a.data.key === "vibe-builtin-schemas" && a.data.surface === "log")).toBe(true);
    } finally { warnSpy.mockRestore(); }
  }, 30_000);

  it("session_start replay hydrates screen disclosures but skips log-only entries", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    takeStartupNotices();
    const fake = fakePi();
    await extensionDefault(fake.pi as any);
    const notes: string[] = [];
    const sessionId = "ext-screen-replay";
    const existing = [
      { type: "custom", customType: DISCLOSURE_ENTRY_TYPE, data: { sessionId, key: "vibe-cold-replay", surface: "screen" } },
      { type: "custom", customType: DISCLOSURE_ENTRY_TYPE, data: { sessionId, key: "vibe-system-overhead", surface: "log" } },
    ];
    await invokeStart(fake, sessionId, true, notes, existing);
    // Screen entry hydrated: already seen. Log entry skipped: not seen.
    expect(rememberDisclosure(sessionId, "vibe-cold-replay")).toBe(false);
    expect(rememberDisclosure(sessionId, "vibe-system-overhead")).toBe(true);
    // Plain cold replay does NOT block the omitted-thinking variant.
    expect(rememberDisclosure(sessionId, "vibe-cold-replay:omitted-thinking")).toBe(true);
    // Persisted omitted-thinking IS hydrated (already seen after replay).
    const sessionId2 = "ext-screen-replay-omitted";
    const existing2 = [
      { type: "custom", customType: DISCLOSURE_ENTRY_TYPE, data: { sessionId: sessionId2, key: "vibe-cold-replay:omitted-thinking", surface: "screen" } },
    ];
    await invokeStart(fake, sessionId2, true, notes, existing2);
    expect(rememberDisclosure(sessionId2, "vibe-cold-replay:omitted-thinking")).toBe(false);
    expect(rememberDisclosure(sessionId2, "vibe-cold-replay")).toBe(true);
  }, 30_000);
});

describe("screen rule: parked process exit", () => {
  const expectedParkedExitMessage = "Parked vibe-acp process was killed (signal SIGKILL); its Vibe session cannot be reused, so Pi's history is replayed into a fresh session.";
  it("reports an unexpected parked kill on the next turn, notifies again for a second kill, and stays silent on orderly retirement", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const sessionId = "screen-parked-exit";
    const first: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(first.stopReason).toBe("stop");
    const parked1: any = getCliProcess(sessionId);
    expect(parked1).toBeDefined();
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "session/new")).toHaveLength(1);
    // Kill the parked child and wait for exit handling to retire it.
    parked1.proc.kill("SIGKILL");
    for (let i = 0; i < 50 && getCliProcess(sessionId) !== undefined; i++) await new Promise((r) => setTimeout(r, 100));
    expect(getCliProcess(sessionId)).toBeUndefined();
    expect(cliStatus().lastRetirement).toEqual(["exit"]);
    // Turn 2 opens a distinct ACP process and reports the kill on screen.
    const second: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hello", timestamp: Date.now() }, first, { role: "user", content: "again", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(second.stopReason).toBe("stop");
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "session/new")).toHaveLength(2);
    expect(h.notified.some((m) => /exited|killed|SIGKILL|restarted/.test(m))).toBe(true);
    expect(h.notified).toContain(expectedParkedExitMessage);
    const parkedEntry = h.ledger.find((e) => e.key === "vibe-parked-process-exit");
    expect(parkedEntry).toBeDefined();
    expect((parkedEntry as any).surface).toBe("screen");
    expect((parkedEntry as any).detail?.signal).toBe("SIGKILL");
    expect(parkedEntry!.message).toBe(expectedParkedExitMessage);
    // Killing the second parked child ALSO reports (not suppressed by dedupe).
    const parked2: any = getCliProcess(sessionId);
    expect(parked2).toBeDefined();
    parked2.proc.kill("SIGKILL");
    for (let i = 0; i < 50 && getCliProcess(sessionId) !== undefined; i++) await new Promise((r) => setTimeout(r, 100));
    expect(getCliProcess(sessionId)).toBeUndefined();
    const third: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hello", timestamp: Date.now() }, first, { role: "user", content: "again", timestamp: Date.now() }, second, { role: "user", content: "third", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(third.stopReason).toBe("stop");
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "session/new")).toHaveLength(3);
    expect(h.notified.filter((m) => /exited|killed|SIGKILL|restarted/.test(m))).toHaveLength(2);
    expect(h.notified.filter((m) => m === expectedParkedExitMessage)).toHaveLength(2);
    expect(h.ledger.filter((e) => e.key === "vibe-parked-process-exit")).toHaveLength(2);
    for (const entry of h.ledger.filter((e) => e.key === "vibe-parked-process-exit")) {
      expect(entry.message).toBe(expectedParkedExitMessage);
    }
    // Orderly retirement does NOT emit a parked-exit notice on the next turn.
    const ledgerBefore = h.ledger.filter((e) => e.key === "vibe-parked-process-exit").length;
    const notifiedBefore = h.notified.filter((m) => /exited|killed|SIGKILL|restarted/.test(m)).length;
    await retireCliProcess(sessionId, "test-orderly-retire");
    const fourth: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hello", timestamp: Date.now() }, first, { role: "user", content: "again", timestamp: Date.now() }, second, { role: "user", content: "third", timestamp: Date.now() }, third, { role: "user", content: "fourth", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(fourth.stopReason).toBe("stop");
    expect(h.ledger.filter((e) => e.key === "vibe-parked-process-exit")).toHaveLength(ledgerBefore);
    expect(h.notified.filter((m) => /exited|killed|SIGKILL|restarted/.test(m))).toHaveLength(notifiedBefore);
  }, 30_000);

  it("does not claim a restart before a replacement ACP session actually opens (refused turn)", async () => {
    writeHostLogin();
    const fixture = installFakeAcp("chat");
    const h = harness();
    const sessionId = "screen-parked-exit-refused-restart";
    const opts = { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure };
    const prior = { role: "user", content: "first", timestamp: Date.now() };
    const context = (...messages: any[]) => ({ systemPrompt: "sys", tools: [], messages });
    const first: any = await runTurn(MODEL, context(prior), opts);
    expect(first.stopReason).toBe("stop");
    expect(readFakeLog(fixture.log).filter((e: any) => e.dir === "session/new")).toHaveLength(1);
    const old: any = getCliProcess(sessionId);
    expect(old).toBeDefined();
    const exited = observeFixtureExit(old.proc, "exit");
    expect(old.proc.kill("SIGKILL")).toBe(true);
    expect(await exited).toEqual([null, "SIGKILL"]);
    for (let i = 0; i < 50 && getCliProcess(sessionId) !== undefined; i++) await new Promise((r) => setTimeout(r, 100));
    expect(getCliProcess(sessionId)).toBeUndefined();
    const notifiedBeforeRefusal = h.notified.length;
    const image = { type: "image", data: "AA==", mimeType: "image/png" };
    const rejected: any = await runTurn(MODEL, context(prior, first, {
      role: "user", content: Array.from({ length: 9 }, () => image), timestamp: Date.now(),
    }), opts);
    expect(rejected.stopReason).toBe("error");
    expect(readFakeLog(fixture.log).filter((e: any) => e.dir === "session/new")).toHaveLength(1);
    expect(getCliProcess(sessionId)).toBeUndefined();
    const seenAfterRefusal = h.notified.slice(notifiedBeforeRefusal);
    const parkedEntry = h.ledger.find((e) => e.key === "vibe-parked-process-exit");
    expect(parkedEntry).toBeDefined();
    expect((parkedEntry as any).surface).toBe("screen");
    expect((parkedEntry as any).detail?.signal).toBe("SIGKILL");
    expect(parkedEntry!.message).toBe(expectedParkedExitMessage);
    expect(seenAfterRefusal).toContain(expectedParkedExitMessage);
    for (const m of seenAfterRefusal) {
      expect(m).not.toMatch(/restarted/i);
      expect(m).not.toMatch(/next turn/i);
    }
    const recovered: any = await runTurn(MODEL, context(prior, first, {
      role: "user", content: "retry without attachments", timestamp: Date.now(),
    }), opts);
    expect(recovered.stopReason).toBe("stop");
    expect(readFakeLog(fixture.log).filter((e: any) => e.dir === "session/new")).toHaveLength(2);
    expect(h.ledger.filter((e) => e.key === "vibe-parked-process-exit")).toHaveLength(1);
  }, 30_000);
});

describe("screen rule: cold replay omitted thinking", () => {
  it("notifies plain first, then newly omitted thinking, then dedupes the repeat while still ledgering", async () => {
    writeHostLogin();
    installFakeAcp("chat");
    const h = harness();
    const sessionId = "screen-cold-omitted-seq";
    // First cold replay WITHOUT thinking notifies plain cold-replay warning.
    const first: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }, { role: "assistant", content: [{ type: "text", text: "hello" }] }, { role: "user", content: "next", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(first.stopReason).toBe("stop");
    expect(h.notified.some((m) => m.includes("replayed prior turns"))).toBe(true);
    expect(h.notified.some((m) => m.includes("omitted prior thinking"))).toBe(false);
    expect(h.ledger.some((e) => e.key === "vibe-cold-replay" && (e as any).surface === "screen")).toBe(true);
    expect(h.ledger.some((e) => e.key === "vibe-cold-replay:omitted-thinking")).toBe(false);
    // Orderly retire so the next turn is a genuine cold replay.
    await retireCliProcess(sessionId, "test-orderly-retire");
    // Second cold replay WITH prior thinking newly notifies with omitted message.
    const second: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }, { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "hello" }] }, { role: "user", content: "next", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(second.stopReason).toBe("stop");
    expect(h.notified.some((m) => m.includes("omitted prior thinking blocks"))).toBe(true);
    const omittedEntry = h.ledger.find((e) => e.key === "vibe-cold-replay:omitted-thinking");
    expect(omittedEntry).toBeDefined();
    expect((omittedEntry as any).surface).toBe("screen");
    // Third cold replay WITH prior thinking is deduped on screen while recording ledger.
    await retireCliProcess(sessionId, "test-orderly-retire-2");
    const notifiedOmittedBefore = h.notified.filter((m) => m.includes("omitted prior thinking")).length;
    const ledgerOmittedBefore = h.ledger.filter((e) => e.key === "vibe-cold-replay:omitted-thinking").length;
    const third: any = await runTurn(MODEL, { systemPrompt: "sys", tools: [], messages: [{ role: "user", content: "hi", timestamp: Date.now() }, { role: "assistant", content: [{ type: "thinking", thinking: "secret again" }, { type: "text", text: "hello again" }] }, { role: "user", content: "next", timestamp: Date.now() }] }, { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure });
    expect(third.stopReason).toBe("stop");
    expect(h.notified.filter((m) => m.includes("omitted prior thinking"))).toHaveLength(notifiedOmittedBefore);
    expect(h.ledger.filter((e) => e.key === "vibe-cold-replay:omitted-thinking")).toHaveLength(ledgerOmittedBefore + 1);
  }, 30_000);
});

describe("missing CLI on non-Vibe session_start", () => {
  it("does not notify on non-Vibe session_start but remains discoverable on /vibe-status", async () => {
    process.env.PI_MISTRAL_VIBE_TETHER_CLI = "/nonexistent/vibe-acp";
    writeHostLogin();
    takeStartupNotices();
    resetStatusForTests();
    const { pi, commands, handlers } = fakePi();
    await extensionDefault(pi as any);
    expect(cliStatus().lastError).toBeTruthy();
    const notes: string[] = [];
    const nonVibeCtx: any = {
      hasUI: true,
      ui: { notify: (m: string) => notes.push(m) },
      sessionManager: { getSessionId: () => "non-vibe-session", getEntries: () => [] },
      model: { provider: "other-provider" },
    };
    const sessionStartHandlers = handlers.get("session_start") ?? [];
    for (const handler of sessionStartHandlers) await handler({ type: "session_start", model: { provider: "other-provider" } }, nonVibeCtx);
    expect(notes.some((m) => m.includes("vibe-acp"))).toBe(false);
    const statusCmd = commands.find((c: any) => c.name === "vibe-status");
    expect(statusCmd).toBeDefined();
    const statusNotes: string[] = [];
    await statusCmd.def.handler("", { hasUI: true, ui: { notify: (m: string) => statusNotes.push(m) } });
    expect(statusNotes.join("\n")).toMatch(/vibe-acp|CLI not found|last error/i);
  }, 30_000);
});

describe('round3 independent boundary checks', () => {
  const user = { role: 'user', content: 'inert review fixture', timestamp: 1 };
  const context = { systemPrompt: 'offline fixture', messages: [user], tools: [] };

  it('requires a new settled snapshot after the last config write', async () => {
    writeHostLogin();
    const f = installFakeAcp('review3-missing-final-snapshot');
    const out: any = await runTurn(MODEL, context, { sessionId: 'review3-missing-final', ...harness() });
    const frames = readFakeLog(f.log);
    const witness = frames.find(e => e.dir === 'missing-final-snapshot');
    const outcome = { stop: out.stopReason, prompts: frames.filter(e => e.dir === 'prompt').length };
    expect(witness).toBeDefined();
    expect(outcome).toEqual({stop:'error',prompts:0});
  }, 30_000);

  it('requires a fresh thinking snapshot when thinking is the last setter', async () => {
    writeHostLogin();
    const f = installFakeAcp('review3-missing-final-thinking');
    const out: any = await runTurn(MODEL, context, { sessionId: 'review3-missing-final-thinking', reasoning: 'high', ...harness() });
    const frames = readFakeLog(f.log);
    const witness = frames.find(e => e.dir === 'missing-final-snapshot');
    const outcome = { stop: out.stopReason, prompts: frames.filter(e => e.dir === 'prompt').length };
    expect(witness).toBeDefined();
    expect(outcome).toEqual({stop:'error',prompts:0});
  }, 30_000);

  it('reports observed signal exit without turning unrelated stderr into a Pi compaction trigger', async () => {
    writeHostLogin();
    installFakeAcp('review3-kill-with-stderr');
    const out: any = await runTurn(MODEL,context,{sessionId:'review3-exit-provenance',...harness()});
    expect(out.stopReason).toBe('error');
    expect(out.errorMessage).toMatch(/signal SIGKILL/);
    expect(out.errorMessage).not.toMatch(/context(?:_| )window(?:_| )exceeded|context_length_exceeded/i);
    expect(isContextOverflow(out)).toBe(false);
    expect(rewriteOverflowMessage(out, "mistral-vibe", "mistral-vibe")).toBeUndefined();
    expect(out.stderrDiagnostic).toContain("previous diagnostic: context window exceeded");
  }, 30_000);

  it('settles the sibling account read after a parked status RPC fails', async () => {
    writeHostLogin();
    const f = installFakeAcp('review3-half-status');
    const {pi,commands} = fakePi();
    await extensionDefault(pi as any);
    const sessionId = 'review3-half-status';
    expect((await runTurn(MODEL,context,{sessionId,...harness()})).stopReason).toBe('stop');
    const cli: any = getCliProcess(sessionId);
    const cmd = commands.find((c: any) => c.name === 'vibe-status');
    const messages: string[] = [];
    for (const _ of [0,1]) await cmd.def.handler('', {hasUI:true, ui:{notify: (m: string)=>messages.push(m)}});
    await (cli as any).client.request('fixture/fence', {});
    const requests = readFakeLog(f.log).filter((e: any)=> e.dir==='in' && e.msg?.method==='_identity/read');
    expect(messages).toHaveLength(2);
    expect(getCliProcess(sessionId)).toBe(cli);
    expect((cli as any).client.pending.size).toBe(0);
  }, 30_000);

  it('settles parked status RPCs on retirement', async () => {
    writeHostLogin();
    installFakeAcp('silent-account');
    const sessionId = 'review3-parked-retire';
    expect((await runTurn(MODEL,context,{sessionId,...harness()})).stopReason).toBe('stop');
    const cli: any = getCliProcess(sessionId);
    expect(cli).toBeDefined();
    const started = Date.now();
    const pending = cli.readAccountStatus().then(() => new Error('expected rejection'), (e: unknown) => e as Error);
    await new Promise((r) => setTimeout(r, 200));
    expect((cli as any).client.pending.size).toBeGreaterThan(0);
    await cli.retire(['test-retire']);
    const err: unknown = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((cli as any).client.pending.size).toBe(0);
  }, 30_000);

  it('settles parked status RPCs on child SIGKILL', async () => {
    writeHostLogin();
    installFakeAcp('silent-account');
    const sessionId = 'review3-parked-kill';
    expect((await runTurn(MODEL,context,{sessionId,...harness()})).stopReason).toBe('stop');
    const cli: any = getCliProcess(sessionId);
    expect(cli).toBeDefined();
    const started = Date.now();
    const pending = cli.readAccountStatus().then(() => new Error('expected rejection'), (e: unknown) => e as Error);
    await new Promise((r) => setTimeout(r, 200));
    expect((cli as any).client.pending.size).toBeGreaterThan(0);
    (cli as any).proc.kill('SIGKILL');
    const err: unknown = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(5000);
    for (let i = 0; i < 50 && (cli as any).client.pending.size !== 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect((cli as any).client.pending.size).toBe(0);
  }, 30_000);
});

describe("cold session catalog refresh on model selection", () => {
  it("keeps the full catalog after selecting a remote model and accepts high reasoning on the next turn", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const rich = parseVibeCatalogCache({
      hash1: {
        stored_at_timestamp: 1_700_000_000,
        payload: {
          models: [
            { id: "deepseek-v4-1-flash-1017", label: "DeepSeek V4.1 Flash", max_context_length: 262_144, parameters: { reasoning: ["low"], auto_compact_threshold: null }, capabilities: { vision: false }, requires: null },
            { id: "mistral-large-4-0", label: "Mistral Large 4.0", max_context_length: 1_048_576, parameters: { reasoning: ["low"], auto_compact_threshold: 400_000 }, capabilities: { vision: true }, requires: null },
            { id: "mistral-medium-latest", label: "Mistral Medium Latest", max_context_length: 262_144, parameters: { reasoning: ["low"], auto_compact_threshold: null }, capabilities: { vision: true }, requires: null },
            { id: "mistral-medium-3.5", label: "Mistral Medium 3.5", max_context_length: 262_144, parameters: { reasoning: ["low"], auto_compact_threshold: null }, capabilities: { vision: false }, requires: null },
            { id: "zai-glm-5-3", label: "GLM 5.3", max_context_length: 262_144, parameters: { reasoning: ["low"], auto_compact_threshold: null }, capabilities: { vision: false }, requires: null },
            { id: "zai-glm-5-3-flash", label: "GLM 5.3 Flash", max_context_length: 262_144, parameters: { reasoning: ["low"], auto_compact_threshold: null }, capabilities: { vision: false }, requires: null },
          ],
        },
      },
    });
    expect(rich).toHaveLength(6);
    setVibeCatalog(rich);
    const deepseekModel: any = { ...MODEL, id: "deepseek-v4-1-flash-1017" };
    const sessionId = "e2e-catalog-refresh";
    const firstUser: any = { role: "user", content: "hello from the remote model", timestamp: Date.now() };
    const msg1: any = await runTurn(
      deepseekModel,
      { systemPrompt: "sys", messages: [firstUser], tools: [] },
      { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(msg1.stopReason).toBe("stop");
    expect(msg1.errorMessage).toBeUndefined();
    expect(vibeCatalog().map((spec) => spec.id)).toContain("deepseek-v4-1-flash-1017");
    expect(modelSpecFor("deepseek-v4-1-flash-1017")).toBeDefined();
    expect(modelSpecFor("deepseek-v4-1-flash-1017")!.effortLevels).toContain("high");
    const entriesAfterFirst = readFakeLog(fake.log);
    expect(entriesAfterFirst.some((e) => e.dir === "set_config_option" && e.configId === "model" && e.value === "deepseek-v4-1-flash-1017")).toBe(true);
    const secondUser: any = { role: "user", content: "now reason hard", timestamp: Date.now() };
    const msg2: any = await runTurn(
      deepseekModel,
      { systemPrompt: "sys", messages: [firstUser, msg1, secondUser], tools: [] },
      { sessionId, notify: h.notify, recordDisclosure: h.recordDisclosure, reasoning: "high" },
    );
    expect(msg2.stopReason).toBe("stop");
    expect(msg2.errorMessage).toBeUndefined();
  }, 30_000);
});

describe("first turn with consecutive user messages", () => {
  it("sends both user messages cleanly without a cold replay disclosure", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [
          { role: "user", content: "injected context for the turn", timestamp: Date.now() },
          { role: "user", content: "the actual user prompt", timestamp: Date.now() },
        ],
        tools: [],
      },
      { sessionId: "e2e-first-turn-users", notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(msg.stopReason).toBe("stop");
    expect(msg.errorMessage).toBeUndefined();
    expect(h.ledger.some((e) => e.key === "vibe-cold-replay")).toBe(false);
    expect(h.notified.some((m) => m.includes("replayed"))).toBe(false);
    const prompts = readFakeLog(fake.log).filter((e) => e.dir === "prompt");
    expect(prompts).toHaveLength(1);
    const texts = prompts[0].blocks.filter((b: any) => b.type === "text").map((b: any) => b.text);
    expect(texts).toContain("injected context for the turn");
    expect(texts).toContain("the actual user prompt");
  }, 30_000);
});

describe("cold refresh does not evict known models", () => {
  it("does not evict known model ids when an explicit refresh uses cold session/new options", async () => {
    writeHostLogin();
    const fake = installFakeAcp("chat");
    const { pi, providers } = fakePi();
    await extensionDefault(pi as any);
    const h = harness();
    const remote: any = { ...MODEL, id: "deepseek-v4-1-flash-1017" };
    const learned: any = await runTurn(
      remote,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hello", timestamp: Date.now() }], tools: [] },
      { sessionId: "e2e-cold-refresh", notify: h.notify, recordDisclosure: h.recordDisclosure },
    );
    expect(learned.stopReason).toBe("stop");
    expect(vibeCatalog().map((spec) => spec.id)).toContain("deepseek-v4-1-flash-1017");
    const before = readFakeLog(fake.log).length;
    const refreshed = await providers[0].config.refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
    });
    const wireFrames = readFakeLog(fake.log)
      .slice(before)
      .filter((entry: any) => entry.dir === "in")
      .map((entry: any) => entry.msg?.method);
    expect(wireFrames).toEqual(["initialize", "session/new"]);
    expect(refreshed.map((m: any) => m.id)).toContain("deepseek-v4-1-flash-1017");
    expect(readCachedCatalogWithAuthority()?.authority).toBe("partial");
    expect(readCachedCatalogWithAuthority()?.models.map((spec) => spec.id)).toContain("deepseek-v4-1-flash-1017");
  }, 30_000);
});
