#!/usr/bin/env bash
# Run from the source checkout. Optionally pass an existing .tgz to qualify those exact bytes.
set -euo pipefail

# npm run prepends checkout-local bins, including the pinned dev copy of Pi.
IFS=: read -ra dirs <<< "$PATH"
host_path=()
for dir in "${dirs[@]}"; do
  case "$dir" in
    */node_modules/.bin|*/node_modules/.bin/) ;;
    /*) host_path+=("$dir") ;;
  esac
done
PATH=$(IFS=:; printf '%s' "${host_path[*]}")
pi=$(command -v pi) || { printf 'Install Pi on PATH before running this smoke.\n' >&2; exit 1; }
npm_cache="${NPM_CONFIG_CACHE:-$(npm config get cache)}"

work=$(mktemp -d "${TMPDIR:-/tmp}/pi-vibe-smoke.XXXXXX")
work=$(cd "$work" && pwd -P)
printf 'Installed Pi: %s\nSmoke evidence: %s\n' "$pi" "$work"
mkdir -p "$work"/{home,config,data,cache,state,runtime,tmp,agent/npm,cwd,bin,control-agent}
chmod 700 "$work/runtime"
for cli in claude muse agy antigravity vibe; do
  printf '#!/bin/sh\nexit 80\n' > "$work/bin/$cli"
  chmod +x "$work/bin/$cli"
done
# Stalling vibe-acp: records invocation, never answers initialize, exits on SIGTERM.
cat > "$work/bin/vibe-acp" <<EOF
#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync("$work/vibe-acp.invoked", "invoked\n");
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 1000);
EOF
chmod +x "$work/bin/vibe-acp"

clean=(env -i "PATH=$work/bin:$PATH" "HOME=$work/home" "TMPDIR=$work/tmp"
  "XDG_CONFIG_HOME=$work/config" "XDG_CONFIG_DIRS=$work/config"
  "XDG_DATA_HOME=$work/data" "XDG_DATA_DIRS=$work/data"
  "XDG_CACHE_HOME=$work/cache" "XDG_STATE_HOME=$work/state" "XDG_RUNTIME_DIR=$work/runtime"
  "PI_CODING_AGENT_DIR=$work/agent" "PI_CODING_AGENT_SESSION_DIR=$work/agent/sessions"
  "OPENAI_API_KEY=offline-listing-fixture-not-a-key"
  PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 CI=1)
clean_control=(env -i "PATH=$work/bin:$PATH" "HOME=$work/home" "TMPDIR=$work/tmp"
  "XDG_CONFIG_HOME=$work/config" "XDG_CONFIG_DIRS=$work/config"
  "XDG_DATA_HOME=$work/data" "XDG_DATA_DIRS=$work/data"
  "XDG_CACHE_HOME=$work/cache" "XDG_STATE_HOME=$work/state" "XDG_RUNTIME_DIR=$work/runtime"
  "PI_CODING_AGENT_DIR=$work/control-agent" "PI_CODING_AGENT_SESSION_DIR=$work/control-agent/sessions"
  "OPENAI_API_KEY=offline-listing-fixture-not-a-key"
  PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 CI=1)

if (( $# > 1 )); then
  printf 'Usage: %s [package.tgz]\n' "$0" >&2
  exit 1
elif (( $# == 1 )); then
  archive=$(cd "$(dirname "$1")" && printf '%s/%s' "$PWD" "$(basename "$1")")
else
  "${clean[@]}" npm pack --ignore-scripts --json --pack-destination "$work" > "$work/pack.json"
  archive="$work/$(node -p 'require(process.argv[1])[0].filename' "$work/pack.json")"
fi
name=$(tar -xOzf "$archive" package/package.json |
  node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).name')
node -p 'JSON.stringify({packages: [`npm:${process.argv[1]}`]})' "$name" > "$work/agent/settings.json"

cd "$work/cwd"
# Match Pi's managed npm layout and leave Pi peer dependencies to the host loader.
"${clean[@]}" npm install --offline --cache "$npm_cache" --prefix "$work/agent/npm" --omit=dev --legacy-peer-deps \
  --ignore-scripts --no-audit --no-fund "$archive"
if [[ -e "$work/agent/npm/node_modules/@earendil-works/pi-ai" ]]; then
  printf 'A local pi-ai install would hide host-loader failures.\n' >&2
  exit 1
fi
"${clean[@]}" "$pi" --version | tee "$work/pi.version"

# Check 1: installed extension loads offline and lists Mistral models
# without ever invoking the stalled vibe-acp.
status=0
"${clean[@]}" "$pi" -ns -np -nc --no-mcp --no-session --list-models mistral-vibe \
  </dev/null > "$work/load.stdout" 2> "$work/load.stderr" || status=$?
printf '%s\n' "$status" > "$work/pi.exit"
tee < "$work/load.stderr" >&2
if (( status != 0 )) || grep -q '^Error:' "$work/load.stderr" ||
  ! grep -q 'mistral-large-4-0' "$work/load.stdout" ||
  ! grep -q 'mistral-medium-latest' "$work/load.stdout" ||
  [[ -e "$work/vibe-acp.invoked" ]]; then
  printf 'Installed extension smoke failed for %s\n' "$name" >&2
  exit 1
fi

# Check 2: non-Mistral Pi startup is not delayed by a stalled vibe-acp,
# with or without the installed extension.
status_control=0
"${clean_control[@]}" "$pi" -ns -np -nc --no-mcp --no-session --list-models openai \
  </dev/null > "$work/control.stdout" 2> "$work/control.stderr" || status_control=$?
status_installed=0
"${clean[@]}" "$pi" -ns -np -nc --no-mcp --no-session --list-models openai \
  </dev/null > "$work/openai.stdout" 2> "$work/openai.stderr" || status_installed=$?
if (( status_control != 0 || status_installed != 0 )) ||
  ! cmp -s "$work/control.stdout" "$work/openai.stdout" ||
  ! grep -q 'openai ' "$work/openai.stdout" ||
  [[ -e "$work/vibe-acp.invoked" ]]; then
  printf 'Stalled-Vibe non-Mistral check failed\n' >&2
  exit 1
fi

printf 'Installed Pi version: %s\n' "$(cat "$work/pi.version")"
printf 'Tarball SHA-256: %s\n' "$(sha256sum "$archive" | awk '{print $1}')"
printf 'Mistral model rows:\n'
cat "$work/load.stdout"
printf 'Stalled-Vibe non-Mistral check PASS\n'

# Check 3: opt-in native web search through a fake vibe-acp that speaks real
# ACP JSON-RPC over stdio, runs the web_search and open_url calls plus one
# denied finance_search call, and replies "ACP smoke OK". The reference
# marker below must never leak into a session file or printed output.
mkdir -p "$work/fake-vibe-home" "$work/fake-bin"
printf 'host-login-fixture-value\n' > "$work/fake-vibe-home/.env"
PAGE_BODY="ACP-SMOKE-PAGE-BODY-MARKER-7f3a"
cat > "$work/fake-bin/fake-vibe-acp" <<'EOF'
#!/usr/bin/env node
// Fake vibe-acp for the installed native-search smoke: speaks ACP JSON-RPC,
// runs web_search and open_url through one-time permission requests, and
// answers one extra finance_search request the tether must cancel.
const fs = require("node:fs");
const { createInterface } = require("node:readline");
const logPath = process.env.FAKE_ACP_LOG || (process.env.VIBE_HOME ? process.env.VIBE_HOME + "/fake-log.jsonl" : undefined);
function log(entry) { if (!logPath) return; try { fs.appendFileSync(logPath, JSON.stringify(entry) + "\n"); } catch {} }
function send(obj) { log({ dir: "out", msg: obj }); process.stdout.write(JSON.stringify(obj) + "\n"); }
log({ dir: "invoked" });
let sessionId = "acp-smoke-1";
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
let serverSeq = 9000;
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
  const params = { sessionId: sessionId, toolCall: { toolCallId: callId, _meta: { tool_name: toolName }, rawInput: input, input: input }, options: options };
  const ans = await serverRequest("session/request_permission", params);
  log({ dir: "permission", callId: callId, toolName: toolName, input: input, answer: ans });
  return ans;
}
function toolCallFrame(callId, toolName, input, kind) {
  sendUpdate({ sessionUpdate: "tool_call", toolCallId: callId, id: callId, callId: callId, kind: kind, title: toolName, status: "in_progress", rawInput: input, input: input, _meta: { tool_name: toolName }, tool_name: toolName });
}
function captureEvidence() {
  const ev = process.env.FAKE_ACP_EVIDENCE;
  const home = process.env.VIBE_HOME;
  if (!ev || !home) return;
  try {
    fs.mkdirSync(ev, { recursive: true });
    fs.writeFileSync(ev + "/env.json", JSON.stringify({ VIBE_ENABLE_CONNECTORS: process.env.VIBE_ENABLE_CONNECTORS ?? null, VIBE_EXPERIMENTAL_ENABLE_DOCUMENT_LIBRARY_CONNECTOR: process.env.VIBE_EXPERIMENTAL_ENABLE_DOCUMENT_LIBRARY_CONNECTOR ?? null, VIBE_EXPERIMENTAL_ENABLE_MISTRAL_MCP_CONNECTOR: process.env.VIBE_EXPERIMENTAL_ENABLE_MISTRAL_MCP_CONNECTOR ?? null }));
    fs.copyFileSync(home + "/config.toml", ev + "/config.toml");
    fs.copyFileSync(home + "/agents/pi.toml", ev + "/agents-pi.toml");
    fs.copyFileSync(home + "/prompts/pi.md", ev + "/prompts-pi.md");
  } catch {}
}
async function handlePrompt(id, params) {
  captureEvidence();
  const searchInput = { query: "installed smoke query" };
  toolCallFrame("smoke-search-1", "connector_web_search.web_search", searchInput, "search");
  const searchAns = await askPermission("smoke-search-1", "connector_web_search.web_search", searchInput, allowOptions("once-smoke"));
  if (searchAns && searchAns.outcome && searchAns.outcome.outcome === "selected") {
    sendUpdate({
      sessionUpdate: "tool_call_update", toolCallId: "smoke-search-1", id: "smoke-search-1", callId: "smoke-search-1", status: "completed",
      rawOutput: {
        sources: [
          { title: "Smoke First", url: "https://example.com/first" },
          { title: "Smoke Second", url: "https://example.com/second" },
        ],
        locations:[
          { path: "https://example.com/first", _meta: { title: "Smoke First" } },
          { path: "https://example.com/second", _meta: { title: "Smoke Second" } },
        ],
      },
      locations: [
        { path: "https://example.com/first", _meta: { title: "Smoke First" } },
        { path: "https://example.com/second", _meta: { title: "Smoke Second" } },
      ],
      _meta: { tool_name: "connector_web_search.web_search" }, tool_name: "connector_web_search.web_search",
    });
  }
  const fetchInput = { url: "https://example.com/smoke-page" };
  toolCallFrame("smoke-fetch-1", "connector_web_search.open_url", fetchInput, "fetch");
  const fetchAns = await askPermission("smoke-fetch-1", "connector_web_search.open_url", fetchInput, allowOptions("once-smoke-fetch"));
  if (fetchAns && fetchAns.outcome && fetchAns.outcome.outcome === "selected") {
    const content = process.env.SMOKE_PAGE_BODY || "";
    sendUpdate({
      sessionUpdate: "tool_call_update", toolCallId: "smoke-fetch-1", id: "smoke-fetch-1", callId: "smoke-fetch-1", status: "completed",
      rawOutput: { content: content, url: "https://example.com/smoke-page" },
      locations: [{ path: "https://example.com/smoke-page", _meta: { title: "Smoke Page", char_count: content.length } }],
      _meta: { tool_name: "connector_web_search.open_url" }, tool_name: "connector_web_search.open_url",
    });
  }
  toolCallFrame("smoke-finance-1", "connector_web_search.finance_search", { query: "smoke finance" }, "other");
  await askPermission("smoke-finance-1", "connector_web_search.finance_search", { query: "smoke finance" }, allowOptions("once-smoke-fin"));
  sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP smoke OK" } });
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
  if (msg.id === undefined || msg.id === null) return;
  const id = msg.id;
  const params = msg.params || {};
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: id, result: { agentInfo: { version: "3.1.5", name: "vibe" }, agentCapabilities: { promptCapabilities: { image: true } } } });
  } else if (msg.method === "session/new") {
    captureEvidence();
    send({ jsonrpc: "2.0", id: id, result: { sessionId: sessionId, configOptions: configOptions, modes: { availableModes: availableModes, currentModeId: currentModeId } } });
  } else if (msg.method === "session/set_config_option") {
    const opt = configOptions.find((o) => o.id === params.configId);
    if (opt) opt.currentValue = params.value;
    send({ jsonrpc: "2.0", id: id, result: { configOptions: configOptions } });
  } else if (msg.method === "session/set_mode") {
    currentModeId = params.modeId;
    const modeOpt = configOptions.find((o) => o.id === "mode");
    if (modeOpt) modeOpt.currentValue = params.modeId;
    send({ jsonrpc: "2.0", id: id, result: {} });
  } else if (msg.method === "session/prompt") {
    void handlePrompt(id, params);
  } else if (msg.method === "fixture/fence") {
    send({ jsonrpc: "2.0", id: id, result: {} });
  } else if (msg.method === "_account/read") {
    send({ jsonrpc: "2.0", id: id, result: { plan: { name: "Vibe EDU", title: "Vibe Education" }, budget: { usagePercentage: 42, resetAt: "2026-12-01T00:00:00Z", paygEnabled: false }, keyScope: "vibe:read", accessScope: "full" } });
  } else if (msg.method === "_identity/read") {
    send({ jsonrpc: "2.0", id: id, result: { workspace: "workspace-1", organization: "org-1", keyScope: "vibe:read", accessScope: "full" } });
  } else {
    send({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "unsupported method " + msg.method } });
  }
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
EOF
chmod +x "$work/fake-bin/fake-vibe-acp"

run_smoke_arm() {
  local arm="$1" native="$2" strict="$3"
  mkdir -p "$work/sessions-$arm" "$work/evidence-$arm"
  local -a arm_env=(env -i "PATH=$work/bin:$PATH" "HOME=$work/home" "TMPDIR=$work/tmp"
    "XDG_CONFIG_HOME=$work/config" "XDG_CONFIG_DIRS=$work/config"
    "XDG_DATA_HOME=$work/data" "XDG_DATA_DIRS=$work/data"
    "XDG_CACHE_HOME=$work/cache" "XDG_STATE_HOME=$work/state" "XDG_RUNTIME_DIR=$work/runtime"
    "PI_CODING_AGENT_DIR=$work/agent" "PI_CODING_AGENT_SESSION_DIR=$work/sessions-$arm"
    "OPENAI_API_KEY=offline-listing-fixture-not-a-key"
    PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 CI=1
    "PI_MISTRAL_VIBE_TETHER_CLI=$work/fake-bin/fake-vibe-acp"
    "PI_MISTRAL_VIBE_TETHER_SOURCE_VIBE_HOME=$work/fake-vibe-home"
    "PI_MISTRAL_VIBE_TETHER_NATIVE_SEARCH=$native"
    "FAKE_ACP_LOG=$work/fake-$arm.log.jsonl"
    "FAKE_ACP_EVIDENCE=$work/evidence-$arm"
    "SMOKE_PAGE_BODY=$PAGE_BODY")
  if [[ "$strict" == "1" ]]; then
    arm_env+=("PI_MISTRAL_VIBE_TETHER_STRICT=1")
  fi
  local status=0
  "${arm_env[@]}" "$pi" -a --mode json -p --provider mistral-vibe --model mistral-large-4-0 \
    "Smoke test prompt" </dev/null > "$work/arm-$arm.json" 2> "$work/arm-$arm.stderr" || status=$?
  printf '%s' "$status" > "$work/arm-$arm.exit"
  mkdir -p "$work/entries-$arm"
  cp "$work/sessions-$arm"/*.jsonl "$work/entries-$arm/" 2>/dev/null || true
}

count_in_entries() {
  local pattern="$1" dir="$2"
  grep -h -F "$pattern" "$dir"/*.jsonl 2>/dev/null | wc -l | tr -d ' ' || true
}

# Arm off: connectors stay disabled, no entries, reply still arrives.
# Permanent route facts are log-only: the ledger records the
# disclosure, but nothing reaches stderr/screen as a tether warning.
run_smoke_arm off 0 0
if grep -q '\[pi-mistral-vibe-tether\]' "$work/arm-off.stderr" 2>/dev/null; then
  printf 'Installed native-search off arm leaked a permanent route fact to stderr\n' >&2
  exit 1
fi
if ! grep -q 'pi-mistral-vibe-tether:disclosure' "$work/entries-off"/*.jsonl 2>/dev/null ||
  ! grep -q 'vibe-system-overhead' "$work/entries-off"/*.jsonl 2>/dev/null ||
  ! grep -q 'vibe-builtin-schemas' "$work/entries-off"/*.jsonl 2>/dev/null ||
  ! grep -qF '"surface":"log"' "$work/entries-off"/*.jsonl 2>/dev/null; then
  printf 'Installed native-search off arm did not record the log-only disclosure in the ledger\n' >&2
  exit 1
fi
off_status=$(cat "$work/arm-off.exit")
if [[ "$off_status" != "0" ]] ||
  ! grep -q 'enable_connectors = false' "$work/evidence-off/config.toml" ||
  grep -q 'enable_connectors = true' "$work/evidence-off/config.toml" ||
  ! grep -q '"VIBE_ENABLE_CONNECTORS":"false"' "$work/evidence-off/env.json" ||
  ! grep -q 'ACP smoke OK' "$work/arm-off.json" ||
  [[ "$(count_in_entries 'pi-mistral-vibe-tether:native-search-notice' "$work/entries-off")" != "0" ]] ||
  [[ "$(count_in_entries 'pi-mistral-vibe-tether:native-search"' "$work/entries-off")" != "0" ]] ||
  [[ "$(count_in_entries 'ACP smoke OK' "$work/entries-off")" == "0" ]]; then
  printf 'Installed native-search off arm failed (status %s)\n' "$off_status" >&2
  exit 1
fi
printf 'Native-search off arm PASS\n'

# Arm search: connectors on and narrowed, one-time approvals for the two web
# tools, cancellation for finance_search, one notice plus search and fetch
# entries with sources and no leaked page body.
run_smoke_arm search 1 0
if grep -q 'harness capability guidance' "$work/arm-search.stderr" 2>/dev/null ||
  grep -q 'run_typescript' "$work/arm-search.stderr" 2>/dev/null; then
  printf 'Installed native-search search arm leaked a permanent route fact to stderr\n' >&2
  exit 1
fi
search_status=$(cat "$work/arm-search.exit")
notice_count=$(count_in_entries 'pi-mistral-vibe-tether:native-search-notice' "$work/entries-search")
search_count=$(count_in_entries 'pi-mistral-vibe-tether:native-search"' "$work/entries-search")
search_kind=$(count_in_entries '"kind":"search"' "$work/entries-search")
fetch_kind=$(count_in_entries '"kind":"fetch"' "$work/entries-search")
if [[ "$search_status" != "0" ]] ||
  ! grep -q 'enable_connectors = true' "$work/evidence-search/config.toml" ||
  ! grep -q '"VIBE_ENABLE_CONNECTORS":"true"' "$work/evidence-search/env.json" ||
  ! grep -q '"VIBE_EXPERIMENTAL_ENABLE_DOCUMENT_LIBRARY_CONNECTOR":"false"' "$work/evidence-search/env.json" ||
  ! grep -q '"VIBE_EXPERIMENTAL_ENABLE_MISTRAL_MCP_CONNECTOR":"false"' "$work/evidence-search/env.json" ||
  ! grep -qF 'enabled_tools = ["pi_*", "connector_web_search_web_search", "connector_web_search_open_url"]' "$work/evidence-search/config.toml" ||
  grep -qF 'disabled_tools = ["*"]' "$work/evidence-search/config.toml" ||
  ! grep -qF '[[connectors]]' "$work/evidence-search/config.toml" ||
  ! grep -q '"toolName":"connector_web_search.web_search".*"outcome":"selected","optionId":"once-smoke"' "$work/fake-search.log.jsonl" ||
  ! grep -q '"toolName":"connector_web_search.open_url".*"outcome":"selected","optionId":"once-smoke-fetch"' "$work/fake-search.log.jsonl" ||
  ! grep -q '"toolName":"connector_web_search.finance_search".*"outcome":"cancelled"' "$work/fake-search.log.jsonl" ||
  [[ "$notice_count" != "1" ]] ||
  [[ "$search_count" != "2" ]] ||
  [[ "$search_kind" != "1" ]] ||
  [[ "$fetch_kind" != "1" ]] ||
  ! grep -q 'https://example.com/first' "$work/entries-search"/*.jsonl ||
  ! grep -q 'https://example.com/smoke-page' "$work/entries-search"/*.jsonl ||
  ! grep -q 'ACP smoke OK' "$work/arm-search.json" ||
  grep -qF "$PAGE_BODY" "$work/entries-search"/*.jsonl "$work/arm-search.json" "$work/arm-search.stderr" 2>/dev/null; then
  printf 'Installed native-search search arm failed (status %s)\n' "$search_status" >&2
  exit 1
fi
printf 'Native-search search arm PASS\n'

# Arm strict: refusal names both variables before any launch, no entries.
run_smoke_arm strict 1 1
strict_status=$(cat "$work/arm-strict.exit")
strict_notice=$(count_in_entries 'pi-mistral-vibe-tether:native-search-notice' "$work/entries-strict")
strict_search=$(count_in_entries 'pi-mistral-vibe-tether:native-search"' "$work/entries-strict")
if ! grep -q 'PI_MISTRAL_VIBE_TETHER_STRICT' "$work/arm-strict.json" "$work/arm-strict.stderr" 2>/dev/null ||
  ! grep -q 'PI_MISTRAL_VIBE_TETHER_NATIVE_SEARCH' "$work/arm-strict.json" "$work/arm-strict.stderr" 2>/dev/null ||
  grep -q '"dir":"invoked"' "$work/fake-strict.log.jsonl" 2>/dev/null ||
  [[ -f "$work/evidence-strict/config.toml" ]] ||
  [[ "$strict_notice" != "0" ]] ||
  [[ "$strict_search" != "0" ]]; then
  printf 'Installed native-search strict arm failed (status %s)\n' "$strict_status" >&2
  exit 1
fi
printf 'Native-search strict arm PASS\n'

if [[ -e "$work/agent/npm/node_modules/@earendil-works/pi-tui" ]]; then
  printf 'A local pi-tui install would hide host-loader failures.\n' >&2
  exit 1
fi
printf 'Native-search Check 3 PASS\n'
