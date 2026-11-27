/**
 * Opt-in native web search and page fetch through Vibe's web_search
 * connector, surfaced as display-only Pi entries.
 *
 * Pi remains the tool and transcript owner: these helpers only decide
 * whether the two connector tools are authorized, whether a call's
 * input is safe, and how a completed call is rendered. Full page
 * bodies never enter a display entry.
 */

export const NATIVE_SEARCH_ENV = "PI_MISTRAL_VIBE_TETHER_NATIVE_SEARCH";
export const NATIVE_SEARCH_NOTICE_ENTRY = "pi-mistral-vibe-tether:native-search-notice";
export const NATIVE_SEARCH_ENTRY = "pi-mistral-vibe-tether:native-search";
export const NATIVE_SEARCH_NOTICE =
  "Vibe may search and open web pages itself; its sources appear here. (Narrowed to connector_web_search.web_search and open_url; Vibe still reads account connector metadata when connectors are on, though all other connector tools stay disabled and denied.)";

export const NATIVE_SEARCH_TOOL_NAMES: readonly string[] = [
  "connector_web_search.web_search",
  "connector_web_search.open_url",
];
export const NATIVE_SEARCH_CONFIG_TOOLS: readonly string[] = [
  "connector_web_search_web_search",
  "connector_web_search_open_url",
];

export interface NativeSearchSource {
  title?: string;
  url: string;
}

export interface NativeSearchEntry {
  id: string;
  acpSessionId: string;
  kind: "search" | "fetch";
  tool: string;
  status: "completed" | "failed" | "cancelled";
  query?: string;
  url?: string;
  sources: NativeSearchSource[];
  charCount?: number;
}

export interface NativeSearchSurface {
  announce(): void;
  record(entry: NativeSearchEntry): void;
}

export function nativeSearchEnabled(): boolean {
  return process.env[NATIVE_SEARCH_ENV] === "1";
}

export function isAuthorizedNativeSearchTool(toolName: unknown): boolean {
  return (
    toolName === "connector_web_search.web_search" ||
    toolName === "connector_web_search.open_url"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidOpenUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    return scheme === "http" || scheme === "https";
  }
  // Bare host without a scheme (for example "example.com/page").
  return !/\s/.test(trimmed);
}

export function isValidNativeSearchInput(
  toolName: unknown,
  input: unknown,
  _meta?: unknown,
): boolean {
  void _meta;
  if (toolName === "connector_web_search.web_search") {
    if (!isRecord(input)) return false;
    const query = input.query;
    return typeof query === "string" && query.trim().length > 0;
  }
  if (toolName === "connector_web_search.open_url") {
    if (!isRecord(input)) return false;
    return isValidOpenUrl(input.url);
  }
  return false;
}

const sanitizePattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

function sanitizeText(value: unknown): string {
  return String(value ?? "").replace(sanitizePattern, "");
}

function formatSourceList(sources: NativeSearchSource[]): string[] {
  return sources.map((source, index) => {
    const title = sanitizeText(source.title ?? "");
    const url = sanitizeText(source.url ?? "");
    return `${index + 1}. ${title ? `${title} — ` : ""}${url}`;
  });
}

/** One display line block for a completed or flushed call; never includes page bodies. */
export function nativeSearchLabel(entry: NativeSearchEntry): string {
  const status = sanitizeText(entry.status);
  const count = entry.sources.length;
  if (entry.kind === "fetch") {
    const url = sanitizeText(entry.url ?? "");
    const size =
      typeof entry.charCount === "number" && Number.isFinite(entry.charCount)
        ? `, ${entry.charCount} characters`
        : "";
    const lines = [
      `Opened page ${url} (${status}${size}):`,
      ...formatSourceList(entry.sources),
    ];
    return lines.join("\n");
  }
  const query = sanitizeText(entry.query ?? "");
  const lines = [
    `Web search "${query}" (${status}, ${count} source${count === 1 ? "" : "s"}):`,
    ...formatSourceList(entry.sources),
  ];
  return lines.join("\n");
}

function resolveToolName(update: Record<string, unknown>): string | undefined {
  const meta = update._meta;
  if (isRecord(meta) && typeof meta.tool_name === "string") return meta.tool_name;
  if (typeof update.tool_name === "string") return update.tool_name;
  return undefined;
}

function resolveCallId(update: Record<string, unknown>): string | undefined {
  for (const key of ["toolCallId", "id", "callId"] as const) {
    const value = update[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function inputOf(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const input = update.rawInput ?? update.input;
  return isRecord(input) ? input : undefined;
}

function mapSources(value: unknown): NativeSearchSource[] {
  if (!Array.isArray(value)) return [];
  const sources: NativeSearchSource[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    // Raw ranked sources carry { title, url }; location mirrors carry
    // the URL in `path` and the title under `_meta.title`.
    const url = typeof item.url === "string" ? item.url : item.path;
    if (typeof url !== "string" || url.length === 0) continue;
    const meta = isRecord(item._meta) ? item._meta : undefined;
    const title =
      typeof item.title === "string"
        ? item.title
        : typeof meta?.title === "string"
          ? (meta.title as string)
          : undefined;
    if (title) sources.push({ title, url });
    else sources.push({ url });
  }
  return sources;
}

function locationsOf(update: Record<string, unknown>): unknown {
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
  if (Array.isArray(update.locations)) return update.locations;
  if (rawOutput && Array.isArray(rawOutput.locations)) return rawOutput.locations;
  return undefined;
}

function charCountOf(update: Record<string, unknown>): number | undefined {
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
  if (rawOutput && typeof rawOutput.content === "string") {
    return rawOutput.content.length;
  }
  const locations = locationsOf(update);
  if (Array.isArray(locations) && locations.length > 0 && isRecord(locations[0])) {
    const meta = isRecord((locations[0] as Record<string, unknown>)._meta)
      ? (locations[0] as Record<string, unknown>)._meta as Record<string, unknown>
      : undefined;
    const count = meta?.char_count;
    if (typeof count === "number" && Number.isFinite(count)) return count;
  }
  return undefined;
}

interface PendingCall {
  key: string;
  callId: string;
  acpSessionId: string;
  kind: "search" | "fetch";
  tool: string;
  query: string | undefined;
  url: string | undefined;
}

export interface NativeSearchWatcher {
  handleUpdate(update: unknown, acpSessionId: string): void;
  flushIncomplete(acpSessionId: string, status?: "cancelled" | "failed"): void;
}

export function watchNativeSearch(
  onEntry: (entry: NativeSearchEntry) => void,
): NativeSearchWatcher {
  const pending = new Map<string, PendingCall>();
  const emitted = new Set<string>();
  let sequence = 0;

  function keyFor(acpSessionId: string, callId: string): string {
    return `${acpSessionId}\u0000${callId}`;
  }

  function emit(entry: NativeSearchEntry): void {
    try {
      onEntry(entry);
    } catch {
      /* a display consumer fault must not break ACP routing */
    }
  }

  function buildEntry(
    call: PendingCall,
    update: Record<string, unknown> | undefined,
    status: "completed" | "failed" | "cancelled",
  ): NativeSearchEntry {
    sequence += 1;
    const id = `native-search-${sequence}-${call.callId}`;
    const rawOutput =
      update && isRecord(update.rawOutput) ? update.rawOutput : undefined;
    const liveInput = update ? inputOf(update) : undefined;
    const query =
      typeof liveInput?.query === "string" ? liveInput.query : call.query;
    const url =
      typeof liveInput?.url === "string"
        ? liveInput.url
        : call.url ??
          (rawOutput && typeof rawOutput.url === "string" ? rawOutput.url : undefined);

    if (call.kind === "search") {
      let sources = rawOutput ? mapSources(rawOutput.sources) : [];
      if (!rawOutput || !Array.isArray(rawOutput.sources)) {
        sources = mapSources(locationsOf(update ?? {}));
      }
      const entry: NativeSearchEntry = {
        id,
        acpSessionId: call.acpSessionId,
        kind: "search",
        tool: call.tool,
        status,
        sources,
      };
      if (query !== undefined) entry.query = query;
      return entry;
    }

    let sources = mapSources(locationsOf(update ?? {}));
    if (sources.length === 0 && url) sources = [{ url }];
    const entry: NativeSearchEntry = {
      id,
      acpSessionId: call.acpSessionId,
      kind: "fetch",
      tool: call.tool,
      status,
      sources,
    };
    if (url !== undefined) entry.url = url;
    const count = update ? charCountOf(update) : undefined;
    if (count !== undefined) entry.charCount = count;
    return entry;
  }

  function handleUpdate(update: unknown, acpSessionId: string): void {
    if (!isRecord(update)) return;
    const sessionUpdate =
      typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") return;
    const callId = resolveCallId(update);
    if (!callId) return;
    const key = keyFor(acpSessionId, callId);
    if (emitted.has(key)) return;

    if (sessionUpdate === "tool_call") {
      const tool = resolveToolName(update);
      if (!isAuthorizedNativeSearchTool(tool)) return;
      const input = inputOf(update);
      const query = typeof input?.query === "string" ? input.query : undefined;
      const url = typeof input?.url === "string" ? input.url : undefined;
      pending.set(key, {
        key,
        callId,
        acpSessionId,
        kind:
          tool === "connector_web_search.open_url" ? "fetch" : "search",
        tool: tool as string,
        query,
        url,
      });
      return;
    }

    const call = pending.get(key);
    if (!call) return;
    const status = typeof update.status === "string" ? update.status : "";
    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      const input = inputOf(update);
      if (typeof input?.query === "string") call.query = input.query;
      if (typeof input?.url === "string") call.url = input.url;
      return;
    }
    pending.delete(key);
    emitted.add(key);
    emit(buildEntry(call, update, status));
  }

  function flushIncomplete(
    acpSessionId: string,
    status: "cancelled" | "failed" = "cancelled",
  ): void {
    const targets = [...pending.values()].filter(
      (call) => call.acpSessionId === acpSessionId,
    );
    for (const call of targets) {
      pending.delete(call.key);
      emitted.add(call.key);
      emit(buildEntry(call, undefined, status));
    }
  }

  return { handleUpdate, flushIncomplete };
}
