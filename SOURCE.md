# pi-mistral-vibe-tether — source provenance

This package belongs to the `pi-tether` family of Pi extensions that route LLM calls through an official vendor CLI process. The shared pieces (private runtime directories, request signatures, metadata ledgers, and MCP handoff plumbing) come from the published [`pi-tether-core`](https://github.com/kyraneth/pi-tether-core) package; the lineage traces back to MIT-licensed [`pi-claude-tether`](https://github.com/kyraneth/pi-claude-tether).

The template's architecture is kept: Pi owns the system prompt, the tool surface and the history; one long-lived official CLI process per session serves follow-up turns; every tool executes in Pi; warm reuse is passive rather than periodic refreshing.

What is specific to Mistral Vibe:

- The transport is Mistral's official `vibe-acp` server (Agent Client Protocol over stdio) instead of a vendor API key, so inference draws on the user's Vibe allowance.
- The system prompt reaches the model through a staged per-session agent profile: `prompts/pi.md` uses Pi's verbatim system prompt as its base and, on tool-enabled sessions, appends the tether's programmatic MCP routing note naming the session's `mcp_pi` Pi tools, in addition to Mistral Vibe's own harness capability guidance. `agents/pi.toml` points at it with a tool filter, and `config.toml` forces an ask approval policy with updates, telemetry, subagents, connectors, and project context disabled. Mistral Vibe's local built-in programmatic wrappers (`run_typescript` / `search_tool_functions`) and residual tool declarations are distinct from Pi-authorized tools (`mcp_pi.<name>`). Pi-authorized tools are the only tools approved at the ACP permission boundary and executed by Pi.
- The login handoff is stat-only: the existing `~/.vibe/.env` is symlinked into the private `VIBE_HOME` and verified by inode, size, and modified time. Credential bytes are never read, copied, parsed, or logged.
- The spawned process environment strips all inherited `VIBE_*` variables and shell API keys (including `MISTRAL_API_KEY` and `MISTRAL_VIBE_API_KEY`) before pinning the isolation settings, and disables the client-side keyring, so `vibe-acp` cannot silently fall back to a shell API key. Each ACP incarnation starts in its own private `VIBE_HOME` and an empty working directory (`cwd`) with its own staged agent profile and `include_project_context = false`, so Vibe does not auto-load project-context files. This is environment and configuration isolation, not an OS filesystem sandbox.

Public export is enforced by `npm run scan:public` (`scripts/check-public-tree.mjs` over the manifest from `scripts/export-manifest`).
