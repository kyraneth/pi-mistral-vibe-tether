import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import {
  FALLBACK_MODELS,
  MISTRAL_LIST_COSTS,
  PI_COMPACTION_HEADROOM_TOKENS,
  VIBE_EFFORTS,
  computeVibeCompactionThreshold,
  effortFor,
  modelSpecFor,
  modelsFromConfigOptions,
  parseVibeCatalogCache,
  piAheadContextWindow,
  setVibeCatalog,
  thinkingLevelMap,
  vibeCatalog,
  vibeModels,
  assertImageSupport,
  modelCostStatus,
  isModelCostKnown,
  type VibeModelSpec,
} from "../src/catalog.js";
import {
  adoptCatalogModels,
  cachedOrFallbackCatalog,
  probeStartup,
  readCachedCatalog,
  readCachedCatalogWithAuthority,
  readHostVibeCatalog,
  rememberOfferedModels,
  startupCatalog,
  writeCachedCatalog,
} from "../src/model-discovery.js";
import { catalogCachePath, hostCatalogCachePath } from "../src/data-dir.js";
import { runtimeDir } from "../src/runtime-dir.js";
import { killAllProcesses } from "../src/process-manager.js";

afterEach(() => {
  setVibeCatalog(FALLBACK_MODELS);
});

describe("compaction windowing", () => {
  it("computes the Pi-ahead window for a 1M model with an explicit 400k threshold", () => {
    expect(computeVibeCompactionThreshold(1_048_576, 400_000)).toBe(400_000);
    expect(piAheadContextWindow(1_048_576, 400_000)).toBe(384_000);
  });

  it("derives the threshold for a 262144 model with no explicit value", () => {
    expect(computeVibeCompactionThreshold(262_144)).toBe(202_144);
    expect(computeVibeCompactionThreshold(262_144, null)).toBe(202_144);
    expect(piAheadContextWindow(262_144, 202_144)).toBe(186_144);
  });

  it("clamps an out-of-bounds explicit threshold into the product range", () => {
    const clampedLow = computeVibeCompactionThreshold(1_048_576, 10);
    expect(clampedLow).toBeGreaterThanOrEqual(10_000);
    expect(clampedLow).toBeLessThan(400_000);
    const clampedHigh = computeVibeCompactionThreshold(262_144, 10_000_000);
    expect(clampedHigh).toBeLessThan(262_144);
    expect(clampedHigh).toBeGreaterThan(200_000);
  });

  it("keeps the headroom constant honest", () => {
    expect(PI_COMPACTION_HEADROOM_TOKENS).toBe(16_000);
    expect(VIBE_EFFORTS).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });
});

function vibeCacheEntry(models: unknown[]): Record<string, unknown> {
  return {
    hash1: {
      stored_at_timestamp: 1_700_000_000,
      payload: { models },
    },
  };
}

describe("parseVibeCatalogCache", () => {
  it("parses window, vision, reasoning and list rates into a spec", () => {
    const specs = parseVibeCatalogCache(
      vibeCacheEntry([
        {
          id: "mistral-large-4-0",
          label: "Mistral Large 4.0",
          max_context_length: 1_048_576,
          parameters: { reasoning: ["none", "low", "medium", "high"], auto_compact_threshold: 400_000 },
          capabilities: { vision: true },
          requires: null,
        },
      ]),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: "mistral-large-4-0",
      name: "Mistral Large 4.0",
      rawContextWindow: 1_048_576,
      vibeAutoCompactThreshold: 400_000,
      contextWindow: 384_000,
      maxTokens: 262_144,
      supportsImages: true,
      effortLevels: ["off", "low", "medium", "high"],
    });
    expect(specs[0]?.cost).toEqual(MISTRAL_LIST_COSTS["mistral-large-4-0"]);
  });

  it("skips entries with a non-null requirement", () => {
    const specs = parseVibeCatalogCache(
      vibeCacheEntry([
        { id: "mistral-large-4-0", max_context_length: 1_048_576, parameters: {}, capabilities: {}, requires: { plan: "pro" } },
        { id: "mistral-medium-latest", max_context_length: 262_144, parameters: {}, capabilities: {}, requires: null },
      ]),
    );
    expect(specs.map((spec) => spec.id)).toEqual(["mistral-medium-latest"]);
  });

  it("normalizes a single reasoning value and a derived threshold", () => {
    const specs = parseVibeCatalogCache(
      vibeCacheEntry([
        {
          id: "mistral-medium-latest",
          label: "Mistral Medium Latest",
          max_context_length: 262_144,
          parameters: { reasoning: "none", auto_compact_threshold: null },
          capabilities: { vision: true },
          requires: null,
        },
      ]),
    );
    expect(specs[0]?.effortLevels).toEqual(["off"]);
    expect(specs[0]?.vibeAutoCompactThreshold).toBe(202_144);
    expect(specs[0]?.contextWindow).toBe(186_144);
  });

  it("marks text-only models as vision-free and leaves unlisted rates at zero", () => {
    const specs = parseVibeCatalogCache(
      vibeCacheEntry([
        {
          id: "zai-glm-5-3",
          max_context_length: 262_144,
          parameters: { reasoning: ["high"], auto_compact_threshold: null },
          capabilities: { vision: false },
          requires: null,
        },
        {
          id: "future-model-9",
          max_context_length: 262_144,
          parameters: { reasoning: ["low"], auto_compact_threshold: null },
          capabilities: { vision: true },
          requires: null,
        },
      ]),
    );
    expect(specs.find((spec) => spec.id === "zai-glm-5-3")?.supportsImages).toBe(false);
    expect(specs.find((spec) => spec.id === "zai-glm-5-3")?.cost.input).toBeGreaterThan(0);
    expect(specs.find((spec) => spec.id === "future-model-9")?.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("returns nothing for an unexpected shape", () => {
    expect(parseVibeCatalogCache(null)).toEqual([]);
    expect(parseVibeCatalogCache("nope")).toEqual([]);
    expect(parseVibeCatalogCache({})).toEqual([]);
  });
});

describe("effort selection", () => {
  it("maps a supported level through unchanged", () => {
    const spec = FALLBACK_MODELS.find((model) => model.id === "mistral-large-4-0")!;
    expect(effortFor(spec, "high")).toBe("high");
    expect(effortFor(spec, "low")).toBe("low");
    const medium = FALLBACK_MODELS.find((model) => model.id === "mistral-medium-latest")!;
    expect(effortFor(medium, "off")).toBe("off");
    expect(effortFor(medium, "high")).toBe("high");
  });

  it("returns undefined only when Pi asked for no level", () => {
    const spec = FALLBACK_MODELS.find((model) => model.id === "mistral-large-4-0")!;
    expect(effortFor(spec, undefined)).toBeUndefined();
  });

  it("refuses an unsupported level loudly and never clamps", () => {
    const spec = FALLBACK_MODELS.find((model) => model.id === "mistral-large-4-0")!;
    expect(() => effortFor(spec, "xhigh")).toThrow(/xhigh/);
    expect(() => effortFor(spec, "xhigh")).toThrow(/low.*medium.*high/);
    expect(() => effortFor(spec, "max")).toThrow(/does not offer thinking level max/);
    // The refusal names the offered levels and forbids a silent downgrade.
    try {
      effortFor(spec, "xhigh");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toContain("low");
      expect((error as Error).message).toMatch(/clamp/i);
    }
  });

  it("builds a thinking map that advertises only offered levels", () => {
    const spec = FALLBACK_MODELS.find((model) => model.id === "mistral-large-4-0")!;
    const map = thinkingLevelMap(spec);
    expect(map.low).toBe("low");
    expect(map.medium).toBe("medium");
    expect(map.high).toBe("high");
    expect(map.off).toBeNull();
    expect(map.xhigh).toBeNull();
    expect(map.max).toBeNull();
    const medium = FALLBACK_MODELS.find((model) => model.id === "mistral-medium-latest")!;
    const mediumMap = thinkingLevelMap(medium);
    expect(mediumMap.off).toBe("off");
    expect(mediumMap.low).toBeNull();
  });
});

describe("image support and catalog rows", () => {
  it("refuses image input for a text-only model", () => {
    const textOnly: VibeModelSpec = {
      id: "zai-glm-5-3",
      name: "zai-glm-5-3",
      rawContextWindow: 262_144,
      vibeAutoCompactThreshold: 202_144,
      contextWindow: 186_144,
      maxTokens: 262_144,
      supportsImages: false,
      effortLevels: ["high"],
      cost: MISTRAL_LIST_COSTS["zai-glm-5-3"] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costKnown: true,
    };
    setVibeCatalog([textOnly]);
    expect(modelSpecFor("zai-glm-5-3")).toEqual(textOnly);
    expect(() => assertImageSupport("zai-glm-5-3", [{ type: "image" } as never])).toThrow(/zai-glm-5-3/);
    expect(() => assertImageSupport("zai-glm-5-3", [{ type: "text" } as never])).not.toThrow();
  });

  it("does not refuse a vision model or an unknown model id", () => {
    const vision = FALLBACK_MODELS.find((model) => model.id === "mistral-large-4-0")!;
    setVibeCatalog(FALLBACK_MODELS);
    expect(() => assertImageSupport(vision.id, [{ type: "image" } as never])).not.toThrow();
    expect(() => assertImageSupport("unknown-model", [{ type: "image" } as never])).not.toThrow();
  });

  it("registers rows that carry the Pi-ahead window, vision input and list rates", () => {
    const rows = vibeModels({ images: true });
    const large = rows.find((row: any) => row.id === "mistral-large-4-0");
    expect(large).toMatchObject({
      contextWindow: 384_000,
      maxTokens: 262_144,
      input: ["text", "image"],
    });
    expect(large?.cost.input).toBe(0.7);
    const textRows = vibeModels();
    for (const row of textRows) expect(row.input).toEqual(["text"]);
    const medium = rows.find((row: any) => row.id === "mistral-medium-latest");
    expect(medium).toMatchObject({ contextWindow: 186_144, maxTokens: 262_144 });
  });

  it("starts from the two built-in models", () => {
    expect(vibeCatalog().map((spec) => spec.id)).toEqual(["mistral-large-4-0", "mistral-medium-latest"]);
    expect(modelSpecFor("mistral-large-4-0")?.contextWindow).toBe(384_000);
    expect(modelSpecFor("mistral-medium-latest")?.contextWindow).toBe(186_144);
  });
});

describe("costKnown reporting", () => {
  it("marks a known catalog model as api-equivalent", () => {
    const specs = parseVibeCatalogCache(
      vibeCacheEntry([
        {
          id: "mistral-large-4-0",
          label: "Mistral Large 4.0",
          max_context_length: 1_048_576,
          parameters: { reasoning: ["low", "medium", "high"], auto_compact_threshold: 400_000 },
          capabilities: { vision: true },
          requires: null,
        },
      ]),
    );
    expect(specs[0]?.costKnown).toBe(true);
    expect(modelCostStatus(specs[0]!)).toBe("api-equivalent");
    expect(modelCostStatus("mistral-large-4-0")).toBe("api-equivalent");
    expect(isModelCostKnown("mistral-large-4-0")).toBe(true);
  });

  it("marks an unlisted model as unknown with zero-cost placeholders", () => {
    const specs = parseVibeCatalogCache(
      vibeCacheEntry([
        {
          id: "future-model-9",
          max_context_length: 262_144,
          parameters: { reasoning: ["low"], auto_compact_threshold: null },
          capabilities: { vision: true },
          requires: null,
        },
      ]),
    );
    expect(specs[0]?.costKnown).toBe(false);
    expect(modelCostStatus(specs[0]!)).toBe("unknown");
    expect(modelCostStatus("future-model-9")).toBe("unknown");
    expect(isModelCostKnown("future-model-9")).toBe(false);
    const rows = vibeModels({}, specs);
    expect(rows[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const fromConfig = modelsFromConfigOptions([
      { id: "model", options: [{ value: "brand-new-model", name: "Brand New Model" }] },
      { id: "thinking", options: [{ value: "low" }] },
    ]);
    expect(fromConfig[0]?.costKnown).toBe(false);
    expect(modelCostStatus(fromConfig[0]!)).toBe("unknown");
    const configRows = vibeModels({}, fromConfig);
    expect(configRows[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("vibeModels exposes costKnown and costBasis on every registered row", () => {
    const listed = vibeModels({}, FALLBACK_MODELS);
    for (const row of listed) {
      expect(row.costKnown).toBe(true);
      expect(row.costBasis).toBe("api-equivalent");
    }
    const unlisted = vibeModels({}, modelsFromConfigOptions([
      { id: "model", options: [{ value: "brand-new-model", name: "Brand New Model" }] },
      { id: "thinking", options: [{ value: "low" }] },
    ]));
    expect(unlisted[0]?.costKnown).toBe(false);
    expect(unlisted[0]?.costBasis).toBe("unknown");
    expect(unlisted[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("modelsFromConfigOptions", () => {
  it("builds specs for offered models, preserving known windows, vision and cost", () => {
    const specs = modelsFromConfigOptions([
      {
        id: "model",
        options: [
          { value: "mistral-large-4-0", name: "Mistral Large 4.0" },
          { value: "mistral-medium-latest", name: "Mistral Medium Latest" },
        ],
      },
      { id: "thinking", options: [{ value: "off" }, { value: "high" }] },
    ]);
    expect(specs.map((spec) => spec.id)).toEqual(["mistral-large-4-0", "mistral-medium-latest"]);
    const large = specs.find((spec) => spec.id === "mistral-large-4-0")!;
    expect(large.contextWindow).toBe(384_000);
    expect(large.supportsImages).toBe(true);
    expect(large.cost.input).toBe(0.7);
  });

  it("gives an unknown model the default window and the thinking levels", () => {
    const specs = modelsFromConfigOptions([
      { id: "model", options: [{ value: "brand-new-model", name: "Brand New Model" }] },
      { id: "thinking", options: [{ value: "low" }, { value: "high" }] },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: "brand-new-model",
      rawContextWindow: 262_144,
      vibeAutoCompactThreshold: 202_144,
      contextWindow: 186_144,
      maxTokens: 262_144,
      effortLevels: ["low", "high"],
    });
  });

  it("returns nothing when there is no model option", () => {
    expect(modelsFromConfigOptions(undefined)).toEqual([]);
    expect(modelsFromConfigOptions([])).toEqual([]);
  });
});

describe("model-discovery cache", () => {
  it("round-trips the discovered catalog through the tether cache", () => {
    const specs = [...FALLBACK_MODELS];
    writeCachedCatalog(specs);
    expect(readCachedCatalog()).toEqual(specs);
    const raw = JSON.parse(readFileSync(catalogCachePath(), "utf8"));
    expect(raw.models).toHaveLength(2);
  });

  it("preserves costKnown through the cache round-trip", () => {
    const known = parseVibeCatalogCache(
      vibeCacheEntry([
        {
          id: "mistral-large-4-0",
          label: "Mistral Large 4.0",
          max_context_length: 1_048_576,
          parameters: { reasoning: ["low", "medium", "high"], auto_compact_threshold: 400_000 },
          capabilities: { vision: true },
          requires: null,
        },
        {
          id: "future-model-9",
          max_context_length: 262_144,
          parameters: { reasoning: ["low"], auto_compact_threshold: null },
          capabilities: { vision: true },
          requires: null,
        },
      ]),
    );
    writeCachedCatalog(known);
    const raw = JSON.parse(readFileSync(catalogCachePath(), "utf8"));
    expect(raw.models.find((m: any) => m.id === "mistral-large-4-0").costKnown).toBe(true);
    expect(raw.models.find((m: any) => m.id === "future-model-9").costKnown).toBe(false);
    const roundTripped = readCachedCatalog();
    expect(roundTripped?.find((m) => m.id === "mistral-large-4-0")?.costKnown).toBe(true);
    expect(roundTripped?.find((m) => m.id === "future-model-9")?.costKnown).toBe(false);
    expect(modelCostStatus(roundTripped!.find((m) => m.id === "future-model-9")!)).toBe("unknown");
  });

  it("cachedOrFallbackCatalog returns cache, then host, then fallback synchronously", () => {
    // No cache/host present in this fresh env: falls back to built-ins.
    const fallback = cachedOrFallbackCatalog();
    expect(fallback.source).toBe("fallback");
    expect(fallback.models.map((m) => m.id)).toEqual(["mistral-large-4-0", "mistral-medium-latest"]);
    // Host cache supplies models when the private cache is empty.
    const hostPath = hostCatalogCachePath();
    mkdirSync(dirname(hostPath), { recursive: true });
    writeFileSync(hostPath, JSON.stringify(vibeCacheEntry([
      {
        id: "mistral-large-4-0",
        label: "Mistral Large 4.0",
        max_context_length: 1_048_576,
        parameters: { reasoning: ["low", "medium", "high"], auto_compact_threshold: 400_000 },
        capabilities: { vision: true },
        requires: null,
      },
    ])));
    const host = cachedOrFallbackCatalog();
    expect(host.source).toBe("host");
    expect(host.models.map((m) => m.id)).toEqual(["mistral-large-4-0"]);
    // Private cache wins over the host cache.
    writeCachedCatalog(FALLBACK_MODELS);
    const cached = cachedOrFallbackCatalog();
    expect(cached.source).toBe("cache");
    expect(cached.models.map((m) => m.id)).toEqual(["mistral-large-4-0", "mistral-medium-latest"]);
  });

  it("contributes nothing from a missing or corrupt cache", () => {
    expect(readCachedCatalog()).toBeUndefined();
    const path = catalogCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");
    expect(readCachedCatalog()).toBeUndefined();
  });

  it("reads the official host catalog cache without touching credentials", () => {
    const hostPath = hostCatalogCachePath();
    mkdirSync(dirname(hostPath), { recursive: true });
    writeFileSync(hostPath, JSON.stringify(vibeCacheEntry([
      {
        id: "mistral-large-4-0",
        label: "Mistral Large 4.0",
        max_context_length: 1_048_576,
        parameters: { reasoning: ["low", "medium", "high"], auto_compact_threshold: 400_000 },
        capabilities: { vision: true },
        requires: null,
      },
    ])));
    const host = readHostVibeCatalog();
    expect(host?.map((spec) => spec.id)).toEqual(["mistral-large-4-0"]);
    expect(host?.[0]?.contextWindow).toBe(384_000);
  });

  it("preserves a richer catalog when a cold session offers only built-ins", () => {
    const rich = parseVibeCatalogCache(
      vibeCacheEntry([
        { id: "deepseek-v4-1-flash-1017", label: "DeepSeek V4.1 Flash", max_context_length: 262_144, parameters: { reasoning: ["low"], auto_compact_threshold: null }, capabilities: { vision: false }, requires: null },
        { id: "mistral-large-4-0", label: "Mistral Large 4.0", max_context_length: 1_048_576, parameters: { reasoning: ["low", "medium", "high"], auto_compact_threshold: 400_000 }, capabilities: { vision: true }, requires: null },
        { id: "mistral-medium-latest", label: "Mistral Medium Latest", max_context_length: 262_144, parameters: { reasoning: ["off", "high"], auto_compact_threshold: null }, capabilities: { vision: true }, requires: null },
        { id: "mistral-medium-3.5", label: "Mistral Medium 3.5", max_context_length: 262_144, parameters: { reasoning: ["low"], auto_compact_threshold: null }, capabilities: { vision: false }, requires: null },
        { id: "zai-glm-5-3", label: "GLM 5.3", max_context_length: 262_144, parameters: { reasoning: ["low"], auto_compact_threshold: null }, capabilities: { vision: false }, requires: null },
        { id: "zai-glm-5-3-flash", label: "GLM 5.3 Flash", max_context_length: 262_144, parameters: { reasoning: ["low"], auto_compact_threshold: null }, capabilities: { vision: false }, requires: null },
      ]),
    );
    expect(rich).toHaveLength(6);
    setVibeCatalog(rich);
    expect(vibeCatalog()).toHaveLength(6);
    const remembered = rememberOfferedModels([
      {
        id: "model",
        options: [
          { value: "mistral-large-4-0", name: "Mistral Large 4.0" },
          { value: "mistral-medium-latest", name: "Mistral Medium Latest" },
        ],
      },
      { id: "thinking", options: [{ value: "low" }, { value: "high" }] },
    ]);
    expect(remembered.map((spec) => spec.id)).toContain("deepseek-v4-1-flash-1017");
    expect(vibeCatalog().map((spec) => spec.id)).toContain("deepseek-v4-1-flash-1017");
    expect(modelSpecFor("deepseek-v4-1-flash-1017")).toBeDefined();
    expect(vibeCatalog()).toHaveLength(6);
  });

  it("retains unlisted models on an equal-sized partial replacement", () => {
    const spec = (id: string): VibeModelSpec => ({
      id,
      name: id,
      rawContextWindow: 262_144,
      vibeAutoCompactThreshold: 202_144,
      contextWindow: 186_144,
      maxTokens: 262_144,
      supportsImages: false,
      effortLevels: ["low"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costKnown: false,
    });
    setVibeCatalog([spec("model-a"), spec("model-b")]);
    const remembered = rememberOfferedModels(
      [
        {
          id: "model",
          options: [
            { value: "model-a", name: "model-a" },
            { value: "model-c", name: "model-c" },
          ],
        },
        { id: "thinking", options: [{ value: "low" }] },
      ],
      { authority: "partial" },
    );
    expect(remembered.map((entry) => entry.id)).toEqual(["model-a", "model-c", "model-b"]);
    expect(vibeCatalog().map((entry) => entry.id)).toEqual(["model-a", "model-c", "model-b"]);
  });

  it("evicts stale models on a smaller authoritative catalog", () => {
    const spec = (id: string): VibeModelSpec => ({
      id,
      name: id,
      rawContextWindow: 262_144,
      vibeAutoCompactThreshold: 202_144,
      contextWindow: 186_144,
      maxTokens: 262_144,
      supportsImages: false,
      effortLevels: ["low"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costKnown: false,
    });
    setVibeCatalog([spec("model-a"), spec("model-b"), spec("model-c")]);
    const remembered = rememberOfferedModels(
      [
        {
          id: "model",
          options: [
            { value: "model-a", name: "model-a" },
            { value: "model-b", name: "model-b" },
          ],
        },
        { id: "thinking", options: [{ value: "low" }] },
      ],
      { authority: "authoritative" },
    );
    expect(remembered.map((entry) => entry.id)).toEqual(["model-a", "model-b"]);
    expect(vibeCatalog().map((entry) => entry.id)).toEqual(["model-a", "model-b"]);
  });

  it("adopts offered models into the live catalog and cache", () => {
    const offered = rememberOfferedModels([
      { id: "model", options: [{ value: "mistral-large-4-0", name: "Mistral Large 4.0" }] },
      { id: "thinking", options: [{ value: "low" }, { value: "high" }] },
    ]);
    expect(offered.map((spec) => spec.id)).toEqual(["mistral-large-4-0", "mistral-medium-latest"]);
    expect(modelSpecFor("mistral-large-4-0")).toBeDefined();
    expect(readCachedCatalog()?.map((spec) => spec.id)).toEqual(["mistral-large-4-0", "mistral-medium-latest"]);
  });
});

describe("model-discovery probe", () => {
  const tempDirs: string[] = [];

  function fakeAcpBin(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "t-fake-acp-"));
    tempDirs.push(dir);
    const bin = join(dir, "vibe-acp");
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    process.env.PI_MISTRAL_VIBE_TETHER_CLI = bin;
    return bin;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    delete process.env.PI_MISTRAL_VIBE_TETHER_CLI;
  });

  it("discovers the catalog over a fake ACP handshake", async () => {
    const hostHome = process.env.PI_MISTRAL_VIBE_TETHER_SOURCE_VIBE_HOME!;
    writeFileSync(join(hostHome, ".env"), "VIBE_TOKEN=placeholder\n");
    fakeAcpBin(`#!/usr/bin/env node
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method || msg.id === undefined) return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: { promptCapabilities: { image: true } }, protocolVersion: 1 } }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [
      { id: "model", options: [{ value: "mistral-large-4-0", name: "Mistral Large 4.0" }] },
      { id: "thinking", options: [{ value: "low" }, { value: "high" }] },
    ] } }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } }) + "\\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
`);
    const probed = await probeStartup(true);
    expect(probed.image).toBe(true);
    expect(probed.models.map((spec: VibeModelSpec) => spec.id)).toEqual(["mistral-large-4-0"]);
    expect(probed.models[0]?.contextWindow).toBe(384_000);
  });

  it("does not hang on a silent child when the signal aborts and removes its probe home", async () => {
    const hostHome = process.env.PI_MISTRAL_VIBE_TETHER_SOURCE_VIBE_HOME!;
    writeFileSync(join(hostHome, ".env"), "VIBE_TOKEN=placeholder\n");
    const pidDir = mkdtempSync(join(tmpdir(), "t-pid-"));
    tempDirs.push(pidDir);
    const pidFile = join(pidDir, "pid.txt");
    fakeAcpBin(`#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    let settled = false;
    let result: unknown;
    const probing = probeStartup(true, { signal: controller.signal }).then((value) => {
      settled = true;
      result = value;
    });
    // Let the child spawn and the initialize request go out, then abort.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      // A live silent child must not hang the probe.
      expect(settled).toBe(true);
      await probing;
      expect(result).toEqual(expect.objectContaining({ models: [] }));
      // The probe home must be gone.
      const runtimeEntries = existsSync(runtimeDir()) ? readdirSync(runtimeDir()) : [];
      expect(runtimeEntries.filter((entry) => entry.startsWith("probe"))).toEqual([]);
      // The child must have been observed exiting, not left running.
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isFinite(pid) && pid > 0) {
          expect(() => process.kill(pid, 0)).toThrow();
        }
      }
    } finally {
      await killAllProcesses();
    }
  });

  it("uses the cache without probing and falls back to the built-ins", async () => {
    writeCachedCatalog(FALLBACK_MODELS);
    process.env.PI_MISTRAL_VIBE_TETHER_CLI = "/nonexistent/vibe-acp";
    const cached = await startupCatalog();
    expect(cached.models.map((spec) => spec.id)).toEqual(["mistral-large-4-0", "mistral-medium-latest"]);
  });

  it("startupCatalog over a cold session/new probe writes partial authority and preserves known models", async () => {
    const hostHome = process.env.PI_MISTRAL_VIBE_TETHER_SOURCE_VIBE_HOME!;
    writeFileSync(join(hostHome, ".env"), "VIBE_TOKEN=placeholder\n");
    fakeAcpBin(`#!/usr/bin/env node
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method || msg.id === undefined) return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: { promptCapabilities: { image: true } }, protocolVersion: 1 } }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [
      { id: "model", options: [{ value: "mistral-large-4-0", name: "Mistral Large 4.0" }, { value: "mistral-medium-latest", name: "Mistral Medium Latest" }] },
      { id: "thinking", options: [{ value: "low" }, { value: "high" }] },
    ] } }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } }) + "\\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
`);
    const deepseek: VibeModelSpec = {
      id: "deepseek-v4-1-flash-1017",
      name: "DeepSeek V4.1 Flash",
      rawContextWindow: 262_144,
      vibeAutoCompactThreshold: 202_144,
      contextWindow: 186_144,
      maxTokens: 262_144,
      supportsImages: false,
      effortLevels: ["low"],
      cost: MISTRAL_LIST_COSTS["deepseek-v4-1-flash-1017"] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costKnown: true,
    };
    setVibeCatalog([...FALLBACK_MODELS, deepseek]);
    expect(vibeCatalog().map((spec) => spec.id)).toContain("deepseek-v4-1-flash-1017");
    const result = await startupCatalog();
    expect(result.models.map((spec) => spec.id)).toContain("deepseek-v4-1-flash-1017");
    expect(vibeCatalog().map((spec) => spec.id)).toContain("deepseek-v4-1-flash-1017");
    const cached = readCachedCatalogWithAuthority();
    expect(cached?.authority).toBe("partial");
    expect(cached?.models.map((spec) => spec.id)).toContain("deepseek-v4-1-flash-1017");
  });

  it("adoptCatalogModels merges on partial/default and only evicts on explicit authoritative", () => {
    const spec = (id: string): VibeModelSpec => ({
      id,
      name: id,
      rawContextWindow: 262_144,
      vibeAutoCompactThreshold: 202_144,
      contextWindow: 186_144,
      maxTokens: 262_144,
      supportsImages: false,
      effortLevels: ["low"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costKnown: false,
    });
    const adopt = adoptCatalogModels;
    expect(typeof adopt).toBe("function");
    // Default authority is partial: offered specs update by id, unlisted stay.
    setVibeCatalog([spec("model-a"), spec("model-b")]);
    const merged = adopt!([spec("model-a"), spec("model-c")]);
    expect(merged.map((entry) => entry.id)).toEqual(["model-a", "model-c", "model-b"]);
    expect(vibeCatalog().map((entry) => entry.id)).toEqual(["model-a", "model-c", "model-b"]);
    expect(readCachedCatalogWithAuthority()?.authority).toBe("partial");
    expect(readCachedCatalogWithAuthority()?.models.map((entry) => entry.id)).toEqual([
      "model-a",
      "model-c",
      "model-b",
    ]);
    // Explicit partial behaves the same way.
    setVibeCatalog([spec("model-a"), spec("model-b")]);
    const mergedExplicit = adopt!([spec("model-a"), spec("model-c")], { authority: "partial" });
    expect(mergedExplicit.map((entry) => entry.id)).toEqual(["model-a", "model-c", "model-b"]);
    // Empty incoming never wipes or overwrites, even as authoritative.
    const still = adopt!([], { authority: "authoritative" });
    expect(still.map((entry) => entry.id)).toEqual(["model-a", "model-c", "model-b"]);
    expect(vibeCatalog().map((entry) => entry.id)).toEqual(["model-a", "model-c", "model-b"]);
    // Only explicit authoritative evicts unlisted models.
    setVibeCatalog([spec("model-a"), spec("model-b"), spec("model-c")]);
    const replaced = adopt!([spec("model-a"), spec("model-b")], { authority: "authoritative" });
    expect(replaced.map((entry) => entry.id)).toEqual(["model-a", "model-b"]);
    expect(vibeCatalog().map((entry) => entry.id)).toEqual(["model-a", "model-b"]);
    expect(readCachedCatalogWithAuthority()?.authority).toBe("authoritative");
    expect(readCachedCatalogWithAuthority()?.models.map((entry) => entry.id)).toEqual(["model-a", "model-b"]);
  });
});
