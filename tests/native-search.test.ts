/**
 * Red-first coverage for opt-in native web search and page fetch.
 *
 * These tests pin the intended behavior before the production module
 * exists. The native search module is loaded dynamically so each case
 * fails with a clear expectation on the unimplemented base instead of
 * collapsing the whole file at import time.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  removeSessionVibeHome,
  stageProbeVibeHome,
  stageSessionVibeHome,
} from "../src/vibe-config.js";
import { buildRequestSignature, streamViaAcp } from "../src/provider.js";
import {
  activeCliProcessCount,
  getCliProcess,
  retireAllCliProcesses,
} from "../src/cli-process.js";
import { resetDisclosuresForTests, STRICT_ENV } from "../src/degradations.js";
import {
  cleanupRuntimeDir,
  resetRuntimeDirForTests,
} from "../src/runtime-dir.js";
import { resetLoginFaultForTests } from "../src/login.js";
import { resetStatusForTests } from "../src/cli-status.js";
import {
  FALLBACK_MODELS,
  setVibeCatalog,
} from "../src/catalog.js";
import { stopHandoffBroker } from "../src/handoff-broker.js";
import { takeStartupNotices } from "../src/startup-notices.js";
import { sessionVibeHome } from "../src/data-dir.js";
import { cliEnvironment, forceKillProcess, spawnAcpProbe } from "../src/process-manager.js";
import extensionDefault from "../index.js";

const NATIVE_ENV = "PI_MISTRAL_VIBE_TETHER_NATIVE_SEARCH";
const NOTICE_ENTRY_TYPE = "pi-mistral-vibe-tether:native-search-notice";
const SEARCH_ENTRY_TYPE = "pi-mistral-vibe-tether:native-search";
const PAGE_BODY = "PAGE-BODY-MARKER-EXTRA-LONG-UNIQUE-7f3a";

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

async function loadNativeSearch(): Promise<any | null> {
  try {
    return await import("../src/native-search.js");
  } catch {
    return null;
  }
}

async function requireNativeSearch(): Promise<any> {
  const mod = await loadNativeSearch();
  expect(mod, "native search module must exist").not.toBeNull();
  return mod;
}

const tempDirs: string[] = [];

function track<T extends string>(dir: T): T {
  tempDirs.push(dir);
  return dir;
}

function freshDir(prefix: string): string {
  return track(mkdtempSync(join(tmpdir(), prefix)));
}

function writeHostLogin(value = "host-login-fixture-value\n") {
  const home = process.env.PI_MISTRAL_VIBE_TETHER_SOURCE_VIBE_HOME!;
  writeFileSync(join(home, ".env"), value);
  return home;
}

function readFakeLog(logPath: string): any[] {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, "utf8");
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* partial last line */
    }
  }
  return entries;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterEach(async () => {
  delete process.env[NATIVE_ENV];
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
  takeStartupNotices();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/* ------------------------------------------------------------------ */
/* Fake vibe-acp speaking real ACP JSON-RPC over stdio.                */
/* ------------------------------------------------------------------ */

const FAKE_ACP_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { createInterface } = require("node:readline");
const scenario = process.env.FAKE_ACP_SCENARIO || "chat";
const logPath = process.env.FAKE_ACP_LOG || (process.env.VIBE_HOME ? process.env.VIBE_HOME + "/fake-log.jsonl" : undefined);
function log(entry) {
  if (!logPath) return;
  try { fs.appendFileSync(logPath, JSON.stringify(entry) + "\n"); } catch {}
}
function send(obj) { log({ dir: "out", msg: obj }); process.stdout.write(JSON.stringify(obj) + "\n"); }
log({ dir: "invoked", env: { VIBE_ENABLE_CONNECTORS: process.env.VIBE_ENABLE_CONNECTORS ?? null, VIBE_EXPERIMENTAL_ENABLE_DOCUMENT_LIBRARY_CONNECTOR: process.env.VIBE_EXPERIMENTAL_ENABLE_DOCUMENT_LIBRARY_CONNECTOR ?? null, VIBE_EXPERIMENTAL_ENABLE_MISTRAL_MCP_CONNECTOR: process.env.VIBE_EXPERIMENTAL_ENABLE_MISTRAL_MCP_CONNECTOR ?? null } });
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
let currentModeId = "auto";
const availableModes = [{ id: "ask", name: "Ask" }, { id: "auto", name: "Auto" }];
function sendUpdate(update) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sessionId, update: update } }); }
function usageFor() { return { inputTokens: 1000, outputTokens: 100, cachedReadTokens: 200 }; }
const pendingServerRequests = new Map();
function serverRequest(method, params) {
  return new Promise(function(resolve, reject) {
    const id = serverSeq++;
    pendingServerRequests.set(id, { resolve: resolve, reject: reject });
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
  });
}
function allowOptions(allowId) {
  return [
    { optionId: allowId, kind: "allow_once", name: "Allow once" },
    { optionId: "always-tok", kind: "allow_always", name: "Allow always" },
    { optionId: "reject-tok", kind: "reject_once", name: "Reject once" },
  ];
}
async function askPermission(callId, toolName, input, options) {
  const params = {
    sessionId: sessionId,
    toolCall: { toolCallId: callId, _meta: { tool_name: toolName }, rawInput: input, input: input },
    options: options,
  };
  const ans = await serverRequest("session/request_permission", params);
  log({ dir: "permission", callId: callId, toolName: toolName, input: input, answer: ans });
  return ans;
}
// Identifier-only permission request, as stock Vibe 3.1.5 can send it:
// a ToolCallUpdate carrying only the tool_call_id, with no _meta.tool_name
// and no prior tool_call frame. The call id IS the wire identifier.
async function askIdentifierPermission(callId, input, options) {
  const ans = await serverRequest("session/request_permission", {
    sessionId: sessionId,
    toolCall: { toolCallId: callId, rawInput: input, input: input },
    options: options,
  });
  log({ dir: "permission", callId: callId, toolName: callId, input: input, answer: ans, identifierOnly: true });
  return ans;
}
function toolCallFrame(callId, toolName, input, kind) {
  sendUpdate({
    sessionUpdate: "tool_call",
    toolCallId: callId,
    id: callId,
    callId: callId,
    kind: kind || "other",
    title: toolName,
    status: "in_progress",
    rawInput: input,
    input: input,
    _meta: { tool_name: toolName },
    tool_name: toolName,
  });
}

async function handlePrompt(id, params) {
  turn += 1;
  const promptBlocks = params.prompt || [];
  log({ dir: "prompt", turn: turn, blocks: promptBlocks });

  if (scenario === "native-off") {
    toolCallFrame("ns-search-1", "connector_web_search.web_search", { query: "native off query" }, "search");
    await askPermission("ns-search-1", "connector_web_search.web_search", { query: "native off query" }, allowOptions("once-tok"));
    toolCallFrame("ns-fetch-1", "connector_web_search.open_url", { url: "https://example.com/page-one" }, "fetch");
    await askPermission("ns-fetch-1", "connector_web_search.open_url", { url: "https://example.com/page-one" }, allowOptions("once-fetch"));
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "native off done" } });
    send({ jsonrpc: "2.0", id: id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }

  if (scenario === "native-on") {
    const searchInput = { query: "ranked web query one" };
    toolCallFrame("ns-search-1", "connector_web_search.web_search", searchInput, "search");
    const searchAns = await askPermission("ns-search-1", "connector_web_search.web_search", searchInput, allowOptions("once-tok"));
    log({ dir: "permission-selected", callId: "ns-search-1", answer: searchAns });
    if (searchAns && searchAns.outcome && searchAns.outcome.outcome === "selected") {
      sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "ns-search-1",
        id: "ns-search-1",
        callId: "ns-search-1",
        status: "completed",
        rawOutput: {
          sources: [
            { title: "First Result", url: "https://example.com/first" },
            { title: "Second Result", url: "https://example.com/second" },
          ],
          locations: [
            { path: "https://example.com/first", _meta: { title: "First Result" } },
            { path: "https://example.com/second", _meta: { title: "Second Result" } },
          ],
        },
        locations: [
          { path: "https://example.com/first", _meta: { title: "First Result" } },
          { path: "https://example.com/second", _meta: { title: "Second Result" } },
        ],
        _meta: { tool_name: "connector_web_search.web_search" },
        tool_name: "connector_web_search.web_search",
      });
    }
    const fetchInput = { url: "https://example.com/page-one" };
    toolCallFrame("ns-fetch-1", "connector_web_search.open_url", fetchInput, "fetch");
    const fetchAns = await askPermission("ns-fetch-1", "connector_web_search.open_url", fetchInput, allowOptions("once-fetch"));
    if (fetchAns && fetchAns.outcome && fetchAns.outcome.outcome === "selected") {
      const content = "PAGE-BODY-MARKER-EXTRA-LONG-UNIQUE-7f3a";
      sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "ns-fetch-1",
        id: "ns-fetch-1",
        callId: "ns-fetch-1",
        status: "completed",
        rawOutput: { content: content, url: "https://example.com/page-one" },
        locations: [
          { path: "https://example.com/page-one", _meta: { title: "Page One", char_count: content.length } },
        ],
        _meta: { tool_name: "connector_web_search.open_url" },
        tool_name: "connector_web_search.open_url",
      });
    }
    const deniedCases = [
      ["ns-finance", "connector_web_search.finance_search", { query: "finance query" }],
      ["ns-news", "connector_web_search.news_search", { query: "news query" }],
      ["ns-weather", "connector_web_search.weather_search", { query: "weather query" }],
      ["ns-gmail", "connector_gmail.read_email", { id: "msg-1" }],
      ["ns-bash", "bash", { command: "ls" }],
      ["ns-readfile", "read_file", { path: "sample.txt" }],
      ["ns-webfetch", "web_fetch", { url: "https://example.com/page-two" }],
    ];
    for (const entry of deniedCases) {
      toolCallFrame(entry[0], entry[1], entry[2], "other");
      await askPermission(entry[0], entry[1], entry[2], allowOptions("once-x"));
    }
    toolCallFrame("ns-fn", "search_tool_functions", { query: "mcp_pi" }, "other");
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "native on done" } });
    send({ jsonrpc: "2.0", id: id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }

  if (scenario === "pi-identifier") {
    // Stock Vibe 3.1.5 identifier-only shapes with Pi's "read" tool declared:
    // pi_read (identifier only) must be approved via the declared Pi path;
    // the explicit mcp_pi.read control must select its offered token;
    // identifier-only connector ids must be cancelled, never authorized
    // through a call-id fallback.
    await askIdentifierPermission("pi_read", { path: "sample.txt" }, allowOptions("declared-id-only"));
    await askPermission("pi-control", "mcp_pi.read", { path: "sample.txt" }, allowOptions("declared-explicit-tok"));
    await askIdentifierPermission("connector_web_search.web_search", { query: "identifier only query" }, allowOptions("once-connector"));
    await askIdentifierPermission("connector_web_search.finance_search", { query: "identifier only finance query" }, allowOptions("once-finance"));
    await askIdentifierPermission("finance_search", { query: "identifier only bare finance query" }, allowOptions("once-bare-finance"));
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "identifier done" } });
    send({ jsonrpc: "2.0", id: id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }

  if (scenario === "native-spoof") {
    const ans = await serverRequest("session/request_permission", {
      sessionId: sessionId,
      toolCall: {
        toolCallId: "connector_web_search.web_search",
        rawInput: { query: "spoof query" },
        input: { query: "spoof query" },
      },
      options: allowOptions("once-tok"),
    });
    log({ dir: "permission", callId: "connector_web_search.web_search", toolName: "connector_web_search.web_search", input: { query: "spoof query" }, answer: ans, spoof: true });
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "spoof done" } });
    send({ jsonrpc: "2.0", id: id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }

  if (scenario === "native-invalid") {
    const cases = [
      ["ns-file", "connector_web_search.open_url", { url: "file:///etc/passwd" }],
      ["ns-js", "connector_web_search.open_url", { url: "javascript:alert(1)" }],
      ["ns-blank", "connector_web_search.web_search", { query: "   " }],
      ["ns-empty-q", "connector_web_search.web_search", { query: "" }],
    ];
    for (const entry of cases) {
      toolCallFrame(entry[0], entry[1], entry[2], "other");
      await askPermission(entry[0], entry[1], entry[2], allowOptions("once-x"));
    }
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "invalid done" } });
    send({ jsonrpc: "2.0", id: id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }

  if (scenario === "native-missing-once") {
    toolCallFrame("ns-search-1", "connector_web_search.web_search", { query: "missing option query" }, "search");
    const options = [
      { optionId: "always-tok", kind: "allow_always", name: "Allow always" },
      { optionId: "reject-tok", kind: "reject_once", name: "Reject once" },
    ];
    const ans = await serverRequest("session/request_permission", {
      sessionId: sessionId,
      toolCall: { toolCallId: "ns-search-1", _meta: { tool_name: "connector_web_search.web_search" }, rawInput: { query: "missing option query" }, input: { query: "missing option query" } },
      options: options,
    });
    log({ dir: "permission", callId: "ns-search-1", toolName: "connector_web_search.web_search", input: { query: "missing option query" }, answer: ans });
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "missing once done" } });
    send({ jsonrpc: "2.0", id: id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }

  if (scenario === "native-fallback") {
    toolCallFrame("ns-search-1", "connector_web_search.web_search", { query: "fallback query" }, "search");
    const searchAns = await askPermission("ns-search-1", "connector_web_search.web_search", { query: "fallback query" }, allowOptions("once-tok"));
    if (searchAns && searchAns.outcome && searchAns.outcome.outcome === "selected") {
      const locs = [
        { path: "https://example.com/loc-a", _meta: { title: "Loc A" } },
        { path: "https://example.com/loc-b", _meta: { title: "Loc B" } },
      ];
      sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "ns-search-1",
        id: "ns-search-1",
        callId: "ns-search-1",
        status: "completed",
        rawOutput: { locations: locs },
        locations: locs,
        _meta: { tool_name: "connector_web_search.web_search" },
        tool_name: "connector_web_search.web_search",
      });
    }
    toolCallFrame("ns-fetch-1", "connector_web_search.open_url", { url: "https://example.com/fallback-page" }, "fetch");
    const fetchAns = await askPermission("ns-fetch-1", "connector_web_search.open_url", { url: "https://example.com/fallback-page" }, allowOptions("once-fetch"));
    if (fetchAns && fetchAns.outcome && fetchAns.outcome.outcome === "selected") {
      const locs = [
        { path: "https://example.com/fallback-page", _meta: { title: "Fallback Page", char_count: 1234 } },
      ];
      sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "ns-fetch-1",
        id: "ns-fetch-1",
        callId: "ns-fetch-1",
        status: "completed",
        rawOutput: { locations: locs },
        locations: locs,
        _meta: { tool_name: "connector_web_search.open_url" },
        tool_name: "connector_web_search.open_url",
      });
    }
    sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fallback done" } });
    send({ jsonrpc: "2.0", id: id, result: { stopReason: "end_turn", usage: usageFor() } });
    return;
  }

  if (scenario === "native-abort") {
    toolCallFrame("abort-search-1", "connector_web_search.web_search", { query: "abort query" }, "search");
    log({ dir: "in_progress", callId: "abort-search-1", toolName: "connector_web_search.web_search" });
    return;
  }

  const reply = "reply to: " + JSON.stringify(promptBlocks).slice(0, 400);
  sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
  send({ jsonrpc: "2.0", id: id, result: { stopReason: "end_turn", usage: usageFor() } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  log({ dir: "in", msg: msg });
  if (msg.method === undefined) {
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
    send({ jsonrpc: "2.0", id: id, result: { agentInfo: { version: "3.1.5", name: "vibe" }, agentCapabilities: { promptCapabilities: { image: true } } } });
  } else if (msg.method === "session/new") {
    mcpServerEntry = (params.mcpServers && params.mcpServers[0]) || undefined;
    log({ dir: "session/new", cwd: params.cwd, mcpServers: params.mcpServers, hasMcp: !!mcpServerEntry });
    send({ jsonrpc: "2.0", id: id, result: { sessionId: sessionId, configOptions: configOptions, modes: { availableModes: availableModes, currentModeId: currentModeId } } });
  } else if (msg.method === "session/set_config_option") {
    const opt = configOptions.find((o) => o.id === params.configId);
    if (opt) opt.currentValue = params.value;
    log({ dir: "set_config_option", configId: params.configId, value: params.value });
    send({ jsonrpc: "2.0", id: id, result: { configOptions: configOptions } });
  } else if (msg.method === "session/set_mode") {
    log({ dir: "set_mode", modeId: params.modeId });
    currentModeId = params.modeId;
    const modeOpt = configOptions.find((o) => o.id === "mode");
    if (modeOpt) modeOpt.currentValue = params.modeId;
    send({ jsonrpc: "2.0", id: id, result: {} });
  } else if (msg.method === "session/prompt") {
    void handlePrompt(id, params);
  } else if (msg.method === "fixture/fence") {
    send({ jsonrpc: "2.0", id: id, result: {} });
  } else if (msg.method === "_account/read") {
    if (scenario === "silent-account") return;
    send({ jsonrpc: "2.0", id: id, result: { plan: { name: "Vibe EDU", title: "Vibe Education" }, budget: { usagePercentage: 42, resetAt: "2026-12-01T00:00:00Z", paygEnabled: false }, keyScope: "vibe:read", accessScope: "full" } });
  } else if (msg.method === "_identity/read") {
    if (scenario === "silent-account") return;
    send({ jsonrpc: "2.0", id: id, result: { workspace: "workspace-1", organization: "org-1", keyScope: "vibe:read", accessScope: "full" } });
  } else {
    send({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "unsupported method " + msg.method } });
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

interface Harness {
  notified: string[];
  ledger: any[];
  nativeEntries: any[];
  announced: any[];
  opts: any;
}

function harness(): Harness {
  const notified: string[] = [];
  const ledger: any[] = [];
  const nativeEntries: any[] = [];
  const announced: any[] = [];
  const recordNative = (entry: any) => {
    nativeEntries.push(entry);
  };
  const opts: any = {
    notify: (m: string) => notified.push(m),
    recordDisclosure: (e: any) => ledger.push(e),
    nativeSearch: { announce: () => { announced.push(true); }, record: recordNative },
  };
  return { notified, ledger, nativeEntries, announced, opts };
}

async function runTurn(model: any, context: any, opts: any): Promise<any> {
  const stream: any = streamViaAcp(model, context, opts);
  return await stream.result();
}

function permissionLog(fake: { log: string }): any[] {
  return readFakeLog(fake.log).filter((e: any) => e.dir === "permission");
}

function sessionConfigText(sessionId: string): string {
  const cli: any = getCliProcess(sessionId);
  const home = cli?.vibeHome ?? sessionVibeHome(sessionId);
  return readFileSync(join(home, "config.toml"), "utf8");
}

/* ------------------------------------------------------------------ */
/* Module constants and flag helper                                    */
/* ------------------------------------------------------------------ */

describe("native search module surface", () => {
  it("exports the documented constants", async () => {
    const mod = await requireNativeSearch();
    expect(mod.NATIVE_SEARCH_ENV).toBe(NATIVE_ENV);
    expect(mod.NATIVE_SEARCH_NOTICE_ENTRY).toBe(NOTICE_ENTRY_TYPE);
    expect(mod.NATIVE_SEARCH_ENTRY).toBe(SEARCH_ENTRY_TYPE);
    expect(typeof mod.NATIVE_SEARCH_NOTICE).toBe("string");
    expect(mod.NATIVE_SEARCH_NOTICE.startsWith("Vibe may search and open web pages itself; its sources appear here.")).toBe(true);
  });

  it("enables only when the flag is exactly 1", async () => {
    const mod = await requireNativeSearch();
    expect(typeof mod.nativeSearchEnabled).toBe("function");
    const cases: Array<[string | undefined, boolean]> = [
      ["1", true],
      [undefined, false],
      ["0", false],
      ["true", false],
      ["", false],
      ["1 ", false],
      ["01", false],
      ["yes", false],
    ];
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env[NATIVE_ENV];
      else process.env[NATIVE_ENV] = value;
      expect(mod.nativeSearchEnabled()).toBe(expected);
    }
    delete process.env[NATIVE_ENV];
  });

  it("authorizes only the two web tools", async () => {
    const mod = await requireNativeSearch();
    expect(typeof mod.isAuthorizedNativeSearchTool).toBe("function");
    expect(mod.isAuthorizedNativeSearchTool("connector_web_search.web_search")).toBe(true);
    expect(mod.isAuthorizedNativeSearchTool("connector_web_search.open_url")).toBe(true);
    const denied: Array<string | undefined> = [
      undefined,
      "",
      "connector_web_search.finance_search",
      "connector_web_search.news_search",
      "connector_web_search.weather_search",
      "connector_gmail.read_email",
      "connector_web_search.web_search ",
      "Connector_Web_Search.Web_Search",
      "web_search",
      "web_fetch",
      "bash",
      "read_file",
      "mcp_pi.read",
      "connector_web_search.web_search.extra",
      "connector_web_search..web_search",
    ];
    for (const name of denied) {
      expect(mod.isAuthorizedNativeSearchTool(name), String(name)).toBe(false);
    }
  });

  it("validates web_search query input", async () => {
    const mod = await requireNativeSearch();
    expect(typeof mod.isValidNativeSearchInput).toBe("function");
    expect(mod.isValidNativeSearchInput("connector_web_search.web_search", { query: "hello world" })).toBe(true);
    expect(mod.isValidNativeSearchInput("connector_web_search.web_search", { query: "a" })).toBe(true);
    expect(mod.isValidNativeSearchInput("connector_web_search.web_search", { query: " hello ", limit: 5 })).toBe(true);
    const invalid: unknown[] = [
      { query: "" },
      { query: "   " },
      { query: " \t\n " },
      {},
      { query: 42 },
      { query: null },
      { query: undefined },
      null,
      undefined,
      "hello",
      [],
      { url: "https://example.com" },
    ];
    for (const input of invalid) {
      expect(mod.isValidNativeSearchInput("connector_web_search.web_search", input), JSON.stringify(input)).toBe(false);
    }
    expect(mod.isValidNativeSearchInput("connector_web_search.web_search", { query: "ok" }, { tool_name: "connector_web_search.web_search" })).toBe(true);
  });

  it("validates open_url input and rejects non-http schemes", async () => {
    const mod = await requireNativeSearch();
    expect(mod.isValidNativeSearchInput("connector_web_search.open_url", { url: "https://example.com/page" })).toBe(true);
    expect(mod.isValidNativeSearchInput("connector_web_search.open_url", { url: "http://example.com/" })).toBe(true);
    expect(mod.isValidNativeSearchInput("connector_web_search.open_url", { url: "HTTPS://example.com/upper" })).toBe(true);
    expect(mod.isValidNativeSearchInput("connector_web_search.open_url", { url: "example.com/bare-host" })).toBe(true);
    const invalid: unknown[] = [
      { url: "" },
      { url: "   " },
      { url: "file:///etc/passwd" },
      { url: "file:///etc/passwd" },
      { url: "javascript:alert(1)" },
      { url: "JavaScript:alert(1)" },
      { url: "data:text/plain,hello" },
      { url: "ftp://example.com/file" },
      { url: "blob:https://example.com/uuid" },
      { url: "mailto:someone@example" },
      {},
      { url: 42 },
      { url: null },
      null,
      undefined,
      "https://example.com",
    ];
    for (const input of invalid) {
      expect(mod.isValidNativeSearchInput("connector_web_search.open_url", input), JSON.stringify(input)).toBe(false);
    }
  });

  it("rejects every other tool name at input validation", async () => {
    const mod = await requireNativeSearch();
    const names = [
      "connector_web_search.finance_search",
      "connector_web_search.news_search",
      "connector_web_search.weather_search",
      "connector_gmail.read_email",
      "bash",
      "read_file",
      "web_fetch",
      "search_tool_functions",
      "",
    ];
    for (const name of names) {
      expect(mod.isValidNativeSearchInput(name, { query: "hello", url: "https://example.com" }), name).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Staging: connector narrowing                                        */
/* ------------------------------------------------------------------ */

describe("stageSessionVibeHome native search narrowing", () => {
  it("keeps connectors disabled when nativeSearch is omitted", async () => {
    const dir = freshDir("t-native-off-");
    const home = await stageSessionVibeHome({
      sessionId: "ns-off-omitted",
      systemPrompt: "sys",
      hasTools: true,
      vibeHome: dir,
    } as any);
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain("enable_connectors = false");
    expect(config).toContain('enabled_tools = ["pi_*"]');
    expect(config).not.toContain("[[connectors]]");
    expect(config).not.toContain("connector_web_search");
    const agent = readFileSync(join(home, "agents", "pi.toml"), "utf8");
    expect(agent).toContain('enabled_tools = ["pi_*"]');
  });

  it("keeps connectors disabled when nativeSearch is false", async () => {
    const dir = freshDir("t-native-off-false-");
    const home = await stageSessionVibeHome({
      sessionId: "ns-off-false",
      systemPrompt: "sys",
      hasTools: true,
      vibeHome: dir,
      nativeSearch: false,
    } as any);
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain("enable_connectors = false");
    expect(config).toContain('enabled_tools = ["pi_*"]');
    expect(config).not.toContain("[[connectors]]");
    const agent = readFileSync(join(home, "agents", "pi.toml"), "utf8");
    expect(agent).toContain('enabled_tools = ["pi_*"]');
  });

  it("keeps wildcard denial for a tool-less session when nativeSearch is false", async () => {
    const dir = freshDir("t-native-off-quiet-");
    const home = await stageSessionVibeHome({
      sessionId: "ns-off-quiet",
      systemPrompt: "sys",
      hasTools: false,
      vibeHome: dir,
      nativeSearch: false,
    } as any);
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain("enable_connectors = false");
    expect(config).toContain('disabled_tools = ["*"]');
  });

  it("enables the narrowed set with Pi tools when nativeSearch is true", async () => {
    const dir = freshDir("t-native-on-tools-");
    const home = await stageSessionVibeHome({
      sessionId: "ns-on-tools",
      systemPrompt: "sys",
      hasTools: true,
      vibeHome: dir,
      nativeSearch: true,
    } as any);
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain("enable_connectors = true");
    expect(config).toContain("experimental_enable_document_library_connector = false");
    expect(config).toContain("experimental_enable_mistral_mcp_connector = false");
    expect(config).toContain("[[connectors]]");
    expect(config).toContain('name = "web_search"');
    expect(config).toContain("disabled = false");
    expect(config).toContain('disabled_tools = ["finance_search", "news_search", "weather_search"]');
    expect(config).toContain('enabled_tools = ["pi_*", "connector_web_search_web_search", "connector_web_search_open_url"]');
    expect(config).not.toContain('disabled_tools = ["*"]');
    const agent = readFileSync(join(home, "agents", "pi.toml"), "utf8");
    expect(agent).toContain('enabled_tools = ["pi_*", "connector_web_search_web_search", "connector_web_search_open_url"]');
    expect(agent).not.toContain('disabled_tools = ["*"]');
  });

  it("enables the narrowed set without Pi tools when nativeSearch is true", async () => {
    const dir = freshDir("t-native-on-quiet-");
    const home = await stageSessionVibeHome({
      sessionId: "ns-on-quiet",
      systemPrompt: "sys",
      hasTools: false,
      vibeHome: dir,
      nativeSearch: true,
    } as any);
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain("enable_connectors = true");
    expect(config).toContain('enabled_tools = ["connector_web_search_web_search", "connector_web_search_open_url"]');
    expect(config).not.toContain('disabled_tools = ["*"]');
    expect(config).toContain("[[connectors]]");
    const agent = readFileSync(join(home, "agents", "pi.toml"), "utf8");
    expect(agent).toContain('enabled_tools = ["connector_web_search_web_search", "connector_web_search_open_url"]');
    expect(agent).not.toContain('disabled_tools = ["*"]');
  });

  it("names the web tools in the routing note when nativeSearch is true", async () => {
    const dir = freshDir("t-native-on-note-");
    const home = await stageSessionVibeHome({
      sessionId: "ns-on-note",
      systemPrompt: "sys base",
      hasTools: true,
      vibeHome: dir,
      toolNames: ["read"],
      nativeSearch: true,
    } as any);
    const staged = readFileSync(join(home, "prompts", "pi.md"), "utf8");
    expect(staged).toContain("connector_web_search.web_search");
    expect(staged).toContain("connector_web_search.open_url");
    expect(staged).toContain("mcp_pi");
  });

  it("keeps the probe home connectors disabled even when the flag is on", async () => {
    process.env[NATIVE_ENV] = "1";
    const dir = freshDir("t-native-probe-");
    await stageProbeVibeHome(dir);
    const config = readFileSync(join(dir, "config.toml"), "utf8");
    expect(config).toContain("enable_connectors = false");
    expect(config).not.toContain("enable_connectors = true");
    expect(config).not.toContain("[[connectors]]");
    delete process.env[NATIVE_ENV];
  });

  it("removes staged homes used by narrowing checks", async () => {
    await stageSessionVibeHome({
      sessionId: "ns-remove",
      systemPrompt: "sys",
      hasTools: true,
      nativeSearch: true,
    } as any);
    await removeSessionVibeHome("ns-remove");
    expect(existsSync(sessionVibeHome("ns-remove"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Request signature                                                   */
/* ------------------------------------------------------------------ */

describe("buildRequestSignature native search marker", () => {
  const base = {
    modelId: "mistral-large-4-0",
    effort: "high",
    systemPrompt: "sys",
    tools: [
      {
        name: "read",
        description: "Read",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };

  it("is identical when nativeSearch is omitted", () => {
    const plain = buildRequestSignature(base as any);
    const explicit = buildRequestSignature({ ...base } as any);
    expect(plain).toBe(explicit);
  });

  it("is identical when nativeSearch is false", () => {
    const plain = buildRequestSignature(base as any);
    const off = buildRequestSignature({ ...base, nativeSearch: false } as any);
    expect(off).toBe(plain);
  });

  it("differs when nativeSearch is true", () => {
    const plain = buildRequestSignature(base as any);
    const on = buildRequestSignature({ ...base, nativeSearch: true } as any);
    expect(typeof on).toBe("string");
    expect(on).not.toBe(plain);
  });

  it("is stable across repeated true calls", () => {
    const first = buildRequestSignature({ ...base, nativeSearch: true } as any);
    const second = buildRequestSignature({ ...base, nativeSearch: true } as any);
    expect(first).toBe(second);
  });
});

/* ------------------------------------------------------------------ */
/* Watcher: visible search and fetch entries                           */
/* ------------------------------------------------------------------ */

function makeWatcher(mod: any) {
  const entries: any[] = [];
  const watcher = mod.watchNativeSearch((entry: any) => entries.push(entry));
  return { entries, watcher };
}

function searchCall(id: string, query: string) {
  return {
    sessionUpdate: "tool_call",
    toolCallId: id,
    id,
    callId: id,
    kind: "search",
    title: "Web search",
    status: "in_progress",
    rawInput: { query },
    input: { query },
    _meta: { tool_name: "connector_web_search.web_search" },
    tool_name: "connector_web_search.web_search",
  };
}

function fetchCall(id: string, url: string) {
  return {
    sessionUpdate: "tool_call",
    toolCallId: id,
    id,
    callId: id,
    kind: "fetch",
    title: "Open page",
    status: "in_progress",
    rawInput: { url },
    input: { url },
    _meta: { tool_name: "connector_web_search.open_url" },
    tool_name: "connector_web_search.open_url",
  };
}

describe("watchNativeSearch", () => {
  it("emits a search entry with ranked sources on completion", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(searchCall("watch-search-1", "ranked query"), "acp-a");
    expect(entries).toHaveLength(0);
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "watch-search-1",
        id: "watch-search-1",
        callId: "watch-search-1",
        status: "completed",
        rawOutput: {
          sources: [
            { title: "Alpha", url: "https://example.com/alpha" },
            { title: "Beta", url: "https://example.com/beta" },
          ],
        },
        locations: [
          { path: "https://example.com/alpha", _meta: { title: "Alpha" } },
          { path: "https://example.com/beta", _meta: { title: "Beta" } },
        ],
        _meta: { tool_name: "connector_web_search.web_search" },
      },
      "acp-a",
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(typeof entry.id).toBe("string");
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry).toMatchObject({
      acpSessionId: "acp-a",
      kind: "search",
      tool: "connector_web_search.web_search",
      status: "completed",
      query: "ranked query",
    });
    expect(entry.sources).toEqual([
      { title: "Alpha", url: "https://example.com/alpha" },
      { title: "Beta", url: "https://example.com/beta" },
    ]);
    expect(JSON.stringify(entry)).not.toContain(PAGE_BODY);
  });

  it("falls back to locations for search sources", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(searchCall("watch-fallback-1", "fallback query"), "acp-b");
    const locs = [
      { path: "https://example.com/loc-a", _meta: { title: "Loc A" } },
      { path: "https://example.com/loc-b", _meta: { title: "Loc B" } },
    ];
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "watch-fallback-1",
        id: "watch-fallback-1",
        callId: "watch-fallback-1",
        status: "completed",
        rawOutput: { locations: locs },
        locations: locs,
        _meta: { tool_name: "connector_web_search.web_search" },
      },
      "acp-b",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].sources).toEqual([
      { title: "Loc A", url: "https://example.com/loc-a" },
      { title: "Loc B", url: "https://example.com/loc-b" },
    ]);
  });

  it("emits a fetch entry with source and charCount without leaking the page body", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(fetchCall("watch-fetch-1", "https://example.com/page-one"), "acp-c");
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "watch-fetch-1",
        id: "watch-fetch-1",
        callId: "watch-fetch-1",
        status: "completed",
        rawOutput: { content: PAGE_BODY },
        locations: [
          { path: "https://example.com/page-one", _meta: { title: "Page One", char_count: PAGE_BODY.length } },
        ],
        _meta: { tool_name: "connector_web_search.open_url" },
      },
      "acp-c",
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toMatchObject({
      acpSessionId: "acp-c",
      kind: "fetch",
      tool: "connector_web_search.open_url",
      status: "completed",
      url: "https://example.com/page-one",
      charCount: PAGE_BODY.length,
    });
    expect(entry.sources.length).toBeGreaterThan(0);
    expect(entry.sources[0].url).toBe("https://example.com/page-one");
    expect(entry.content).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(PAGE_BODY);
    const label = mod.nativeSearchLabel(entry);
    expect(label).toContain("https://example.com/page-one");
    expect(label).toContain(String(PAGE_BODY.length));
    expect(label).not.toContain(PAGE_BODY);
  });

  it("derives fetch charCount from locations metadata when content is absent", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(fetchCall("watch-fetch-2", "https://example.com/fallback-page"), "acp-c2");
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "watch-fetch-2",
        id: "watch-fetch-2",
        callId: "watch-fetch-2",
        status: "completed",
        rawOutput: {},
        locations: [
          { path: "https://example.com/fallback-page", _meta: { title: "Fallback Page", char_count: 1234 } },
        ],
        _meta: { tool_name: "connector_web_search.open_url" },
      },
      "acp-c2",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].charCount).toBe(1234);
    expect(entries[0].url).toBe("https://example.com/fallback-page");
  });

  it("emits failed and cancelled terminal entries", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(searchCall("watch-fail-1", "will fail"), "acp-d");
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "watch-fail-1",
        id: "watch-fail-1",
        callId: "watch-fail-1",
        status: "failed",
        rawOutput: { sources: [] },
        _meta: { tool_name: "connector_web_search.web_search" },
      },
      "acp-d",
    );
    watcher.handleUpdate(fetchCall("watch-cancel-1", "https://example.com/cancel-page"), "acp-d");
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "watch-cancel-1",
        id: "watch-cancel-1",
        callId: "watch-cancel-1",
        status: "cancelled",
        rawOutput: {},
        _meta: { tool_name: "connector_web_search.open_url" },
      },
      "acp-d",
    );
    expect(entries.map((e: any) => e.status).sort()).toEqual(["cancelled", "failed"]);
  });

  it("flushes an in-progress call as cancelled by default and as failed on request", async () => {
    const mod = await requireNativeSearch();
    const first = makeWatcher(mod);
    first.watcher.handleUpdate(searchCall("watch-flush-1", "flush query"), "acp-e");
    first.watcher.flushIncomplete("acp-e");
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].status).toBe("cancelled");
    expect(first.entries[0].query).toBe("flush query");

    const second = makeWatcher(mod);
    second.watcher.handleUpdate(fetchCall("watch-flush-2", "https://example.com/flush-page"), "acp-e2");
    second.watcher.flushIncomplete("acp-e2", "failed");
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].status).toBe("failed");
  });

  it("flushes only the requested session and ignores unknown sessions", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(searchCall("watch-flush-3", "other session query"), "acp-other");
    watcher.flushIncomplete("acp-unknown");
    expect(entries).toHaveLength(0);
    watcher.flushIncomplete("acp-other", "cancelled");
    expect(entries).toHaveLength(1);
  });

  it("emits exactly one entry per call even on repeated terminal updates", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(searchCall("watch-dup-1", "dup query"), "acp-f");
    const completed = {
      sessionUpdate: "tool_call_update",
      toolCallId: "watch-dup-1",
      id: "watch-dup-1",
      callId: "watch-dup-1",
      status: "completed",
      rawOutput: { sources: [{ title: "Only", url: "https://example.com/only" }] },
      _meta: { tool_name: "connector_web_search.web_search" },
    };
    watcher.handleUpdate(completed, "acp-f");
    watcher.handleUpdate(completed, "acp-f");
    expect(entries).toHaveLength(1);
  });

  it("tracks two calls independently", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(searchCall("watch-two-a", "first query"), "acp-g");
    watcher.handleUpdate(fetchCall("watch-two-b", "https://example.com/two"), "acp-g");
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "watch-two-a",
        id: "watch-two-a",
        status: "completed",
        rawOutput: { sources: [{ title: "First", url: "https://example.com/first" }] },
        _meta: { tool_name: "connector_web_search.web_search" },
      },
      "acp-g",
    );
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "watch-two-b",
        id: "watch-two-b",
        status: "completed",
        rawOutput: { content: PAGE_BODY },
        locations: [{ path: "https://example.com/two", _meta: { char_count: PAGE_BODY.length } }],
        _meta: { tool_name: "connector_web_search.open_url" },
      },
      "acp-g",
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e: any) => e.kind).sort()).toEqual(["fetch", "search"]);
    expect(JSON.stringify(entries)).not.toContain(PAGE_BODY);
  });

  it("ignores non-web updates including search_tool_functions", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "fn-1",
        id: "fn-1",
        status: "in_progress",
        rawInput: { query: "mcp_pi" },
        _meta: { tool_name: "search_tool_functions" },
      },
      "acp-h",
    );
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "fn-1",
        id: "fn-1",
        status: "completed",
        rawOutput: { functions: [] },
        _meta: { tool_name: "search_tool_functions" },
      },
      "acp-h",
    );
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "pi-1",
        id: "pi-1",
        status: "in_progress",
        _meta: { tool_name: "mcp_pi.read" },
      },
      "acp-h",
    );
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "pi-1",
        id: "pi-1",
        status: "completed",
        rawOutput: { ok: true },
        _meta: { tool_name: "mcp_pi.read" },
      },
      "acp-h",
    );
    watcher.handleUpdate(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      "acp-h",
    );
    watcher.flushIncomplete("acp-h");
    expect(entries).toHaveLength(0);
  });

  it("ignores a spoofed completion without a tracked tool name", async () => {
    const mod = await requireNativeSearch();
    const { entries, watcher } = makeWatcher(mod);
    watcher.handleUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "connector_web_search.web_search",
        id: "connector_web_search.web_search",
        status: "completed",
        rawOutput: { sources: [{ title: "Spoof", url: "https://example.com/spoof" }] },
      },
      "acp-i",
    );
    expect(entries).toHaveLength(0);
  });

  it("sanitizes labels for search entries", async () => {
    const mod = await requireNativeSearch();
    const entry = {
      id: "label-1",
      acpSessionId: "acp-label",
      kind: "search",
      tool: "connector_web_search.web_search",
      status: "completed",
      query: "hello\u202eworld\u0001\u001b",
      sources: [{ title: "Title\u202eevil", url: "https://example.com/a\u0007" }],
    };
    const label = mod.nativeSearchLabel(entry);
    expect(label).toContain("hello");
    expect(label).toContain("world");
    expect(label).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(label).not.toContain(PAGE_BODY);
  });

  it("sanitizes labels for fetch entries", async () => {
    const mod = await requireNativeSearch();
    const entry = {
      id: "label-2",
      acpSessionId: "acp-label",
      kind: "fetch",
      tool: "connector_web_search.open_url",
      status: "completed",
      url: "https://example.com/page",
      sources: [{ url: "https://example.com/page", title: "Page\u202eevil" }],
      charCount: 42,
    };
    const label = mod.nativeSearchLabel(entry);
    expect(label).toContain("https://example.com/page");
    expect(label).toContain("42");
    expect(label).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(label).not.toContain(PAGE_BODY);
  });
});

/* ------------------------------------------------------------------ */
/* End-to-end: default off                                             */
/* ------------------------------------------------------------------ */

describe("end-to-end native search default off", () => {
  it.each([undefined, "0", "true"])(
    "denies web tools and keeps connectors disabled when flag is %s",
    async (flagValue) => {
      if (flagValue === undefined) delete process.env[NATIVE_ENV];
      else process.env[NATIVE_ENV] = flagValue;
      writeHostLogin();
      const fake = installFakeAcp("native-off");
      const h = harness();
      const sessionId = `ns-e2e-off-${String(flagValue ?? "unset")}`;
      const msg: any = await runTurn(
        MODEL,
        {
          systemPrompt: "sys",
          messages: [{ role: "user", content: "search please", timestamp: Date.now() }],
          tools: [],
        },
        { sessionId, ...h.opts },
      );
      expect(msg.stopReason).toBe("stop");
      const perms = permissionLog(fake);
      expect(perms.map((p: any) => p.toolName)).toEqual([
        "connector_web_search.web_search",
        "connector_web_search.open_url",
      ]);
      for (const perm of perms) {
        expect(perm.answer.outcome.outcome).toBe("cancelled");
      }
      expect(h.nativeEntries).toHaveLength(0);
      const config = sessionConfigText(sessionId);
      expect(config).toContain("enable_connectors = false");
      expect(config).not.toContain("enable_connectors = true");
      expect(msg.content.some((b: any) => b.type === "toolCall")).toBe(false);
    },
    30_000,
  );
});

/* ------------------------------------------------------------------ */
/* End-to-end: enabled approvals and denials                           */
/* ------------------------------------------------------------------ */

describe("end-to-end native search enabled", () => {
  it("approves the two web tools with the offered once token and denies everything else", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    const fake = installFakeAcp("native-on");
    const h = harness();
    const sessionId = "ns-e2e-on";
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "search and open", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId, ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    const perms = permissionLog(fake);
    const byCall = new Map(perms.map((p: any) => [p.callId, p]));
    expect(byCall.get("ns-search-1").answer.outcome).toEqual({
      outcome: "selected",
      optionId: "once-tok",
    });
    expect(byCall.get("ns-fetch-1").answer.outcome.outcome).toBe("selected");
    expect(byCall.get("ns-fetch-1").answer.outcome.optionId).toBe("once-fetch");
    const deniedIds = [
      "ns-finance",
      "ns-news",
      "ns-weather",
      "ns-gmail",
      "ns-bash",
      "ns-readfile",
      "ns-webfetch",
    ];
    for (const callId of deniedIds) {
      expect(byCall.get(callId).answer.outcome.outcome, callId).toBe("cancelled");
    }
    const config = sessionConfigText(sessionId);
    expect(config).toContain("enable_connectors = true");
    expect(config).not.toContain('disabled_tools = ["*"]');
    expect(msg.content.some((b: any) => b.type === "toolCall")).toBe(false);
    expect(h.nativeEntries.length).toBeGreaterThan(0);
  }, 30_000);

  it("denies a spoofed permission id without a tracked tool name", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    const fake = installFakeAcp("native-spoof");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "spoof check", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-spoof", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    const perms = permissionLog(fake);
    expect(perms).toHaveLength(1);
    expect(perms[0].answer.outcome.outcome).toBe("cancelled");
    expect(h.nativeEntries).toHaveLength(0);
  }, 30_000);

  it("denies unsafe urls and blank queries", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    const fake = installFakeAcp("native-invalid");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "invalid inputs", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-invalid", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    const perms = permissionLog(fake);
    expect(perms.map((p: any) => p.callId)).toEqual(["ns-file", "ns-js", "ns-blank", "ns-empty-q"]);
    for (const perm of perms) {
      expect(perm.answer.outcome.outcome).toBe("cancelled");
    }
    expect(h.nativeEntries).toHaveLength(0);
  }, 30_000);

  it("never invents an allow_once when only allow_always is offered", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    const fake = installFakeAcp("native-missing-once");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "missing option", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-missing-once", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    const perms = permissionLog(fake);
    expect(perms).toHaveLength(1);
    expect(perms[0].answer).toEqual({ outcome: { outcome: "cancelled" } });
    expect(h.nativeEntries).toHaveLength(0);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Declared Pi tool: identifier-only permission (stock Vibe 3.1.5)     */
/* ------------------------------------------------------------------ */

describe("declared Pi tool identifier-only permission", () => {
  const connectorIds = [
    "connector_web_search.web_search",
    "connector_web_search.finance_search",
    "finance_search",
  ];

  it("default-off: identifier-only pi_read approved with the exact offered option", async () => {
    delete process.env[NATIVE_ENV];
    delete process.env[STRICT_ENV];
    writeHostLogin();
    const fake = installFakeAcp("pi-identifier");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "read identifier check", timestamp: Date.now() }],
        tools: [READ_TOOL],
      },
      { sessionId: "ns-pi-id-off", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    const perms = permissionLog(fake);
    const byCall = new Map(perms.map((p: any) => [p.callId, p]));
    expect(byCall.get("pi_read").answer.outcome).toEqual({
      outcome: "selected",
      optionId: "declared-id-only",
    });
    expect(byCall.get("pi-control").answer.outcome).toEqual({
      outcome: "selected",
      optionId: "declared-explicit-tok",
    });
    for (const callId of connectorIds) {
      expect(byCall.get(callId).answer.outcome.outcome, callId).toBe("cancelled");
    }
    expect(h.nativeEntries).toHaveLength(0);
  }, 30_000);

  it("enabled: identifier-only pi_read approved, identifier-only connectors cancelled", async () => {
    process.env[NATIVE_ENV] = "1";
    delete process.env[STRICT_ENV];
    writeHostLogin();
    const fake = installFakeAcp("pi-identifier");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "read identifier check on", timestamp: Date.now() }],
        tools: [READ_TOOL],
      },
      { sessionId: "ns-pi-id-on", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    const perms = permissionLog(fake);
    const byCall = new Map(perms.map((p: any) => [p.callId, p]));
    expect(byCall.get("pi_read").answer.outcome).toEqual({
      outcome: "selected",
      optionId: "declared-id-only",
    });
    for (const callId of connectorIds) {
      expect(byCall.get(callId).answer.outcome.outcome, callId).toBe("cancelled");
    }
    expect(h.nativeEntries).toHaveLength(0);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* End-to-end: visible entries, sources, no body leak, no toolCall     */
/* ------------------------------------------------------------------ */

describe("end-to-end visible native search entries", () => {
  it("surfaces search and fetch entries with sources and no page body", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    installFakeAcp("native-on");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "show sources", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-entries", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    expect(msg.content.some((b: any) => b.type === "toolCall")).toBe(false);
    expect(h.nativeEntries).toHaveLength(2);
    const search = h.nativeEntries.find((e: any) => e.kind === "search");
    const fetch = h.nativeEntries.find((e: any) => e.kind === "fetch");
    expect(search).toBeDefined();
    expect(search.query).toBe("ranked web query one");
    expect(search.sources).toEqual([
      { title: "First Result", url: "https://example.com/first" },
      { title: "Second Result", url: "https://example.com/second" },
    ]);
    expect(fetch).toBeDefined();
    expect(fetch.url).toBe("https://example.com/page-one");
    expect(fetch.charCount).toBe(PAGE_BODY.length);
    expect(fetch.sources[0].url).toBe("https://example.com/page-one");
    expect(JSON.stringify(h.nativeEntries)).not.toContain(PAGE_BODY);
    expect(fetch.content).toBeUndefined();
    const mod = await requireNativeSearch();
    for (const entry of h.nativeEntries) {
      const label = mod.nativeSearchLabel(entry);
      expect(label).not.toContain(PAGE_BODY);
    }
    const searchLabel = mod.nativeSearchLabel(search);
    expect(searchLabel).toContain("ranked web query one");
    expect(searchLabel).toContain("https://example.com/first");
    const fetchLabel = mod.nativeSearchLabel(fetch);
    expect(fetchLabel).toContain("https://example.com/page-one");
    expect(fetchLabel).toContain(String(PAGE_BODY.length));
  }, 30_000);

  it("falls back to locations for entry sources and charCount", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    installFakeAcp("native-fallback");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "fallback sources", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-fallback", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    expect(msg.content.some((b: any) => b.type === "toolCall")).toBe(false);
    expect(h.nativeEntries).toHaveLength(2);
    const search = h.nativeEntries.find((e: any) => e.kind === "search");
    const fetch = h.nativeEntries.find((e: any) => e.kind === "fetch");
    expect(search.query).toBe("fallback query");
    expect(search.sources).toEqual([
      { title: "Loc A", url: "https://example.com/loc-a" },
      { title: "Loc B", url: "https://example.com/loc-b" },
    ]);
    expect(fetch.charCount).toBe(1234);
    expect(fetch.url).toBe("https://example.com/fallback-page");
  }, 30_000);

  it("emits zero native entries for search_tool_functions alone", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    const fake = installFakeAcp("native-on");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "check function search", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-fn-only", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    const searchToolPerms = permissionLog(fake).filter(
      (p: any) => p.toolName === "search_tool_functions",
    );
    expect(searchToolPerms).toHaveLength(0);
    const nativeForFn = h.nativeEntries.filter(
      (e: any) => e.tool === "search_tool_functions",
    );
    expect(nativeForFn).toHaveLength(0);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Extension wiring                                                    */
/* ------------------------------------------------------------------ */

function fakePi() {
  const handlers = new Map<string, any[]>();
  const providers: any[] = [];
  const commands: any[] = [];
  const renderers: Array<{ entryType: string; renderer: any }> = [];
  const appended: Array<{ entryType: string; data: any }> = [];
  const pi: any = {
    on: (event: string, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerProvider: (id: string, config: any) => providers.push({ id, config }),
    registerCommand: (name: string, def: any) => commands.push({ name, def }),
    registerEntryRenderer: (entryType: string, renderer: any) =>
      renderers.push({ entryType, renderer }),
    appendEntry: (entryType: string, data: any) => appended.push({ entryType, data }),
  };
  return { pi, providers, commands, handlers, renderers, appended };
}

async function invokeSessionStart(
  fake: ReturnType<typeof fakePi>,
  sessionId: string,
  existingEntries: any[] = [],
) {
  const notifications: string[] = [];
  const ctx: any = {
    hasUI: true,
    ui: { notify: (m: string) => notifications.push(m) },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => existingEntries,
    },
    model: { provider: "mistral-vibe" },
  };
  const handlers = fake.handlers.get("session_start") ?? [];
  for (const handler of handlers) {
    await handler({ type: "session_start", model: { provider: "mistral-vibe" } }, ctx);
  }
  return notifications;
}

async function runExtensionTurn(
  fake: ReturnType<typeof fakePi>,
  sessionId: string,
  context: any,
) {
  const provider = fake.providers[0];
  expect(provider).toBeDefined();
  const stream: any = provider.config.streamSimple(MODEL, context, {
    sessionId,
  });
  return await stream.result();
}

describe("extension wiring for native search", () => {
  it("registers no native renderers and emits no notice when the flag is off", async () => {
    delete process.env[NATIVE_ENV];
    delete process.env[STRICT_ENV];
    writeHostLogin();
    installFakeAcp("chat");
    const fake = fakePi();
    takeStartupNotices();
    await extensionDefault(fake.pi as any);
    const nativeRenderers = fake.renderers.filter(
      (r: any) => r.entryType === NOTICE_ENTRY_TYPE || r.entryType === SEARCH_ENTRY_TYPE,
    );
    expect(nativeRenderers).toHaveLength(0);
    await invokeSessionStart(fake, "ext-off-1");
    const msg: any = await runExtensionTurn(fake, "ext-off-1", {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      tools: [],
    });
    expect(msg.stopReason).toBe("stop");
    const notices = fake.appended.filter((a: any) => a.entryType === NOTICE_ENTRY_TYPE);
    const searches = fake.appended.filter((a: any) => a.entryType === SEARCH_ENTRY_TYPE);
    expect(notices).toHaveLength(0);
    expect(searches).toHaveLength(0);
  }, 30_000);

  it("registers both renderers and appends the notice once per session", async () => {
    process.env[NATIVE_ENV] = "1";
    delete process.env[STRICT_ENV];
    writeHostLogin();
    installFakeAcp("chat");
    const fake = fakePi();
    takeStartupNotices();
    await extensionDefault(fake.pi as any);
    const entryTypes = fake.renderers.map((r: any) => r.entryType);
    expect(entryTypes).toContain(NOTICE_ENTRY_TYPE);
    expect(entryTypes).toContain(SEARCH_ENTRY_TYPE);
    await invokeSessionStart(fake, "ext-on-1");
    const baseCtx = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      tools: [],
    };
    const first: any = await runExtensionTurn(fake, "ext-on-1", baseCtx);
    expect(first.stopReason).toBe("stop");
    const second: any = await runExtensionTurn(fake, "ext-on-1", {
      ...baseCtx,
      messages: [...baseCtx.messages, first, { role: "user", content: "again", timestamp: Date.now() }],
    });
    expect(second.stopReason).toBe("stop");
    const notices = fake.appended.filter((a: any) => a.entryType === NOTICE_ENTRY_TYPE);
    expect(notices).toHaveLength(1);
  }, 30_000);

  it("does not duplicate the notice when a fresh extension resumes the session", async () => {
    process.env[NATIVE_ENV] = "1";
    delete process.env[STRICT_ENV];
    writeHostLogin();
    installFakeAcp("chat");
    // First extension instance (first Pi process): session_start plus a
    // real turn appends exactly one notice for the session.
    const ext1 = fakePi();
    takeStartupNotices();
    await extensionDefault(ext1.pi as any);
    await invokeSessionStart(ext1, "ext-on-resume");
    const first: any = await runExtensionTurn(ext1, "ext-on-resume", {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      tools: [],
    });
    expect(first.stopReason).toBe("stop");
    expect(ext1.appended.filter((a: any) => a.entryType === NOTICE_ENTRY_TYPE)).toHaveLength(1);
    // The journal the resumed session sees, rebuilt from ext1's appended
    // entries in session-manager shape.
    const existingEntriesFromExt1 = ext1.appended.map((a: any) => ({
      type: "custom",
      customType: a.entryType,
      data: a.data,
    }));
    // Second, brand-new extension instance (fresh Pi process with an
    // empty in-memory announced set) resuming the same session, then an
    // actual turn: the persisted notice must suppress a second one.
    const ext2 = fakePi();
    takeStartupNotices();
    await extensionDefault(ext2.pi as any);
    await invokeSessionStart(ext2, "ext-on-resume", existingEntriesFromExt1);
    const resumed: any = await runExtensionTurn(ext2, "ext-on-resume", {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "resumed hello", timestamp: Date.now() }],
      tools: [],
    });
    expect(resumed.stopReason).toBe("stop");
    expect(ext2.appended.filter((a: any) => a.entryType === NOTICE_ENTRY_TYPE)).toHaveLength(0);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Strict mode refusal                                                 */
/* ------------------------------------------------------------------ */

describe("strict mode with native search enabled", () => {
  it("refuses before spawning and names both flags in the provider path", async () => {
    process.env[NATIVE_ENV] = "1";
    process.env[STRICT_ENV] = "1";
    writeHostLogin();
    const fake = installFakeAcp("native-on");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "strict check", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-strict", ...h.opts },
    );
    expect(msg.stopReason).toBe("error");
    const text = String(msg.errorMessage ?? msg.content?.[0]?.text ?? "");
    expect(text).toContain(STRICT_ENV);
    expect(text).toContain(NATIVE_ENV);
    expect(readFakeLog(fake.log)).toEqual([]);
    expect(h.nativeEntries).toHaveLength(0);
    expect(activeCliProcessCount()).toBe(0);
  }, 30_000);

  it("registers no native renderers and emits no notice or entries in the extension path", async () => {
    process.env[NATIVE_ENV] = "1";
    process.env[STRICT_ENV] = "1";
    writeHostLogin();
    const fake = installFakeAcp("native-on");
    const ext = fakePi();
    takeStartupNotices();
    await extensionDefault(ext.pi as any);
    const nativeRenderers = ext.renderers.filter(
      (r: any) => r.entryType === NOTICE_ENTRY_TYPE || r.entryType === SEARCH_ENTRY_TYPE,
    );
    expect(nativeRenderers).toHaveLength(0);
    await invokeSessionStart(ext, "ext-strict-1");
    const before = ext.appended.length;
    const provider = ext.providers[0];
    const stream: any = provider.config.streamSimple(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "strict check", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ext-strict-1" },
    );
    const msg: any = await stream.result();
    expect(msg.stopReason).toBe("error");
    expect(ext.appended.slice(before).filter((a: any) => a.entryType === NOTICE_ENTRY_TYPE)).toHaveLength(0);
    expect(ext.appended.slice(before).filter((a: any) => a.entryType === SEARCH_ENTRY_TYPE)).toHaveLength(0);
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "prompt")).toHaveLength(0);
    expect(readFakeLog(fake.log).filter((e: any) => e.dir === "session/new")).toHaveLength(0);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Abort                                                               */
/* ------------------------------------------------------------------ */

describe("abort stops in-flight native search", () => {
  it("cancels, retires, flushes cancelled, and ends aborted", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    const fake = installFakeAcp("native-abort");
    const h = harness();
    const controller = new AbortController();
    const sessionId = "ns-e2e-abort";
    const stream: any = streamViaAcp(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "long search", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId, signal: controller.signal, ...h.opts },
    );
    const resultPromise = stream.result();
    await waitUntil(
      () =>
        readFakeLog(fake.log).some((e: any) => e.dir === "in_progress") ||
        readFakeLog(fake.log).some((e: any) => e.dir === "prompt"),
      8000,
    );
    const cliBefore: any = getCliProcess(sessionId);
    expect(cliBefore).toBeDefined();
    const incarnationRoot: string | undefined = cliBefore.incarnationRoot;
    controller.abort();
    const msg: any = await resultPromise;
    expect(msg.stopReason).toBe("aborted");
    const entries = readFakeLog(fake.log);
    expect(entries.some((e: any) => e.dir === "cancel")).toBe(true);
    expect(activeCliProcessCount()).toBe(0);
    expect(getCliProcess(sessionId)).toBeUndefined();
    if (incarnationRoot) expect(existsSync(incarnationRoot)).toBe(false);
    expect(
      cliBefore.proc.exitCode !== null || cliBefore.proc.signalCode !== null,
    ).toBe(true);
    const cancelledEntries = h.nativeEntries.filter(
      (e: any) => e.status === "cancelled" && e.kind === "search",
    );
    expect(cancelledEntries).toHaveLength(1);
    expect(cancelledEntries[0].query).toBe("abort query");
    expect(JSON.stringify(cancelledEntries)).not.toContain(PAGE_BODY);
    if (typeof cliBefore.decidePermission === "function") {
      const late = cliBefore.decidePermission({
        toolCall: {
          toolCallId: "late-1",
          _meta: { tool_name: "connector_web_search.web_search" },
          rawInput: { query: "late query" },
          input: { query: "late query" },
        },
      });
      expect(late.outcome).toBe("denied");
    }
  }, 30_000);

  it("keeps abort cleanup from surfacing vendor toolCall blocks", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    const fake = installFakeAcp("native-abort");
    const h = harness();
    const controller = new AbortController();
    const stream: any = streamViaAcp(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "abort again", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-abort-2", signal: controller.signal, ...h.opts },
    );
    const resultPromise = stream.result();
    await waitUntil(
      () => readFakeLog(fake.log).some((e: any) => e.dir === "prompt"),
      8000,
    );
    controller.abort();
    const msg: any = await resultPromise;
    expect(msg.stopReason).toBe("aborted");
    expect(msg.content.some((b: any) => b.type === "toolCall")).toBe(false);
    expect(dirname(join(sessionVibeHome("ns-e2e-abort-2")))).toBeTruthy();
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Red-first: cliEnvironment nativeSearch env                           */
/* ------------------------------------------------------------------ */

describe("cliEnvironment nativeSearch env", () => {
  const baseEnv: any = {
    PATH: "/usr/bin",
    HOME: "/tmp",
    VIBE_ENABLE_CONNECTORS: "true",
    VIBE_CUSTOM_INHERITED: "x",
    VIBE_HOME: "/inherited",
    MISTRAL_API_KEY: "should-be-stripped",
  };

  it("sets connectors true only when nativeSearch is true", () => {
    const on = cliEnvironment("/tmp/vibe-home", baseEnv, { nativeSearch: true });
    expect(on.VIBE_ENABLE_CONNECTORS).toBe("true");
    expect(on.VIBE_EXPERIMENTAL_ENABLE_DOCUMENT_LIBRARY_CONNECTOR).toBe("false");
    expect(on.VIBE_EXPERIMENTAL_ENABLE_MISTRAL_MCP_CONNECTOR).toBe("false");
    expect(on.VIBE_CUSTOM_INHERITED).toBeUndefined();
    expect(on.MISTRAL_API_KEY).toBeUndefined();
    expect(on.VIBE_HOME).toBe("/tmp/vibe-home");
    expect(on.VIBE_ENABLE_UPDATE_CHECKS).toBe("false");
  });

  it("keeps false by default and with explicit false, stripping VIBE_*", () => {
    const def = cliEnvironment("/tmp/vibe-home", baseEnv);
    expect(def.VIBE_ENABLE_CONNECTORS).toBe("false");
    expect(def.VIBE_CUSTOM_INHERITED).toBeUndefined();
    expect(def.MISTRAL_API_KEY).toBeUndefined();
    const off = cliEnvironment("/tmp/vibe-home", baseEnv, { nativeSearch: false });
    expect(off.VIBE_ENABLE_CONNECTORS).toBe("false");
    expect(off.VIBE_CUSTOM_INHERITED).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Red-first: e2e env to fake vibe-acp                                */
/* ------------------------------------------------------------------ */

describe("e2e fake vibe-acp receives VIBE_ENABLE_CONNECTORS", () => {
  it("is true when PI_MISTRAL_VIBE_TETHER_NATIVE_SEARCH=1", async () => {
    process.env[NATIVE_ENV] = "1";
    writeHostLogin();
    const fakeAcp = installFakeAcp("chat");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "env check", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-env-on", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    const invoked = readFakeLog(fakeAcp.log).find((e: any) => e.dir === "invoked");
    expect(invoked).toBeDefined();
    expect(invoked.env.VIBE_ENABLE_CONNECTORS).toBe("true");
    expect(invoked.env.VIBE_EXPERIMENTAL_ENABLE_DOCUMENT_LIBRARY_CONNECTOR).toBe("false");
    expect(invoked.env.VIBE_EXPERIMENTAL_ENABLE_MISTRAL_MCP_CONNECTOR).toBe("false");
  }, 30_000);

  it("is false when native search flag is off", async () => {
    delete process.env[NATIVE_ENV];
    writeHostLogin();
    const fakeAcp = installFakeAcp("chat");
    const h = harness();
    const msg: any = await runTurn(
      MODEL,
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "env check off", timestamp: Date.now() }],
        tools: [],
      },
      { sessionId: "ns-e2e-env-off", ...h.opts },
    );
    expect(msg.stopReason).toBe("stop");
    const invoked = readFakeLog(fakeAcp.log).find((e: any) => e.dir === "invoked");
    expect(invoked).toBeDefined();
    expect(invoked.env.VIBE_ENABLE_CONNECTORS).toBe("false");
  }, 30_000);

  it("probe always sends false even when the flag is on", async () => {
    process.env[NATIVE_ENV] = "1";
    const fakeAcp = installFakeAcp("chat");
    const vibeHome = freshDir("t-probe-env-");
    const proc = spawnAcpProbe(vibeHome);
    try {
      await waitUntil(
        () => readFakeLog(fakeAcp.log).some((e: any) => e.dir === "invoked"),
        8000,
      );
      const invoked = readFakeLog(fakeAcp.log).find((e: any) => e.dir === "invoked");
      expect(invoked).toBeDefined();
      expect(invoked.env.VIBE_ENABLE_CONNECTORS).toBe("false");
    } finally {
      await forceKillProcess(proc);
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Red-first: session-staleness guard in index.ts                       */
/* ------------------------------------------------------------------ */

describe("session-staleness guard", () => {
  it("late event for session A cannot emit into session B", async () => {
    process.env[NATIVE_ENV] = "1";
    delete process.env[STRICT_ENV];
    writeHostLogin();
    installFakeAcp("chat");
    const fake = fakePi();
    takeStartupNotices();
    await extensionDefault(fake.pi as any);
    await invokeSessionStart(fake, "stale-A");
    const first: any = await runExtensionTurn(fake, "stale-A", {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      tools: [],
    });
    expect(first.stopReason).toBe("stop");
    const cli: any = getCliProcess("stale-A");
    expect(cli).toBeDefined();
    const onNativeSearch = cli.onNativeSearch;
    expect(typeof onNativeSearch).toBe("function");
    await invokeSessionStart(fake, "stale-B");
    const before = fake.appended.filter((a: any) => a.entryType === SEARCH_ENTRY_TYPE).length;
    expect(before).toBe(0);
    onNativeSearch({
      id: "late-1",
      acpSessionId: cli.acpSessionId || "acp-session-1",
      kind: "search",
      tool: "connector_web_search.web_search",
      status: "completed",
      query: "late query",
      sources: [{ title: "Late", url: "https://example.com/late" }],
    });
    const after = fake.appended.filter((a: any) => a.entryType === SEARCH_ENTRY_TYPE);
    expect(after).toHaveLength(before);
  }, 30_000);
});
