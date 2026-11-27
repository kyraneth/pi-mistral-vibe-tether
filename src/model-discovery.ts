/**
 * Which models the installed build offers this login, learned from the server.
 *
 * The official client keeps its model catalog in `model_catalog_cache.json`.
 * The tether reads that non-secret cache first, then falls back to one short
 * ACP handshake (no prompt, no tokens, the login linked by reference only),
 * and finally to the built-in offline models. The discovered answer is kept
 * in the tether's private cache so later starts stay instant.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { AcpClient, CLIENT_CAPABILITIES, CLIENT_INFO } from "./acp-client.js";
import {
  FALLBACK_MODELS,
  MISTRAL_LIST_COSTS,
  VIBE_EFFORTS,
  modelsFromConfigOptions,
  parseVibeCatalogCache,
  setVibeCatalog,
  vibeCatalog,
  type VibeEffort,
  type VibeModelSpec,
} from "./catalog.js";
import { catalogCachePath, hostCatalogCachePath } from "./data-dir.js";
import { linkHostLogin } from "./login.js";
import { forceKillProcess, spawnAcpProbe } from "./process-manager.js";
import { runtimeDir } from "./runtime-dir.js";
import { stageProbeVibeHome } from "./vibe-config.js";

const CACHE_VERSION = 1;

export type CatalogAuthority = "authoritative" | "partial";

/** One cached spec as plain JSON, with the windows the server actually used. */
function toCachedSpec(spec: VibeModelSpec): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.name,
    rawContextWindow: spec.rawContextWindow,
    vibeAutoCompactThreshold: spec.vibeAutoCompactThreshold,
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    supportsImages: spec.supportsImages,
    effortLevels: [...spec.effortLevels],
    cost: { ...spec.cost },
    costKnown: typeof spec.costKnown === "boolean" ? spec.costKnown : Object.hasOwn(MISTRAL_LIST_COSTS, spec.id),
  };
}

function parseCachedSpec(entry: unknown): VibeModelSpec | undefined {
  const raw = (entry ?? {}) as Record<string, any>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  const numbers = ["rawContextWindow", "vibeAutoCompactThreshold", "contextWindow", "maxTokens"];
  for (const key of numbers) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) return undefined;
  }
  if (typeof raw.supportsImages !== "boolean") return undefined;
  if (!Array.isArray(raw.effortLevels)) return undefined;
  const effortLevels = raw.effortLevels.filter((level: unknown): level is string => typeof level === "string");
  if (effortLevels.length !== raw.effortLevels.length) return undefined;
  const cost = (raw.cost ?? {}) as Record<string, any>;
  const costNumbers: Record<string, number> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (typeof cost[key] !== "number" || !Number.isFinite(cost[key])) return undefined;
    costNumbers[key] = cost[key];
  }
  return {
    id: raw.id as string,
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : (raw.id as string),
    rawContextWindow: raw.rawContextWindow as number,
    vibeAutoCompactThreshold: raw.vibeAutoCompactThreshold as number,
    contextWindow: raw.contextWindow as number,
    maxTokens: raw.maxTokens as number,
    supportsImages: raw.supportsImages as boolean,
    effortLevels: effortLevels as VibeModelSpec["effortLevels"],
    cost: costNumbers as VibeModelSpec["cost"],
    costKnown:
      typeof raw.costKnown === "boolean"
        ? (raw.costKnown as boolean)
        : Object.hasOwn(MISTRAL_LIST_COSTS, raw.id as string),
  };
}

/**
 * The cached catalog with how complete it was when written. Existing
 * caches without an `authority` field read as `partial`, the safe default.
 */
export function readCachedCatalogWithAuthority(
  path = catalogCachePath(),
): { models: VibeModelSpec[]; authority: CatalogAuthority } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      version?: unknown;
      models?: unknown;
      authority?: unknown;
    };
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.models)) return undefined;
    const specs = parsed.models
      .map(parseCachedSpec)
      .filter((spec): spec is VibeModelSpec => spec !== undefined);
    if (specs.length === 0) return undefined;
    const authority: CatalogAuthority =
      parsed.authority === "authoritative" ? "authoritative" : "partial";
    return { models: specs, authority };
  } catch {
    return undefined;
  }
}

/** The catalog the last session advertised, or nothing if the cache is unusable. */
export function readCachedCatalog(path = catalogCachePath()): VibeModelSpec[] | undefined {
  return readCachedCatalogWithAuthority(path)?.models;
}

/** Keep the discovered catalog for the next start. Failing to write is not fatal. */
export function writeCachedCatalog(
  models: readonly VibeModelSpec[],
  path = catalogCachePath(),
  authority: CatalogAuthority = "partial",
): void {
  const payload = {
    version: CACHE_VERSION,
    source: "vibe-acp session/new",
    authority,
    models: models.map(toCachedSpec),
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    /* a cache that cannot be written costs one probe on the next start */
  }
}

/** Read the official host catalog cache (model ids and limits only, no credentials). */
export function readHostVibeCatalog(path = hostCatalogCachePath()): VibeModelSpec[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const specs = parseVibeCatalogCache(parsed);
    return specs.length > 0 ? specs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The best catalog without spawning anything: the private cache, else the
 * official host cache, else the built-ins.
 */
export function cachedOrFallbackCatalog(): {
  models: readonly VibeModelSpec[];
  source: "cache" | "host" | "fallback";
} {
  const cached = readCachedCatalog();
  if (cached) return { models: cached, source: "cache" };
  const host = readHostVibeCatalog();
  if (host) return { models: host, source: "host" };
  return { models: FALLBACK_MODELS, source: "fallback" };
}

/** A cold catalog discovery also observes capabilities from its initialize. */
export async function probeStartup(
  discoverCatalog: boolean,
  options?: { signal?: AbortSignal },
): Promise<{ models: VibeModelSpec[]; image?: boolean; authority: CatalogAuthority }> {
  let proc: ReturnType<typeof spawnAcpProbe> | undefined;
  let client: AcpClient | undefined;
  let image: boolean | undefined;
  let probeHome: string | undefined;
  try {
    probeHome = join(runtimeDir(), `probe-${randomUUID().slice(0, 8)}`);
    await stageProbeVibeHome(probeHome);
    // Only session/new needs authentication. Initialize is local.
    if (discoverCatalog) await linkHostLogin(probeHome);
    proc = spawnAcpProbe(probeHome);
    client = new AcpClient(proc, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" }),
      onDiagnostic() {},
    });
    const initialized = await client.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      },
      { signal: options?.signal },
    );
    image = initialized?.agentCapabilities?.promptCapabilities?.image === true;
    const opened = discoverCatalog
      ? await client.request("session/new", { cwd: join(probeHome, "workspace"), mcpServers: [] }, { signal: options?.signal })
      : undefined;
    const configOptions = opened?.configOptions;
    return { image, authority: "partial" as CatalogAuthority, models: opened ? modelsFromConfigOptions(configOptions, vibeCatalog()) : [] };
  } catch {
    return { image, authority: "partial" as CatalogAuthority, models: [] };
  } finally {
    client?.dispose();
    await forceKillProcess(proc);
    if (probeHome) await rm(probeHome, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The catalog for this process: the private cache, else the official host
 * cache, else one probe, else the built-in models. Never throws and never
 * leaves the process without a catalog.
 */
export async function startupCatalog(options?: { signal?: AbortSignal }): Promise<{
  models: readonly VibeModelSpec[];
  image?: boolean;
}> {
  const cached = readCachedCatalog();
  if (cached) return { models: cached };
  const host = readHostVibeCatalog();
  if (host) return { models: host };
  const probed = await probeStartup(true, options);
  if (probed.models.length > 0) {
    const adopted = adoptCatalogModels(probed.models, { authority: "partial" });
    return { models: adopted, image: probed.image };
  }
  return { models: FALLBACK_MODELS, image: probed.image };
}

/**
 * Adopt a probed or externally supplied catalog into the live catalog and
 * the tether cache. A cold session/new answer is never authoritative: a
 * partial adoption merges the incoming specs into the existing catalog
 * (offered specs update by id, every unlisted existing spec is retained
 * regardless of length) and caches the merged catalog as `"partial"`.
 * Only an explicit `"authoritative"` adoption replaces the catalog and
 * evicts unlisted models, caching the replacement as `"authoritative"`.
 * Empty incoming evidence never wipes or overwrites the catalog.
 */
export function adoptCatalogModels(
  incoming: readonly VibeModelSpec[],
  options?: { authority?: CatalogAuthority; path?: string },
): readonly VibeModelSpec[] {
  const authority: CatalogAuthority = options?.authority ?? "partial";
  const existing = vibeCatalog();
  if (incoming.length === 0) return existing;
  let merged: VibeModelSpec[];
  if (authority === "authoritative") {
    merged = [...incoming];
  } else {
    const incomingIds = new Set(incoming.map((spec) => spec.id));
    merged = [...incoming, ...existing.filter((spec) => !incomingIds.has(spec.id))];
  }
  setVibeCatalog(merged);
  writeCachedCatalog(merged, options?.path, authority);
  return merged;
}

function thinkingLevelsFromConfigOptions(configOptions: unknown): VibeEffort[] {
  if (!Array.isArray(configOptions)) return [];
  const thinking = (configOptions as any[]).find((option) => option?.id === "thinking");
  if (!thinking || !Array.isArray(thinking.options)) return [];
  const values: string[] = thinking.options
    .map((option: any) => option?.value)
    .filter((value: unknown): value is string => typeof value === "string");
  const ordered: VibeEffort[] = [];
  for (const effort of VIBE_EFFORTS) {
    if (
      values.some((value) => {
        const normalized = value.trim().toLowerCase() === "none" ? "off" : value.trim().toLowerCase();
        return normalized === effort;
      })
    ) {
      if (!ordered.includes(effort)) ordered.push(effort);
    }
  }
  return ordered;
}

function activeModelIdFromConfigOptions(configOptions: unknown): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const model = (configOptions as any[]).find((option) => option?.id === "model");
  return typeof model?.currentValue === "string" && model.currentValue.length > 0 ? model.currentValue : undefined;
}

/**
 * Adopt one `configOptions` answer: refresh the cache and the catalog the
 * effort validation reads. A cold or single-session answer may omit
 * remote models, so a partial answer always merges into the existing
 * catalog (offered specs update by id, every unlisted spec is retained)
 * regardless of list lengths. Only an authoritative catalog — an
 * explicit catalog probe — replaces the catalog, evicting stale
 * unlisted models that are no longer entitled.
 */
export function rememberOfferedModels(
  configOptions: unknown,
  options?: { authority?: CatalogAuthority },
): readonly VibeModelSpec[] {
  const authority: CatalogAuthority = options?.authority ?? "partial";
  const existing = vibeCatalog();
  const offered = modelsFromConfigOptions(configOptions, existing);
  if (offered.length > 0) {
    let merged: VibeModelSpec[];
    if (authority === "authoritative") {
      merged = [...offered];
    } else {
      const offeredIds = new Set(offered.map((spec) => spec.id));
      merged = [...offered, ...existing.filter((spec) => !offeredIds.has(spec.id))];
    }
    const activeModelId = activeModelIdFromConfigOptions(configOptions);
    const thinkingLevels = thinkingLevelsFromConfigOptions(configOptions);
    if (activeModelId && thinkingLevels.length > 0) {
      merged = merged.map((spec) =>
        spec.id === activeModelId ? { ...spec, effortLevels: thinkingLevels } : spec,
      );
    }
    setVibeCatalog(merged);
    writeCachedCatalog(merged, undefined, authority);
    return merged;
  }
  return FALLBACK_MODELS;
}
