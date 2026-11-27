/**
 * The model catalog Pi registers for the Vibe provider.
 *
 * Pi owns compaction, so the registered window stays a fixed 16,000 tokens
 * ahead of the server's own auto-compaction threshold. The server threshold
 * itself follows the product bounds: an explicit catalog threshold when
 * offered, otherwise a derived default clamped into the product range.
 * Effort levels are exactly what the server offers for the model; an
 * unsupported request is a refusal, never a silent clamp.
 */

/** Effort levels in the order the server advertises them. */
export const VIBE_EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type VibeEffort = (typeof VIBE_EFFORTS)[number];

/** Pi stays this many tokens ahead of the server's auto-compaction threshold. */
export const PI_COMPACTION_HEADROOM_TOKENS = 16_000;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * The server's effective auto-compaction threshold for one raw window.
 *
 * Bounds follow the product rule: `minimum = max(min(50k, floor(window/2)), 10k)`,
 * `maximum = window - min(24k, ceil(window/4))`. A positive integer explicit
 * threshold is used after clamping into that range; otherwise the derived
 * default `clamp(min(256k, window - 60k), minimum, maximum)` applies.
 */
export function computeVibeCompactionThreshold(rawContextWindow: number, explicitThreshold?: number | null): number {
  const minimum = Math.max(Math.min(50_000, Math.floor(rawContextWindow / 2)), 10_000);
  const headroom = Math.min(24_000, Math.ceil(rawContextWindow / 4));
  const maximum = rawContextWindow - headroom;
  if (typeof explicitThreshold === "number" && Number.isInteger(explicitThreshold) && explicitThreshold > 0) {
    return clamp(explicitThreshold, minimum, maximum);
  }
  const derived = Math.min(256_000, rawContextWindow - 60_000);
  return clamp(derived, minimum, maximum);
}

/** Pi's registered window: the server threshold less the Pi-ahead headroom. */
export function piAheadContextWindow(rawContextWindow: number, vibeThreshold: number): number {
  return Math.min(rawContextWindow, Math.max(10_000, vibeThreshold - PI_COMPACTION_HEADROOM_TOKENS));
}

export interface VibeModelSpec {
  id: string;
  name: string;
  rawContextWindow: number;
  vibeAutoCompactThreshold: number;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  effortLevels: readonly VibeEffort[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costKnown: boolean;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Notional list rates per 1M tokens, matching the published API catalog.
 * These are API-equivalent figures for budgeting, not subscription charges.
 * Published rates list input, output and cache read; cache write is charged
 * at the cache-read rate. Unlisted models bill at zero here.
 */
export const MISTRAL_LIST_COSTS: Readonly<Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>> = {
  "deepseek-v4-1-flash-1017": { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0.007 },
  "mistral-large-4-0": { input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0.07 },
  "mistral-medium-latest": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0.15 },
  "mistral-medium-3.5": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0.15 },
  "zai-glm-5-3": { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0.14 },
  "zai-glm-5-3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.03 },
  "zai-glm-5-3-flash-vibe-free": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.03 },
};

/** Whether a published API-equivalent list rate is known for this model id. */
export function isModelCostKnown(modelId: string): boolean {
  return Object.hasOwn(MISTRAL_LIST_COSTS, modelId);
}

/**
 * Reporting status for a spec or id: `"api-equivalent"` when a list rate is
 * published, `"unknown"` when the model is unlisted (cost stays at the zero
 * placeholder, but reporting must not present it as a known price).
 */
export function modelCostStatus(specOrId: VibeModelSpec | string): "api-equivalent" | "unknown" {
  if (typeof specOrId === "string") {
    return isModelCostKnown(specOrId) ? "api-equivalent" : "unknown";
  }
  return typeof specOrId.costKnown === "boolean"
    ? specOrId.costKnown
      ? "api-equivalent"
      : "unknown"
    : isModelCostKnown(specOrId.id)
      ? "api-equivalent"
      : "unknown";
}

function specFromRaw(
  id: string,
  name: string,
  rawContextWindow: number,
  explicitThreshold: number | null | undefined,
  maxTokens: number,
  supportsImages: boolean,
  effortLevels: readonly VibeEffort[],
): VibeModelSpec {
  const vibeAutoCompactThreshold = computeVibeCompactionThreshold(rawContextWindow, explicitThreshold);
  return {
    id,
    name,
    rawContextWindow,
    vibeAutoCompactThreshold,
    contextWindow: piAheadContextWindow(rawContextWindow, vibeAutoCompactThreshold),
    maxTokens,
    supportsImages,
    effortLevels,
    cost: MISTRAL_LIST_COSTS[id] ?? ZERO_COST,
    costKnown: Object.hasOwn(MISTRAL_LIST_COSTS, id),
  };
}

/** Built-in offline models, used before any discovery. */
export const FALLBACK_MODELS: readonly VibeModelSpec[] = [
  {
    id: "mistral-large-4-0",
    name: "Mistral Large 4.0",
    rawContextWindow: 1_048_576,
    vibeAutoCompactThreshold: 400_000,
    contextWindow: 384_000,
    maxTokens: 262_144,
    supportsImages: true,
    effortLevels: ["low", "medium", "high"],
    cost: MISTRAL_LIST_COSTS["mistral-large-4-0"] ?? ZERO_COST,
    costKnown: true,
  },
  {
    id: "mistral-medium-latest",
    name: "Mistral Medium Latest",
    rawContextWindow: 262_144,
    vibeAutoCompactThreshold: 202_144,
    contextWindow: 186_144,
    maxTokens: 262_144,
    supportsImages: true,
    effortLevels: ["off", "high"],
    cost: MISTRAL_LIST_COSTS["mistral-medium-latest"] ?? ZERO_COST,
    costKnown: true,
  },
];

function normalizeEffortLevels(raw: unknown): VibeEffort[] {
  const values: unknown[] = Array.isArray(raw) ? [...raw] : raw === undefined || raw === null ? [] : [raw];
  const ordered: VibeEffort[] = [];
  for (const effort of VIBE_EFFORTS) {
    if (values.some((value) => {
      if (typeof value !== "string") return false;
      const normalized = value.trim().toLowerCase() === "none" ? "off" : value.trim().toLowerCase();
      return normalized === effort;
    })) {
      if (!ordered.includes(effort)) ordered.push(effort);
    }
  }
  return ordered;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOneCatalogEntry(entry: unknown): VibeModelSpec | undefined {
  const raw = (entry ?? {}) as Record<string, any>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  if (raw.requires !== null && raw.requires !== undefined) return undefined;
  const id = raw.id;
  const name = typeof raw.label === "string" && raw.label.length > 0 ? raw.label : typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id;
  const rawContextWindow = numeric(raw.max_context_length) ?? numeric(raw.raw_context_window) ?? numeric(raw.contextWindow) ?? numeric(raw.maxContextLength) ?? 262_144;
  const parameters = (raw.parameters ?? {}) as Record<string, any>;
  const reasoning = parameters.reasoning ?? raw.reasoning;
  const explicit = numeric(parameters.auto_compact_threshold) ?? numeric(raw.auto_compact_threshold) ?? numeric(parameters.autoCompactThreshold) ?? numeric(raw.autoCompactThreshold) ?? null;
  const explicitThreshold = explicit !== undefined && explicit !== null ? explicit : null;
  const vision = raw.capabilities?.vision ?? raw.supportsImages ?? raw.vision ?? false;
  const supportsImages = vision === true;
  const maxTokens = numeric(raw.max_tokens) ?? numeric(raw.maxTokens) ?? numeric(parameters.max_output_tokens) ?? 262_144;
  return specFromRaw(id, name, rawContextWindow, explicitThreshold, maxTokens, supportsImages, normalizeEffortLevels(reasoning));
}

/**
 * Parse the official `model_catalog_cache.json` shape: a hash-keyed map of
 * `{ stored_at_timestamp, payload: { models: [...] } }` entries.
 */
export function parseVibeCatalogCache(raw: unknown): VibeModelSpec[] {
  if (!raw || typeof raw !== "object") return [];
  const collected: unknown[] = [];
  const root = raw as Record<string, any>;
  if (Array.isArray(root.models)) {
    collected.push(...root.models);
  } else if (root.payload && Array.isArray(root.payload.models)) {
    collected.push(...root.payload.models);
  } else {
    for (const value of Object.values(root)) {
      const entry = (value ?? {}) as Record<string, any>;
      if (entry && typeof entry === "object" && Array.isArray(entry.payload?.models)) {
        collected.push(...entry.payload.models);
      } else if (entry && typeof entry === "object" && Array.isArray(entry.models)) {
        collected.push(...entry.models);
      }
    }
  }
  const byId = new Map<string, VibeModelSpec>();
  for (const entry of collected) {
    const spec = parseOneCatalogEntry(entry);
    if (spec && !byId.has(spec.id)) byId.set(spec.id, spec);
  }
  return [...byId.values()];
}

function thinkingLevelsFromConfigOptions(configOptions: unknown): VibeEffort[] {
  if (!Array.isArray(configOptions)) return [];
  const thinking = (configOptions as any[]).find((option) => option?.id === "thinking");
  if (!thinking || !Array.isArray(thinking.options)) return [];
  return normalizeEffortLevels(thinking.options.map((option: any) => option?.value));
}

function modelOptionsFromConfigOptions(configOptions: unknown): { id: string; name?: string }[] {
  if (!Array.isArray(configOptions)) return [];
  const model = (configOptions as any[]).find((option) => option?.id === "model");
  if (!model || !Array.isArray(model.options)) return [];
  return model.options
    .filter((option: any) => typeof option?.value === "string" && option.value.length > 0)
    .map((option: any) => ({
      id: option.value as string,
      name: typeof option.name === "string" && option.name.length > 0 ? (option.name as string) : undefined,
    }));
}

/**
 * Build specs from one `session/new` `configOptions` answer. Known specs keep
 * their windows, vision and cost; an unknown id gets the default window.
 */
export function modelsFromConfigOptions(configOptions: unknown, knownSpecs?: readonly VibeModelSpec[]): VibeModelSpec[] {
  const models = modelOptionsFromConfigOptions(configOptions);
  if (models.length === 0) return [];
  const thinkingLevels = thinkingLevelsFromConfigOptions(configOptions);
  const knownById = new Map<string, VibeModelSpec>();
  for (const spec of knownSpecs ?? []) knownById.set(spec.id, spec);
  for (const spec of FALLBACK_MODELS) {
    if (!knownById.has(spec.id)) knownById.set(spec.id, spec);
  }
  return models.map((model) => {
    const known = knownById.get(model.id);
    if (known) {
      return {
        ...known,
        id: model.id,
        name: model.name ?? known.name,
      };
    }
    return specFromRaw(model.id, model.name ?? model.id, 262_144, null, 262_144, false, thinkingLevels);
  });
}

/** The catalog Pi has registered in this process. Starts as the fallback. */
let catalog: readonly VibeModelSpec[] = FALLBACK_MODELS;

export function setVibeCatalog(models: readonly VibeModelSpec[]): void {
  catalog = models.length > 0 ? models : FALLBACK_MODELS;
}

export function vibeCatalog(): readonly VibeModelSpec[] {
  return catalog;
}

export function modelSpecFor(modelId: string): VibeModelSpec | undefined {
  return catalog.find((spec) => spec.id === modelId);
}

/** Do not send image blocks on the wire when this model cannot carry them. */
export function assertImageSupport(modelId: string, blocks: readonly { type?: unknown }[]): void {
  if (modelSpecFor(modelId)?.supportsImages === false && blocks.some((block) => block?.type === "image")) {
    throw new Error(`pi-mistral-vibe-tether refused to send image input to ${modelId}: this model is text-only and vibe would drop or reject images.`);
  }
}

/**
 * Pi thinking level to this model's offered effort. `undefined` asks for no
 * level; any other value must be offered or it is a refusal, never a clamp.
 */
export function effortFor(spec: VibeModelSpec, thinkingLevel: string | undefined): VibeEffort | undefined {
  if (thinkingLevel === undefined) return undefined;
  if ((spec.effortLevels as readonly string[]).includes(thinkingLevel)) {
    return thinkingLevel as VibeEffort;
  }
  if (spec.effortLevels.length === 0) {
    throw new Error(`${spec.id} does not offer adjustable thinking levels (fixed by vibe); omit thinking or use off.`);
  }
  throw new Error(
    `${spec.id} does not offer thinking level ${thinkingLevel}; ${spec.id} offers ${spec.effortLevels.join(", ")}. Choose one of those; the tether does not clamp.`,
  );
}

/** Pi's per-model level map: only levels this model actually offers. */
export function thinkingLevelMap(spec: VibeModelSpec): Record<string, string | null> {
  const map: Record<string, string | null> = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  for (const level of spec.effortLevels) map[level] = level;
  return map;
}

/**
 * Rows for provider registration: first-party list rates are notional
 * API-equivalent spend, not subscription charges. Unlisted models stay at zero.
 */
export function vibeModels(options: { images?: boolean } = {}, specs: readonly VibeModelSpec[] = catalog): any[] {
  return specs.map((spec) => ({
    id: spec.id,
    name: spec.name,
    reasoning: spec.effortLevels.length > 0,
    input: options.images === true && spec.supportsImages ? ["text", "image"] : ["text"],
    cost: spec.costKnown ? spec.cost : ZERO_COST,
    costKnown: spec.costKnown,
    costBasis: modelCostStatus(spec),
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    thinkingLevelMap: thinkingLevelMap(spec),
  }));
}
