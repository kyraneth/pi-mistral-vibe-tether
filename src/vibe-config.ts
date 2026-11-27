/**
 * Staging for the per-session private `VIBE_HOME` that `vibe-acp` runs with.
 *
 * The official client's custom-prompt mechanism is an agent profile, so every
 * session stages three files: `prompts/pi.md` (Pi's verbatim system prompt
 * as its base, plus on tool-enabled sessions the tether's appended
 * programmatic MCP routing note naming the session's `mcp_pi` Pi tools),
 * `agents/pi.toml` (a profile that points at it with a tool filter), and
 * `config.toml` (isolation defaults shared by all sessions). Staging happens
 * in the private runtime directory, never in the user's project or in the
 * official `~/.vibe` tree.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existingSessionDir, sessionVibeHome } from "./data-dir.js";
import { removeTreeSync } from "./runtime-dir.js";

export interface StageSessionVibeHomeInput {
  sessionId: string;
  systemPrompt: string;
  hasTools: boolean;
  activeModel?: string;
  vibeHome?: string;
  toolNames?: readonly string[];
  nativeSearch?: boolean;
}

function nativeSearchEnabledTools(hasTools: boolean): string {
  return hasTools
    ? 'enabled_tools = ["pi_*", "connector_web_search_web_search", "connector_web_search_open_url"]'
    : 'enabled_tools = ["connector_web_search_web_search", "connector_web_search_open_url"]';
}

function agentToml(hasTools: boolean, nativeSearch?: boolean): string {
  const lines = [
    'display_name = "Pi"',
    'description = "Pi-driven session"',
    'system_prompt_id = "pi"',
    // Pi declares the tools it authorizes; nothing else runs.
    nativeSearch
      ? nativeSearchEnabledTools(hasTools)
      : hasTools
        ? 'enabled_tools = ["pi_*"]'
        : 'disabled_tools = ["*"]',
  ];
  return `${lines.join("\n")}\n`;
}

function configToml(input: {
  hasTools: boolean;
  activeModel?: string;
  nativeSearch?: boolean;
}): string {
  const nativeSearch = input.nativeSearch === true;
  const lines = [
    'default_agent = "pi"',
    'default_approval_policy = "ask"',
    "include_project_context = false",
    "include_commit_signature = false",
    "enable_subagents = false",
    "enable_background_processes = false",
    `enable_connectors = ${nativeSearch ? "true" : "false"}`,
    ...(nativeSearch
      ? [
          "experimental_enable_document_library_connector = false",
          "experimental_enable_mistral_mcp_connector = false",
        ]
      : []),
    `enable_mcp = ${input.hasTools ? "true" : "false"}`,
    "enable_update_checks = false",
    "enable_auto_update = false",
    "enable_telemetry = false",
    nativeSearch
      ? nativeSearchEnabledTools(input.hasTools)
      : input.hasTools
        ? 'enabled_tools = ["pi_*"]'
        : 'disabled_tools = ["*"]',
    ...(input.activeModel ? [`active_model = "${input.activeModel}"`] : []),
    "",
    "[session_logging]",
    "generate_titles = false",
    ...(nativeSearch
      ? [
          "",
          "[[connectors]]",
          'name = "web_search"',
          "disabled = false",
          'disabled_tools = ["finance_search", "news_search", "weather_search"]',
        ]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Stage the complete private home for one ACP session and return its path.
 * It starts in an empty working directory with `include_project_context = false` so Vibe does not auto-load project context (environment and configuration isolation, not an OS filesystem sandbox);
 * Pi executes its tools in Pi's own working directory.
 */
export async function stageSessionVibeHome(
  input: StageSessionVibeHomeInput,
): Promise<string> {
  const vibeHome = input.vibeHome ?? sessionVibeHome(input.sessionId);
  const workspace = join(vibeHome, "workspace");
  const agents = join(vibeHome, "agents");
  const prompts = join(vibeHome, "prompts");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(agents, { recursive: true, mode: 0o700 });
  await mkdir(prompts, { recursive: true, mode: 0o700 });
  // The prompt is written verbatim; Pi owns its text. When tools are
  // present, the client still offers its own direct tools, so append the
  // programmatic routing note naming the Pi tools for this session.
  const routingNote =
    input.hasTools && input.toolNames && input.toolNames.length > 0
      ? `[Tool transport note: Vibe's built-in direct tools (read_file, write_file, edit, bash, grep, glob, web_fetch, skill) are disabled in this session. Every Pi tool is mounted on the \`mcp_pi\` programmatic MCP namespace and must be invoked via \`run_typescript\` as \`await tools.mcp_pi.<name>(args)\` (use \`search_tool_functions\` with query "mcp_pi" to inspect parameter schemas). Available Pi tools: ${input.toolNames.join(", ")}${
          input.nativeSearch === true
            ? ". Native web search is also enabled: \`connector_web_search.web_search\` and \`connector_web_search.open_url\` are also enabled alongside \`mcp_pi\`"
            : ""
        }.]`
      : undefined;
  const promptContent =
    routingNote !== undefined
      ? `${input.systemPrompt}\n\n${routingNote}`
      : input.systemPrompt;
  await writeFile(join(prompts, "pi.md"), promptContent, { mode: 0o600 });
  await writeFile(
    join(agents, "pi.toml"),
    agentToml(input.hasTools, input.nativeSearch),
    { mode: 0o600 },
  );
  await writeFile(
    join(vibeHome, "config.toml"),
    configToml({
      hasTools: input.hasTools,
      activeModel: input.activeModel,
      nativeSearch: input.nativeSearch,
    }),
    { mode: 0o600 },
  );
  return vibeHome;
}

/** Remove one session's staged home without allocating a runtime directory. */
export async function removeSessionVibeHome(sessionId: string): Promise<void> {
  const staged = existingSessionDir(sessionId);
  if (!staged) return;
  removeTreeSync(join(staged, "vibe-home"));
}

/**
 * Stage a quiet home for catalog and status probes: no prompt, no tools, no
 * MCP, and nothing the client should phone home about.
 */
export async function stageProbeVibeHome(vibeHome: string): Promise<string> {
  await mkdir(join(vibeHome, "workspace"), { recursive: true, mode: 0o700 });
  const lines = [
    'default_approval_policy = "ask"',
    "include_project_context = false",
    "include_commit_signature = false",
    "enable_subagents = false",
    "enable_background_processes = false",
    "enable_connectors = false",
    "enable_mcp = false",
    "enable_update_checks = false",
    "enable_auto_update = false",
    "enable_telemetry = false",
    'disabled_tools = ["*"]',
    "",
    "[session_logging]",
    "generate_titles = false",
  ];
  await writeFile(join(vibeHome, "config.toml"), `${lines.join("\n")}\n`, {
    mode: 0o600,
  });
  return vibeHome;
}
