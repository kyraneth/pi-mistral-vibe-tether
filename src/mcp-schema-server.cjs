#!/usr/bin/env node
// Schema-only MCP server for Pi's tools, with the handoff proxy.
//
// It advertises exactly the tool schema Pi staged for this ACP session
// (tools.json) and forwards every `tools/call` to the tether's local broker,
// blocking until Pi has executed the tool. It has no executors of its own:
// there is no way for the client to reach a shell, a file or the network through it.
//
// argv: <toolsPath> <socketPath> <sessionId> <secretPath>
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const { version } = require("../package.json");

const [toolsPath, socketPath, sessionId, secretPath] = process.argv.slice(2);
if (!toolsPath || !socketPath || !sessionId || !secretPath) process.exit(1);

let tools;
let secret;
try {
  tools = JSON.parse(fs.readFileSync(toolsPath, "utf8"));
  secret = fs.readFileSync(secretPath, "utf8").trim();
  if (!Array.isArray(tools) || !secret) throw new Error();
} catch {
  process.exit(1);
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });
const pending = new Map();
const seen = new Set();

/** Forward one call to Pi and answer with its result. */
function proxy(id, params) {
  const idKey = JSON.stringify(id);
  if (seen.has(idKey)) {
    send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Duplicate request id" } });
    return;
  }
  seen.add(idKey);
  const socket = net.connect(socketPath);
  pending.set(idKey, socket);
  let buffer = "";
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    pending.delete(idKey);
    send({ jsonrpc: "2.0", id, result });
    socket.destroy();
  };
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({
        type: "call",
        session: sessionId,
        secret,
        requestId: id,
        name: params.name,
        arguments: params.arguments === undefined ? {} : params.arguments,
      })}\n`,
    );
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    const nl = buffer.indexOf("\n");
    if (nl < 0) return;
    try {
      const response = JSON.parse(buffer.slice(0, nl));
      if (response.type !== "result" || !Array.isArray(response.content)) throw new Error();
      const { type, ...result } = response;
      finish(result);
    } catch {
      finish(errorResult("Malformed broker response"));
    }
  });
  socket.on("error", () => finish(errorResult("Pi bridge unavailable; outcome unknown")));
  socket.on("close", () => finish(errorResult("Pi bridge closed; outcome unknown")));
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!message || message.jsonrpc !== "2.0") {
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    return;
  }
  if (message.id === undefined) return; // notification
  if (message.method === "initialize")
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pi-mistral-vibe-tether-tools", version },
      },
    });
  else if (message.method === "tools/list")
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  else if (message.method === "tools/call") proxy(message.id, message.params || {});
  else if (message.method === "ping") send({ jsonrpc: "2.0", id: message.id, result: {} });
  else
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not supported" },
    });
});
rl.on("close", () => {
  for (const socket of pending.values()) socket.destroy();
});
