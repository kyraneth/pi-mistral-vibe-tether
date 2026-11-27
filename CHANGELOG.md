# Changelog

## 0.1.0

- Drive Mistral's official `vibe-acp` from Pi on an existing Mistral Vibe subscription login, linked by reference in an isolated per-session Vibe home. No API key required.
- Pi owns the system prompt, tools, conversation history, and compaction, with context windows sized 16,000 tokens ahead of Vibe's auto-compaction threshold.
- Authorize and execute only Pi-declared tools for the active session in Pi, keeping Vibe's built-in local tools disabled and denied.
- Discover models and per-model effort levels live, with vision support checked per model, plus per-turn token usage and API-equivalent cost estimates from Mistral's published list rates — leaving unlisted models and unavailable spend clearly unavailable rather than zero.
- Reuse warm sessions between turns, with automatic history replay on restart, compaction, or process exit.
- Opt in to native web search and page fetch with `PI_MISTRAL_VIBE_TETHER_NATIVE_SEARCH=1`, narrowed to the web search connector's search and page-open tools, with visible source entries.
- Record standing route facts in the session ledger and `/vibe-status`, alongside the live account and budget readout, while actionable per-event notices appear on screen.
- Refuse disclosed transport limitations and native search instead of proceeding when `PI_MISTRAL_VIBE_TETHER_STRICT=1` is set.
