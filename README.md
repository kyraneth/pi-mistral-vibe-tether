# pi-mistral-vibe-tether

Use Mistral Vibe in [Pi](https://pi.dev) through Mistral's official `vibe-acp` server.

Pi owns the system prompt, tools, conversation history, and compaction. The tether starts `vibe-acp` using the [Agent Client Protocol](https://agentclientprotocol.com) to run the model against your Vibe subscription. When the model asks to use a tool, the tether hands the call to Pi and returns the result to the same Vibe session.

## Install

You need Node.js 22 or newer, Pi 1.5.0 or newer, a signed-in official Mistral Vibe CLI, and `vibe-acp` on your `PATH`.

```sh
vibe login
pi install npm:pi-mistral-vibe-tether
```

Start Pi and choose a model from **mistral-vibe** in `/model`. The official CLI owns your login; the tether links to it rather than copying it or asking for an API key. If your login expires, run `vibe login` again.

## Login and isolation

Each session runs in a private temporary Vibe home and an empty working directory, and never writes into `~/.vibe`. Your existing `~/.vibe/.env` is linked into that per-session home by symlink, and the tether checks only file metadata — inode, size, and modified time. It never reads, copies, or prints credential bytes, and it stops loudly if the link is missing or has been replaced.

Each session also strips inherited `VIBE_*` settings and shell API keys (`MISTRAL_API_KEY`, `MISTRAL_VIBE_API_KEY`) from the environment, and disables the keyring, update checks, auto-update, telemetry, subagents, background processes, connectors (unless you opt in), and project-context loading. This is environment and configuration isolation, not an OS filesystem sandbox.

## Models

At startup, without starting `vibe-acp`, the tether loads its private model cache. Failing that, it reads the official CLI's non-secret model catalog cache. Failing that, Pi shows two built-in offline fallbacks: Mistral Large 4.0 and Mistral Medium Latest. Refreshing models or opening a live session discovers the models and thinking effort levels `vibe-acp` advertises for your account, and caches them for later starts.

Only thinking levels the model offers are allowed — requesting a thinking level on a fixed-effort model, or an unsupported level, is refused, never silently changed. Fixed-effort models themselves work as advertised. Image input is enabled only for vision-capable models; text-only models refuse image attachments rather than dropping them. Registered context windows stay 16,000 tokens below Vibe's auto-compaction threshold, so Pi compacts first.

## Usage and cost

Per-turn token usage — input, cached reads, and output — is computed from Vibe's session-cumulative counters. Displayed dollar amounts are API-equivalent estimates from Mistral's published list rates for listed models, not billed Vibe subscription charges. Unlisted models have unavailable cost even when token counts are reported. When Vibe reports context occupancy without token spend counters, Pi still uses the occupancy for context and compaction tracking, while turn spend and cost stay unavailable rather than counting context size as spend.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_MISTRAL_VIBE_TETHER_CLI` | Path to the `vibe-acp` executable (default: searched on `PATH`). |
| `PI_MISTRAL_VIBE_TETHER_DATA_DIR` | Private cache directory (default: `~/.pi/agent/mistral-vibe-tether`). |
| `PI_MISTRAL_VIBE_TETHER_RUNTIME_DIR` | Private runtime base directory for per-session state and handoff sockets (default: system temporary directory / `TMPDIR`, falling back to `XDG_RUNTIME_DIR` if a socket path would not fit). |
| `PI_MISTRAL_VIBE_TETHER_SOURCE_VIBE_HOME` | Existing Mistral Vibe home directory to link the login from (default: `~/.vibe`). |
| `PI_MISTRAL_VIBE_TETHER_STRICT=1` | Strict mode — turn every disclosed Vibe transport limitation (and opt-in native search) into an immediate refusal. |
| `PI_MISTRAL_VIBE_TETHER_NATIVE_SEARCH=1` | Opt in to Vibe's native web search and page fetch (off by default). |

## Optional native web search

Off by default. When `PI_MISTRAL_VIBE_TETHER_NATIVE_SEARCH=1` is set, Vibe can run web searches and open web pages through its first-party web search connector alongside Pi's tools. Only the web search and page-open tools from that connector are enabled; finance, news, weather, document library, and all other connector tools stay disabled and denied at the permission boundary. Enabling connectors means Vibe still reads account connector metadata, and searches and fetches draw on your Vibe allowance.

Pi shows a one-time notice per session and one display entry per search or opened page, with the query or URL and the ranked sources, plus the character count for opened pages. Full page bodies are never copied into display entries. Strict mode refuses before starting `vibe-acp` or sending a prompt if native search is also enabled.

## Known limits

- **Warm reuse vs. cold replay.** Follow-up turns in an active Pi session reuse the live `vibe-acp` process while model, effort, prompt, and tools stay unchanged. After a restart, session change, compaction, or unexpected process exit, Pi starts a fresh Vibe session and replays prior turns as structured text — including images and tool calls and results — omitting prior thinking blocks, because Vibe has no native role-preserving history import.
- **Image attachments and ordering.** Vibe accepts at most 8 images per prompt; prompts with more than 8 images are refused rather than silently dropping attachments. In multi-turn conversations, Vibe replaces older images with text placeholders while Pi keeps the originals. Vibe also separates images from text blocks and joins text with blank lines, so interleaved image and text order is not preserved verbatim.
- **Large tool results.** When a Pi tool result exceeds 16,000 characters, Vibe may summarize it or spill it to a file excerpt before the model sees it. Pi keeps the full result and warns on screen.
- **Vibe auto-compaction.** Pi sizes context windows 16,000 tokens ahead of Vibe's threshold, but if Vibe still auto-compacts, Pi warns on screen, keeps the full transcript, retires the Vibe process, and replays Pi's history on the next turn.
- **Explicit generation controls.** Vibe does not honor Pi's explicit `temperature` or `maxTokens` overrides and uses Vibe's defaults instead. When a request sets one, Pi warns once per session for that control.
- **Harness guidance, built-in wrappers, and leading slash commands.** Vibe adds its own harness guidance around Pi's prompt base and exposes built-in programmatic tool wrappers alongside Pi's tools. Only Pi-declared tools are authorized to run in Pi; Vibe's built-in file, shell, and web tools stay disabled and denied. Vibe also intercepts leading Vibe slash commands; the tether wraps matching prompts so they reach the model as literal text.
- **Tool latency and single account.** Tool calls cross the local protocol bridge, so tool-heavy turns can take longer than a direct API provider. The tether uses the official CLI's single active login and does not manage multiple accounts.

## Status, disclosures, and strict mode

`/vibe-status` lists all five standing route facts: harness guidance, built-in tool wrappers and routing note, image and text separation, unsupported `temperature` and `maxTokens`, and leading slash-command wrapping. Harness guidance, built-in tool wrappers and routing note, and leading slash-command wrapping are recorded in the session ledger without on-screen warnings.

Image and text separation and unsupported `temperature` and `maxTokens` stay quiet on ordinary turns; they show an on-screen notice (and ledger entry) only when a turn actually triggers them, alongside the other per-event notices. Per-event notices appear on screen when something affects a turn or needs attention, once per session and cause, except unexpected exits of an idle parked `vibe-acp` process, which always report. These include explicitly ignored `temperature` and `maxTokens`, interleaved image and text reordering, tool results over 16,000 characters, cold history replay (and omitted thinking blocks), older images, Vibe auto-compaction, unexpected parked process exits, refused turns (such as more than 8 images), rate limit or quota or process errors, a missing CLI, and opt-in native search.

Run `/vibe-status` for the `vibe-acp` binary and version, the configured model and effort, the offered models, login link status, the live Vibe account plan and budget usage and reset readout (when reported), the last retirement or error, and the standing route facts.

Set `PI_MISTRAL_VIBE_TETHER_STRICT=1` to refuse immediately on any disclosed limitation, both the standing facts and the per-event notices, instead of proceeding.

[Issues](https://github.com/kyraneth/pi-mistral-vibe-tether/issues) · [Source and attribution](SOURCE.md) · [MIT License](LICENSE). Not affiliated with Mistral AI.
