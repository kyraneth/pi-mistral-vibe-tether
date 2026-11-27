import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateContextTokens,
  getLastAssistantUsage,
  shouldCompact,
} from "@earendil-works/pi-coding-agent";
import {
  DISCLOSURE_ENTRY_TYPE,
  STRICT_ENV,
  VIBE_LARGE_OUTPUT_MAX_CHARS,
  autoCompactionDisclosure,
  builtinSchemasDisclosure,
  coldReplayDisclosure,
  emitDisclosure,
  findToolResultSpills,
  imageAttachmentLimitDisclosure,
  olderImagesDisclosure,
  promptBlockSeparationDisclosure,
  rememberDisclosure,
  rememberDisclosureForScope,
  resetDisclosuresForTests,
  slashCommandCollisionDisclosure,
  strictTransport,
  systemOverheadDisclosure,
  toolResultSpillDisclosure,
  unsupportedControlDisclosure,
  parkedProcessExitDisclosure,
  type DisclosureRecord,
} from "../src/degradations.js";
import * as degradationsModule from "../src/degradations.js";
const PERMANENT_ROUTE_FACTS: readonly string[] | undefined = (
  degradationsModule as any
).PERMANENT_ROUTE_FACTS;
import {
  PROVIDER_ID,
  createEventBridge,
  createSessionUsageWatermark,
  createUnavailableUsageReport,
  deltaUsage,
  isVibeCompactionUpdate,
  mapStopReason,
  type CumulativeUsageSnapshot,
} from "../src/event-bridge.js";

beforeEach(() => {
  resetDisclosuresForTests();
  delete process.env[STRICT_ENV];
});

afterEach(() => {
  delete process.env[STRICT_ENV];
  resetDisclosuresForTests();
});

describe("disclosure identity and strict transport", () => {
  it("uses the documented entry type, strict env name, and spill threshold", () => {
    expect(DISCLOSURE_ENTRY_TYPE).toBe("pi-mistral-vibe-tether:disclosure");
    expect(STRICT_ENV).toBe("PI_MISTRAL_VIBE_TETHER_STRICT");
    expect(VIBE_LARGE_OUTPUT_MAX_CHARS).toBe(16_000);
    expect(PROVIDER_ID).toBe("mistral-vibe");
  });

  it("reports strict mode only for the exact flag value", () => {
    expect(strictTransport()).toBe(false);
    process.env[STRICT_ENV] = "1";
    expect(strictTransport()).toBe(true);
    process.env[STRICT_ENV] = "true";
    expect(strictTransport()).toBe(false);
    delete process.env[STRICT_ENV];
    expect(strictTransport()).toBe(false);
  });
});

describe("once-per-session notices with every-occurrence ledger records", () => {
  it("returns true once per session and key, and again after reset", () => {
    expect(rememberDisclosure("sess-1", "vibe-cold-replay")).toBe(true);
    expect(rememberDisclosure("sess-1", "vibe-cold-replay")).toBe(false);
    expect(rememberDisclosure("sess-2", "vibe-cold-replay")).toBe(true);
    expect(rememberDisclosure("sess-1", "vibe-older-images")).toBe(true);
    resetDisclosuresForTests();
    expect(rememberDisclosure("sess-1", "vibe-cold-replay")).toBe(true);
  });

  it("notifies the user once while the ledger records every occurrence", () => {
    const notified: string[] = [];
    const ledger: DisclosureRecord[] = [];
    const disclosure = coldReplayDisclosure();
    emitDisclosure({
      sessionId: "sess-ledger",
      ...disclosure,
      detail: { channel: "test" },
      notify: (message) => notified.push(message),
      recordDisclosure: (entry) => ledger.push(entry),
    });
    emitDisclosure({
      sessionId: "sess-ledger",
      ...disclosure,
      detail: { channel: "test" },
      notify: (message) => notified.push(message),
      recordDisclosure: (entry) => ledger.push(entry),
    });
    expect(notified).toEqual([disclosure.message]);
    expect(ledger).toHaveLength(2);
    for (const entry of ledger) {
      expect(entry.key).toBe("vibe-cold-replay");
      expect(entry.message).toBe(disclosure.message);
      expect((entry as any).surface).toBe("screen");
      expect(entry.detail).toEqual({ channel: "test" });
      expect(typeof entry.timestamp).toBe("number");
    }
  });

  it("dedupes independently per session", () => {
    const notified: string[] = [];
    const disclosure = coldReplayDisclosure();
    emitDisclosure({
      sessionId: "sess-a",
      ...disclosure,
      notify: (message) => notified.push(message),
      recordDisclosure: () => {},
    });
    emitDisclosure({
      sessionId: "sess-b",
      ...disclosure,
      notify: (message) => notified.push(message),
      recordDisclosure: () => {},
    });
    expect(notified).toHaveLength(2);
  });

  it("notifies once per reporting scope when no session id scopes the dedupe", () => {
    const notified: string[] = [];
    const ledger: DisclosureRecord[] = [];
    const disclosure = olderImagesDisclosure();
    const notify = (message: string) => notified.push(message);
    const recordDisclosure = (entry: DisclosureRecord) => ledger.push(entry);
    emitDisclosure({
      ...disclosure,
      notify,
      recordDisclosure,
    });
    emitDisclosure({
      ...disclosure,
      notify,
      recordDisclosure,
    });
    expect(notified).toEqual([disclosure.message]);
    expect(ledger).toHaveLength(2);
  });

  it("anonymous scopes notify independently per callback pair and never pollute the session map", () => {
    const disclosure = olderImagesDisclosure();
    const notifiedA: string[] = [];
    const ledgerA: DisclosureRecord[] = [];
    const notifyA = (message: string) => notifiedA.push(message);
    const recordA = (entry: DisclosureRecord) => ledgerA.push(entry);
    emitDisclosure({ ...disclosure, notify: notifyA, recordDisclosure: recordA });
    emitDisclosure({ ...disclosure, notify: notifyA, recordDisclosure: recordA });
    expect(notifiedA).toEqual([disclosure.message]);
    expect(ledgerA).toHaveLength(2);
    // A distinct callback pair is a distinct scope and notifies independently.
    const notifiedB: string[] = [];
    const ledgerB: DisclosureRecord[] = [];
    const notifyB = (message: string) => notifiedB.push(message);
    const recordB = (entry: DisclosureRecord) => ledgerB.push(entry);
    emitDisclosure({ ...disclosure, notify: notifyB, recordDisclosure: recordB });
    emitDisclosure({ ...disclosure, notify: notifyB, recordDisclosure: recordB });
    expect(notifiedB).toEqual([disclosure.message]);
    expect(ledgerB).toHaveLength(2);
    // Anonymous dedupe never writes a fresh processKey into seenBySession:
    // a real session id with the same key is still seen for the first time.
    expect(rememberDisclosure("sess-real-after-anon", disclosure.key)).toBe(true);
    expect(rememberDisclosure("sess-real-after-anon", disclosure.key)).toBe(false);
    // Explicit reportingScope dedupes by scope identity.
    const scope = { name: "scope-1" };
    const notifiedS: string[] = [];
    emitDisclosure({ ...disclosure, reportingScope: scope, notify: (m) => notifiedS.push(m), recordDisclosure: () => {} });
    emitDisclosure({ ...disclosure, reportingScope: scope, notify: (m) => notifiedS.push(m), recordDisclosure: () => {} });
    expect(notifiedS).toEqual([disclosure.message]);
    expect(rememberDisclosureForScope(scope, disclosure.key)).toBe(false);
  });

  it("coldReplayDisclosure distinguishes omitted thinking", () => {
    expect(coldReplayDisclosure({ omittedThinking: false })).toEqual({
      key: "vibe-cold-replay",
      surface: "screen",
      message: "Mistral Vibe ACP has no native role-preserving history import; Pi replayed prior turns as structured context.",
    });
    expect(coldReplayDisclosure({ omittedThinking: true })).toEqual({
      key: "vibe-cold-replay:omitted-thinking",
      surface: "screen",
      message: "Mistral Vibe ACP has no native role-preserving history import; Pi replayed prior turns as structured context and omitted prior thinking blocks.",
    });
    expect(coldReplayDisclosure()).toEqual(coldReplayDisclosure({ omittedThinking: false }));
  });

  it("imageAttachmentLimitDisclosure cites the measured Vibe limit and the refusal", () => {
    expect(imageAttachmentLimitDisclosure(9, 8)).toEqual({
      key: "vibe-image-attachment-limit",
      surface: "screen",
      message: "Mistral Vibe 3.1.5 allows at most 8 images per prompt (vibe/utils/images.py MAX_IMAGES_PER_MESSAGE, vibe/acp/image_blocks.py:22-27); 9 images were attached with a limit of 8, so the tether refused this prompt rather than silently dropping attachments.",
    });
  });
});

describe("strict mode refuses each disclosure cause", () => {
  const cases: Array<[string, { key: string; message: string; surface?: "screen" | "log" }]> = [
    ["systemOverhead", systemOverheadDisclosure()],
    ["builtinSchemas", builtinSchemasDisclosure()],
    ["toolResultSpill", toolResultSpillDisclosure("read", 20_000)],
    ["autoCompaction", autoCompactionDisclosure()],
    ["unsupportedControl", unsupportedControlDisclosure("thinking")],
    ["coldReplay", coldReplayDisclosure()],
    ["promptBlockSeparation", promptBlockSeparationDisclosure()],
    ["olderImages", olderImagesDisclosure()],
    ["imageAttachmentLimit", imageAttachmentLimitDisclosure(9, 8)],
    ["slashCommandCollision", slashCommandCollisionDisclosure("/compact")],
  ];
  for (const [label, disclosure] of cases) {
    it(`refuses ${label} while strict`, () => {
      process.env[STRICT_ENV] = "1";
      const notified: string[] = [];
      expect(() =>
        emitDisclosure({
          sessionId: "sess-strict",
          ...disclosure,
          notify: (message) => notified.push(message),
          recordDisclosure: () => {},
        }),
      ).toThrow(disclosure.message);
      expect(notified).toEqual([]);
    });
  }

  it("prefers the explicit strict message when one is supplied", () => {
    process.env[STRICT_ENV] = "1";
    const disclosure = coldReplayDisclosure();
    expect(() =>
      emitDisclosure({
        sessionId: "sess-strict",
        ...disclosure,
        strictMessage: "strict refusal for this cause",
      }),
    ).toThrow("strict refusal for this cause");
  });

  it("still records the ledger entry before refusing", () => {
    process.env[STRICT_ENV] = "1";
    const ledger: DisclosureRecord[] = [];
    const disclosure = coldReplayDisclosure();
    expect(() =>
      emitDisclosure({
        sessionId: "sess-strict",
        ...disclosure,
        recordDisclosure: (entry) => ledger.push(entry),
      }),
    ).toThrow(disclosure.message);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.key).toBe(disclosure.key);
  });
});

describe("exact disclosure text", () => {
  it("matches the documented notices verbatim", () => {
    expect(systemOverheadDisclosure()).toEqual({
      key: "vibe-system-overhead",
      surface: "log",
      message:
        "Mistral Vibe adds its own harness capability guidance around Pi's system prompt; Pi owns the prompt base.",
    });
    expect(builtinSchemasDisclosure()).toEqual({
      key: "vibe-builtin-schemas",
      surface: "log",
      message:
        "Mistral Vibe exposes its local built-in programmatic tool wrappers (run_typescript / search_tool_functions) and residual tool declarations alongside authorized Pi tools on mcp_pi; the tether appends a programmatic MCP routing note after Pi's verbatim system prompt base in prompts/pi.md, and only Pi-declared tools are authorized to run.",
    });
    expect(toolResultSpillDisclosure("read", 20_000)).toEqual({
      key: "vibe-tool-result-spill",
      surface: "screen",
      message:
        "Tool result for read is 20000 characters (over Mistral Vibe's 16,000-character / ~4,000-token threshold), so Vibe may summarize or spill it to a file excerpt before the model sees it; Pi kept the full result.",
    });
    expect(autoCompactionDisclosure()).toEqual({
      key: "vibe-auto-compaction",
      surface: "screen",
      message:
        "Mistral Vibe ran automatic compaction on its session context (which may middle-cut recent text or replace older images); Pi kept the full transcript and will reimport it on the next turn.",
    });
    expect(unsupportedControlDisclosure("thinking")).toEqual({
      key: "vibe-unsupported-control:thinking",
      surface: "screen",
      message:
        "Mistral Vibe ACP does not honor Pi's explicit thinking override; proceeding with Vibe's default.",
    });
    expect(coldReplayDisclosure()).toEqual({
      key: "vibe-cold-replay",
      surface: "screen",
      message:
        "Mistral Vibe ACP has no native role-preserving history import; Pi replayed prior turns as structured context.",
    });
    expect(coldReplayDisclosure({ omittedThinking: true })).toEqual({
      key: "vibe-cold-replay:omitted-thinking",
      surface: "screen",
      message:
        "Mistral Vibe ACP has no native role-preserving history import; Pi replayed prior turns as structured context and omitted prior thinking blocks.",
    });
    expect(promptBlockSeparationDisclosure()).toEqual({
      key: "vibe-prompt-block-separation",
      surface: "screen",
      message:
        "Mistral Vibe ACP separates images from text blocks and joins text with blank lines; interleaved block order is not preserved verbatim.",
    });
    expect(olderImagesDisclosure()).toEqual({
      key: "vibe-older-images",
      surface: "screen",
      message:
        "Mistral Vibe replaces older images in multi-turn context with text placeholders; Pi kept the original attachments.",
    });
    expect(slashCommandCollisionDisclosure("/compact")).toEqual({
      key: "vibe-slash-command-collision",
      surface: "log",
      message:
        "Mistral Vibe ACP intercepts leading slash command /compact; wrapped prompt text so it reaches the model.",
    });
  });
});

describe("screen vs log disclosure surfaces", () => {
  const logCases: Array<[string, () => any]> = [
    ["systemOverhead", systemOverheadDisclosure],
    ["builtinSchemas", builtinSchemasDisclosure],
    ["slashCommandCollision", () => slashCommandCollisionDisclosure("/compact")],
  ];
  const screenCases: Array<[string, () => any]> = [
    ["toolResultSpill", () => toolResultSpillDisclosure("read", 20_000)],
    ["autoCompaction", autoCompactionDisclosure],
    ["coldReplay", coldReplayDisclosure],
    ["olderImages", olderImagesDisclosure],
    ["imageAttachmentLimit", () => imageAttachmentLimitDisclosure(9, 8)],
    ["promptBlockSeparation", promptBlockSeparationDisclosure],
    ["unsupportedControl", () => unsupportedControlDisclosure("temperature")],
    ["parkedProcessExit", () => parkedProcessExitDisclosure({ signal: "SIGKILL" })],
  ];

  it("classifies the 3 log-only and 8 screen disclosures", () => {
    for (const [, make] of logCases) expect(make().surface).toBe("log");
    for (const [, make] of screenCases) expect(make().surface).toBe("screen");
    expect(systemOverheadDisclosure().surface).toBe("log");
    expect(builtinSchemasDisclosure().surface).toBe("log");
    expect(promptBlockSeparationDisclosure().surface).toBe("screen");
    expect(unsupportedControlDisclosure("maxTokens").surface).toBe("screen");
    expect(parkedProcessExitDisclosure({ signal: "SIGKILL" }).surface).toBe("screen");
    expect(slashCommandCollisionDisclosure("/help").surface).toBe("log");
    expect(toolResultSpillDisclosure("read", 20_000).surface).toBe("screen");
    expect(autoCompactionDisclosure().surface).toBe("screen");
    expect(coldReplayDisclosure().surface).toBe("screen");
    expect(olderImagesDisclosure().surface).toBe("screen");
    expect(imageAttachmentLimitDisclosure(9, 8).surface).toBe("screen");
  });

  for (const [label, make] of logCases) {
    it(`log-only ${label}: ledger every time, zero notify/warn, no dedupe pollution, strict throws`, () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const notified: string[] = [];
        const ledger: any[] = [];
        const disclosure = make();
        emitDisclosure({ sessionId: "sess-log", ...disclosure, notify: (m: string) => notified.push(m), recordDisclosure: (e: any) => ledger.push(e) });
        emitDisclosure({ sessionId: "sess-log", ...disclosure, notify: (m: string) => notified.push(m), recordDisclosure: (e: any) => ledger.push(e) });
        expect(notified).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(ledger).toHaveLength(2);
        expect(ledger.every((e: any) => e.surface === "log" && e.key === disclosure.key)).toBe(true);
        // Log-only must not record in seenBySession.
        expect(rememberDisclosure("sess-log", disclosure.key)).toBe(true);
        expect(rememberDisclosure("sess-log", disclosure.key)).toBe(false);
        // Anonymous log-only: zero notify/warn even with notify omitted.
        const anonLedger: any[] = [];
        const anonNotify = (m: string) => notified.push(m);
        emitDisclosure({ ...disclosure, notify: anonNotify, recordDisclosure: (e: any) => anonLedger.push(e) });
        emitDisclosure({ ...make(), recordDisclosure: (e: any) => anonLedger.push(e) });
        expect(notified).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(anonLedger).toHaveLength(2);
        expect(anonLedger.every((e: any) => e.surface === "log")).toBe(true);
        // Anonymous scope must not be polluted either.
        expect(rememberDisclosureForScope(anonNotify, disclosure.key)).toBe(true);
        // Strict still throws (and still records first).
        process.env[STRICT_ENV] = "1";
        const strictLedger: any[] = [];
        expect(() => emitDisclosure({ sessionId: "sess-log-strict", ...disclosure, notify: (m: string) => notified.push(m), recordDisclosure: (e: any) => strictLedger.push(e) })).toThrow(disclosure.message);
        expect(strictLedger).toHaveLength(1);
        expect((strictLedger[0] as any).surface).toBe("log");
        expect(notified).toEqual([]);
        delete process.env[STRICT_ENV];
      } finally {
        warnSpy.mockRestore();
        delete process.env[STRICT_ENV];
      }
    });
  }

  for (const [label, make] of screenCases) {
    it(`screen ${label}: ledger every time, notify once per session, warn fallback, strict throws`, () => {
      const disclosure = make();
      const noDedupe = (disclosure as any).dedupe === false;
      const notified: string[] = [];
      const ledger: any[] = [];
      emitDisclosure({ sessionId: "sess-screen", ...disclosure, notify: (m: string) => notified.push(m), recordDisclosure: (e: any) => ledger.push(e) });
      emitDisclosure({ sessionId: "sess-screen", ...disclosure, notify: (m: string) => notified.push(m), recordDisclosure: (e: any) => ledger.push(e) });
      expect(notified).toEqual(noDedupe ? [disclosure.message, disclosure.message] : [disclosure.message]);
      expect(ledger).toHaveLength(2);
      expect(ledger.every((e: any) => e.surface === "screen" && e.key === disclosure.key)).toBe(true);
      // Fallback to console.warn when notify omitted, deduped (unless dedupe:false).
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const warnLedger: any[] = [];
        emitDisclosure({ sessionId: "sess-screen-warn", ...disclosure, recordDisclosure: (e: any) => warnLedger.push(e) });
        emitDisclosure({ sessionId: "sess-screen-warn", ...disclosure, recordDisclosure: (e: any) => warnLedger.push(e) });
        expect(warnSpy).toHaveBeenCalledTimes(noDedupe ? 2 : 1);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain(disclosure.message);
        expect(warnLedger).toHaveLength(2);
        expect(warnLedger.every((e: any) => e.surface === "screen")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
      process.env[STRICT_ENV] = "1";
      try {
        expect(() => emitDisclosure({ sessionId: "sess-screen-strict", ...disclosure, notify: (m: string) => notified.push(m), recordDisclosure: () => {} })).toThrow(disclosure.message);
      } finally {
        delete process.env[STRICT_ENV];
      }
    });
  }

  it("defaults emitDisclosure surface to screen when omitted", () => {
    const notified: string[] = [];
    const ledger: any[] = [];
    emitDisclosure({ sessionId: "sess-default", key: "vibe-cold-replay", message: "default surface message", notify: (m: string) => notified.push(m), recordDisclosure: (e: any) => ledger.push(e) });
    expect(notified).toEqual(["default surface message"]);
    expect(ledger[0]?.surface).toBe("screen");
  });

  it("exports PERMANENT_ROUTE_FACTS summarizing the 5 standing route facts (log-only disclosures: systemOverhead, builtinSchemas, slashCommandCollision)", () => {
    const facts = PERMANENT_ROUTE_FACTS;
    expect(Array.isArray(facts)).toBe(true);
    expect(facts).toHaveLength(5);
    const joined = (facts ?? []).join("\n");
    expect(joined).toContain("harness capability guidance");
    expect(joined).toContain("built-in programmatic");
    expect(joined).toContain("prompts/pi.md");
    expect(joined).toContain("separates images");
    expect(joined).toContain("temperature");
    expect(joined).toContain("maxTokens");
    expect(joined.toLowerCase()).toContain("slash");
  });
});

describe("parkedProcessExitDisclosure", () => {
  it("reports a signal kill", () => {
    expect(parkedProcessExitDisclosure({ signal: "SIGKILL" })).toEqual({
      key: "vibe-parked-process-exit",
      surface: "screen",
      dedupe: false,
      detail: { code: null, signal: "SIGKILL" },
      message: "Parked vibe-acp process was killed (signal SIGKILL); its Vibe session cannot be reused, so Pi's history is replayed into a fresh session.",
    });
  });
  it("reports a non-zero exit code", () => {
    expect(parkedProcessExitDisclosure({ code: 3 })).toEqual({
      key: "vibe-parked-process-exit",
      surface: "screen",
      dedupe: false,
      detail: { code: 3, signal: null },
      message: "Parked vibe-acp process exited unexpectedly with code 3; its Vibe session cannot be reused, so Pi's history is replayed into a fresh session.",
    });
  });
  it("reports an unknown exit with neither signal nor code", () => {
    expect(parkedProcessExitDisclosure({})).toEqual({
      key: "vibe-parked-process-exit",
      surface: "screen",
      dedupe: false,
      detail: { code: null, signal: null },
      message: "Parked vibe-acp process exited unexpectedly; its Vibe session cannot be reused, so Pi's history is replayed into a fresh session.",
    });
  });
  it("sanitizes stderr into detail.stderrDiagnostic", () => {
    const disclosure = parkedProcessExitDisclosure({ signal: "SIGKILL", stderr: " boom\u001b[31m\u0007 hello\u0000 world \n" });
    expect((disclosure as any).detail).toMatchObject({ code: null, signal: "SIGKILL" });
    expect((disclosure as any).detail.stderrDiagnostic).toContain("boom");
    expect((disclosure as any).detail.stderrDiagnostic).toContain("hello");
    expect((disclosure as any).detail.stderrDiagnostic).not.toMatch(/[\x00-\x1f\x7f]/);
    expect((disclosure as any).detail.stderrDiagnostic).not.toBe(" boom\u001b[31m\u0007 hello\u0000 world \n");
  });
  it("dedupes false so repeated unexpected parked exits notify every time", () => {
    const disclosure = parkedProcessExitDisclosure({ signal: "SIGKILL" });
    const notified: string[] = [];
    const ledger: any[] = [];
    emitDisclosure({ sessionId: "sess-parked", ...disclosure, notify: (m: string) => notified.push(m), recordDisclosure: (e: any) => ledger.push(e) });
    emitDisclosure({ sessionId: "sess-parked", ...disclosure, notify: (m: string) => notified.push(m), recordDisclosure: (e: any) => ledger.push(e) });
    expect(notified).toEqual([disclosure.message, disclosure.message]);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((e: any) => e.key === "vibe-parked-process-exit" && e.surface === "screen")).toBe(true);
  });
  it("throws in strict mode while still recording ledger", () => {
    process.env[STRICT_ENV] = "1";
    const disclosure = parkedProcessExitDisclosure({ signal: "SIGKILL" });
    const ledger: any[] = [];
    const notified: string[] = [];
    expect(() => emitDisclosure({ sessionId: "sess-parked-strict", ...disclosure, notify: (m: string) => notified.push(m), recordDisclosure: (e: any) => ledger.push(e) })).toThrow(disclosure.message);
    expect(ledger).toHaveLength(1);
    expect((ledger[0] as any).surface).toBe("screen");
    expect(notified).toEqual([]);
  });
});

describe("tool result spill detection", () => {
  function textResult(chars: number, blocks = 1) {
    const each = Math.ceil(chars / blocks);
    return {
      content: Array.from({ length: blocks }, () => ({
        type: "text" as const,
        text: "x".repeat(each),
      })),
    };
  }

  it("reports nothing at exactly the threshold", () => {
    expect(findToolResultSpills("read", textResult(16_000))).toEqual([]);
  });

  it("reports one entry above the threshold", () => {
    expect(findToolResultSpills("read", textResult(16_001))).toEqual([
      { tool: "read", chars: 16_001 },
    ]);
  });

  it("totals characters across text blocks and ignores images", () => {
    const result = {
      content: [
        { type: "text" as const, text: "x".repeat(9_000) },
        { type: "image" as const },
        { type: "text" as const, text: "x".repeat(7_001) },
      ],
    };
    expect(findToolResultSpills("shell", result)).toEqual([
      { tool: "shell", chars: 16_001 },
    ]);
  });

  it("stays quiet for small and empty results", () => {
    expect(findToolResultSpills("read", textResult(10))).toEqual([]);
    expect(findToolResultSpills("read", { content: [] })).toEqual([]);
  });
});

describe("cumulative usage delta", () => {
  it("deltas session-cumulative input minus cache across turns", () => {
    const turn1 = deltaUsage({
      inputTokens: 1_000,
      outputTokens: 100,
      cachedReadTokens: 200,
    });
    expect(turn1).toMatchObject({
      input: 800,
      output: 100,
      cacheRead: 200,
      cacheWrite: 0,
      totalTokens: 1_100,
      present: true,
    });
    expect(turn1.nextCumulative).toEqual({
      inputTokens: 1_000,
      outputTokens: 100,
      cachedReadTokens: 200,
    });

    const turn2 = deltaUsage(
      { inputTokens: 2_500, outputTokens: 250, cachedReadTokens: 1_200 },
      turn1.nextCumulative,
    );
    expect(turn2).toMatchObject({
      input: 500,
      output: 150,
      cacheRead: 1_000,
      cacheWrite: 0,
      totalTokens: 1_650,
      present: true,
    });
    expect(turn2.nextCumulative).toEqual({
      inputTokens: 2_500,
      outputTokens: 250,
      cachedReadTokens: 1_200,
    });
  });

  it("clamps counters that moved backwards to zero", () => {
    const previous: CumulativeUsageSnapshot = {
      inputTokens: 5_000,
      outputTokens: 500,
      cachedReadTokens: 4_000,
    };
    const delta = deltaUsage(
      { inputTokens: 4_000, outputTokens: 450, cachedReadTokens: 3_000 },
      previous,
    );
    expect(delta).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      present: true,
    });
    expect(delta.nextCumulative).toEqual({
      inputTokens: 4_000,
      outputTokens: 450,
      cachedReadTokens: 3_000,
    });
  });

  it("reports absent usage as not present and keeps the previous cumulative", () => {
    const previous: CumulativeUsageSnapshot = {
      inputTokens: 500,
      outputTokens: 50,
      cachedReadTokens: 400,
    };
    const delta = deltaUsage(undefined, previous);
    expect(delta.present).toBe(false);
    expect(delta.input).toBe(0);
    expect(delta.output).toBe(0);
    expect(delta.cacheRead).toBe(0);
    expect(delta.nextCumulative).toEqual(previous);
  });
});

describe("compaction detection", () => {
  it("matches the compaction checkpoint marker", () => {
    expect(
      isVibeCompactionUpdate({ _meta: { checkpoint_kind: "compaction" } }),
    ).toBe(true);
  });

  it("matches both compaction tool-call titles", () => {
    expect(
      isVibeCompactionUpdate({
        sessionUpdate: "tool_call",
        title: "Compacting conversation history...",
      }),
    ).toBe(true);
    expect(
      isVibeCompactionUpdate({
        sessionUpdate: "tool_call_update",
        title: "Compacted conversation history",
      }),
    ).toBe(true);
  });

  it("ignores ordinary tool calls and malformed updates", () => {
    expect(
      isVibeCompactionUpdate({ sessionUpdate: "tool_call", title: "Read file" }),
    ).toBe(false);
    expect(
      isVibeCompactionUpdate({ sessionUpdate: "agent_message_chunk" }),
    ).toBe(false);
    expect(isVibeCompactionUpdate({})).toBe(false);
    expect(isVibeCompactionUpdate(null)).toBe(false);
    expect(isVibeCompactionUpdate(undefined)).toBe(false);
  });
});

function fakeModel(cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }, id = "deepseek-v4-1-flash-1017") {
  return {
    id,
    provider: "mistral-vibe",
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    input: ["text"],
    cost,
    reasoning: true,
    contextWindow: 186144,
    maxTokens: 8192,
  } as any;
}

function fakeStream(events: unknown[]) {
  return { push: (event: unknown) => events.push(event) };
}

describe("event bridge", () => {
  it("maps stop reasons", () => {
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("max_output_tokens")).toBe("length");
    expect(mapStopReason("cancelled")).toBe("aborted");
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("max_turn_requests")).toBe("error");
    expect(mapStopReason("refusal")).toBe("error");
    expect(mapStopReason("future_reason")).toBe("error");
    expect(mapStopReason(undefined)).toBe("error");
    expect(mapStopReason("something-new")).toBe("error");
  });

  it("streams text and thinking blocks and prices delta usage", () => {
    const events: any[] = [];
    const bridge = createEventBridge(fakeStream(events) as any, fakeModel(), {
      previousUsage: { inputTokens: 1_000, outputTokens: 100, cachedReadTokens: 200 },
    });
    expect(bridge.started()).toBe(false);

    bridge.handleUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking " },
    });
    bridge.handleUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "here" },
    });
    bridge.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello " },
    });
    bridge.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
    });
    bridge.handleUpdate({ sessionUpdate: "usage_update", used: 2_500 });

    expect(bridge.started()).toBe(true);
    const output = bridge.getOutput();
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "thinking here" });
    expect(output.content[1]).toMatchObject({ type: "text", text: "Hello world" });
    // Context-only frame before spend counters: availability is unavailable,
    // but totalTokens carries the observed context occupancy for Pi's
    // context/compaction estimator — not spend (input/output stay 0).
    expect(output.usage.totalTokens).toBe(2_500);
    expect((output as any).usageReport?.availability).toBe("unavailable");
    expect((output as any).usageReport?.spend).toBeNull();
    expect((output as any).usageReport?.contextTokens).toBe(2_500);

    bridge.applyResult({
      stopReason: "end_turn",
      usage: { inputTokens: 1_600, outputTokens: 150, cachedReadTokens: 500 },
    });
    const priced = bridge.getOutput();
    // delta: inputTotal 600 - cacheDelta 300 = input 300; output 50; total from last step.
    expect(priced.usage.input).toBe(300);
    expect(priced.usage.output).toBe(50);
    expect(priced.usage.cacheRead).toBe(300);
    expect(priced.usage.cacheWrite).toBe(0);
    expect(priced.usage.totalTokens).toBe(2_500);
    expect((priced as any).usageReport?.availability).toBe("reported");
    expect((priced as any).usageReport?.contextTokens).toBe(2_500);
    expect(priced.usage.cost.total).toBeGreaterThan(0);
    expect(priced.stopReason).toBe("stop");
    expect(bridge.getCumulativeUsage()).toEqual({
      inputTokens: 1_600,
      outputTokens: 150,
      cachedReadTokens: 500,
    });
  });

  it("streams thinking, text, and delta usage with unavailable-to-reported switch", () => {
    const events: any[] = [];
    const bridge = createEventBridge(fakeStream(events) as any, fakeModel(), {
      previousUsage: { inputTokens: 1_000, outputTokens: 100, cachedReadTokens: 200 },
    });
    bridge.handleUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking " },
    });
    bridge.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello world" },
    });
    bridge.handleUpdate({ sessionUpdate: "usage_update", used: 2_500 });
    // Before spend counters: context-only, unavailable spend, but
    // totalTokens carries the observed context occupancy.
    expect((bridge.getOutput() as any).usageReport.availability).toBe("unavailable");
    expect(bridge.getOutput().usage.totalTokens).toBe(2_500);
    expect((bridge.getOutput() as any).usageReport.contextTokens).toBe(2_500);
    bridge.applyResult({
      stopReason: "end_turn",
      usage: { inputTokens: 1_600, outputTokens: 150, cachedReadTokens: 500 },
    });
    expect((bridge.getOutput() as any).usageReport.availability).toBe("reported");
    expect(bridge.getOutput().usage.totalTokens).toBe(2_500);
  });

  it("only surfaces Pi tool calls from the handoff broker, never vendor tool calls", () => {
    const events: any[] = [];
    const bridge = createEventBridge(fakeStream(events) as any, fakeModel());
    bridge.handleUpdate({
      sessionUpdate: "tool_call",
      title: "Vendor builtin",
      toolCallId: "call-1",
    });
    bridge.handleUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
    });
    expect(
      bridge.getOutput().content.some((block) => block.type === "toolCall"),
    ).toBe(false);

    bridge.pushToolCall({
      id: "pi-call-1",
      name: "read",
      arguments: { path: "src/index.ts" },
    });
    const output = bridge.getOutput();
    const toolCall = output.content.find((block) => block.type === "toolCall");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      id: "pi-call-1",
      name: "read",
      arguments: { path: "src/index.ts" },
    });
    expect(output.stopReason).toBe("toolUse");
    expect(events.some((event) => event.type === "toolcall_end")).toBe(true);

    bridge.applyResult({ stopReason: "end_turn" });
    expect(bridge.getOutput().stopReason).toBe("toolUse");
  });

  it("invokes the compaction callback and closes open blocks", () => {
    const events: any[] = [];
    const detected: any[] = [];
    const bridge = createEventBridge(fakeStream(events) as any, fakeModel(), {
      onCompactionDetected: (update) => detected.push(update),
    });
    bridge.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "working" },
    });
    const compactionUpdate = {
      sessionUpdate: "tool_call",
      title: "Compacting conversation history...",
    };
    bridge.handleUpdate(compactionUpdate);
    expect(detected).toEqual([compactionUpdate]);

    const checkpointUpdate = { _meta: { checkpoint_kind: "compaction" } };
    bridge.handleUpdate(checkpointUpdate);
    expect(detected).toEqual([compactionUpdate, checkpointUpdate]);

    bridge.appendMarker("turn held for replay");
    expect(bridge.getOutput().content.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("turn held for replay"),
    });

    bridge.finalizeBlocks();
    const ends = events.filter((event) => event.type === "text_end");
    expect(ends.length).toBeGreaterThan(0);
    expect(bridge.getOutput().content).toEqual(
      expect.any(Array),
    );
  });

  it("keeps toolUse stop reason through applyResult when a handoff claimed the turn", () => {
    const events: any[] = [];
    const bridge = createEventBridge(fakeStream(events) as any, fakeModel());
    bridge.pushToolCall({ id: "pi-2", name: "shell", arguments: {} });
    bridge.applyResult({
      stopReason: "end_turn",
      usage: { inputTokens: 120, outputTokens: 10, cachedReadTokens: 20 },
    });
    const output = bridge.getOutput();
    expect(output.stopReason).toBe("toolUse");
    expect(output.usage.input).toBe(100);
    expect(output.usage.output).toBe(10);
    expect(output.usage.cacheRead).toBe(20);
  });
});

describe("cumulative usage from usage_update _meta", () => {
  it("preserves _meta usage on the error path with no applyResult", () => {
    const events: any[] = [];
    const bridge = createEventBridge(fakeStream(events) as any, fakeModel());
    bridge.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 },
    });
    expect(bridge.getOutput().usage.input).toBe(18);
    expect(bridge.getOutput().usage.output).toBe(3);
    expect(bridge.getOutput().usage.cacheRead).toBe(4);
    expect(bridge.getCumulativeUsage()).toEqual({
      inputTokens: 22,
      outputTokens: 3,
      cachedReadTokens: 4,
    });
    expect(bridge.getUsageReport().availability).toBe("reported");
    expect(bridge.getUsageReport().spend).toEqual({
      input: 18,
      output: 3,
      cacheRead: 4,
      cacheWrite: 0,
      total: 25,
    });
  });

  it("does not double count when applyResult repeats the same cumulative totals", () => {
    const events: any[] = [];
    const bridge = createEventBridge(fakeStream(events) as any, fakeModel());
    bridge.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 },
    });
    bridge.applyResult({
      stopReason: "end_turn",
      usage: { inputTokens: 22, outputTokens: 3, cachedReadTokens: 4 },
    });
    expect(bridge.getOutput().usage.input).toBe(18);
    expect(bridge.getOutput().usage.output).toBe(3);
    expect(bridge.getOutput().usage.cacheRead).toBe(4);
    expect(bridge.getCumulativeUsage()).toEqual({
      inputTokens: 22,
      outputTokens: 3,
      cachedReadTokens: 4,
    });
    expect(bridge.getUsageReport().availability).toBe("reported");
  });

  it("chains per-turn deltas across tool-continuation bridges with zero double counting", () => {
    const events1: any[] = [];
    const bridge1 = createEventBridge(fakeStream(events1) as any, fakeModel());
    bridge1.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 },
    });
    bridge1.pushToolCall({ id: "pi-1", name: "read", arguments: {} });
    expect(bridge1.getOutput().usage.input).toBe(18);
    expect(bridge1.getOutput().usage.output).toBe(3);
    expect(bridge1.getOutput().usage.cacheRead).toBe(4);
    expect(bridge1.getCumulativeUsage()).toEqual({
      inputTokens: 22,
      outputTokens: 3,
      cachedReadTokens: 4,
    });

    const events2: any[] = [];
    const bridge2 = createEventBridge(fakeStream(events2) as any, fakeModel(), {
      previousUsage: bridge1.getCumulativeUsage(),
    });
    bridge2.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 60, completionTokens: 10, cachedTokens: 20 },
    });
    bridge2.applyResult({
      stopReason: "end_turn",
      usage: { inputTokens: 60, outputTokens: 10, cachedReadTokens: 20 },
    });
    expect(bridge2.getOutput().usage.input).toBe(22);
    expect(bridge2.getOutput().usage.output).toBe(7);
    expect(bridge2.getOutput().usage.cacheRead).toBe(16);
    expect(bridge2.getCumulativeUsage()).toEqual({
      inputTokens: 60,
      outputTokens: 10,
      cachedReadTokens: 20,
    });
    expect(bridge2.getUsageReport().spend).toEqual({
      input: 22,
      output: 7,
      cacheRead: 16,
      cacheWrite: 0,
      total: 45,
    });
  });

  it("distinguishes unavailable spend from zero and context size from spend", () => {
    const events: any[] = [];
    const bridge = createEventBridge(fakeStream(events) as any, fakeModel());
    bridge.handleUpdate({
      sessionUpdate: "usage_update",
      used: 2500,
      size: 262144,
    });
    const report = bridge.getUsageReport();
    expect(report.availability).toBe("unavailable");
    expect(report.spend).toBeNull();
    expect(report.contextTokens).toBe(2500);
    expect(report.contextSize).toBe(262144);
    expect(bridge.getOutput().usage.totalTokens).toBe(2500);
    expect(bridge.getOutput().usage.input).toBe(0);
    expect((bridge.getOutput() as any).usageReport.availability).toBe("unavailable");
    expect((bridge.getOutput() as any).usageReport.spend).toBeNull();
    expect((bridge.getOutput() as any).usageReport.contextTokens).toBe(2500);
    expect((bridge.getOutput() as any).usageReport.contextSize).toBe(262144);
    expect((bridge.getOutput() as any).usageReport.estimatedCost).toBeNull();
  });

  it("marks cost basis unknown for unlisted models and api-equivalent for listed models", () => {
    const listed = createEventBridge(
      fakeStream([]) as any,
      fakeModel({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }, "mistral-large-4-0"),
    );
    const unlisted = createEventBridge(
      fakeStream([]) as any,
      fakeModel({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }, "unlisted-model-xyz"),
    );
    expect(listed.getUsageReport().costBasis).toBe("api-equivalent");
    expect(unlisted.getUsageReport().costBasis).toBe("unknown");
    listed.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 },
    });
    unlisted.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 },
    });
    expect(listed.getOutput().usage.cost.total).toBeGreaterThan(0);
    expect(unlisted.getOutput().usage.cost).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });
});

describe("session usage watermark across tool-continuation episodes", () => {
  it("chains episode 1 at pushToolCall and episode 2 to 800/100/200 without double counting", () => {
    const watermark = createSessionUsageWatermark();
    // Episode 1 advances the shared watermark at every _meta frame.
    const events1: any[] = [];
    const bridge1 = createEventBridge(fakeStream(events1) as any, fakeModel(), { watermark });
    bridge1.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 },
    });
    bridge1.pushToolCall({ id: "pi-1", name: "read", arguments: {} });
    // No caller copy needed: the watermark already holds 22/3/4.
    expect(watermark.current()).toEqual({ inputTokens: 22, outputTokens: 3, cachedReadTokens: 4 });
    expect(bridge1.getOutput().usage.input).toBe(18);
    expect(bridge1.getOutput().usage.output).toBe(3);
    expect(bridge1.getOutput().usage.cacheRead).toBe(4);

    // Episode 2 baselines on the watermark (not a stale previousUsage).
    const events2: any[] = [];
    const bridge2 = createEventBridge(fakeStream(events2) as any, fakeModel(), { watermark });
    bridge2.applyResult({
      stopReason: "end_turn",
      usage: { inputTokens: 1000, outputTokens: 100, cachedReadTokens: 200 },
    });
    expect(bridge2.getOutput().usage.input).toBe(782);
    expect(bridge2.getOutput().usage.output).toBe(97);
    expect(bridge2.getOutput().usage.cacheRead).toBe(196);
    expect(watermark.current()).toEqual({ inputTokens: 1000, outputTokens: 100, cachedReadTokens: 200 });
    // Episode 1 + episode 2 = 800/100/200 (not 818/103/204).
    expect(bridge1.getOutput().usage.input + bridge2.getOutput().usage.input).toBe(800);
    expect(bridge1.getOutput().usage.output + bridge2.getOutput().usage.output).toBe(100);
    expect(bridge1.getOutput().usage.cacheRead + bridge2.getOutput().usage.cacheRead).toBe(200);
  });

  it("preserves a mid-turn _meta frame on the episode-2 error path without double counting", () => {
    const watermark = createSessionUsageWatermark();
    const events1: any[] = [];
    const bridge1 = createEventBridge(fakeStream(events1) as any, fakeModel(), { watermark });
    bridge1.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 },
    });
    bridge1.pushToolCall({ id: "pi-1", name: "read", arguments: {} });

    const events2: any[] = [];
    const bridge2 = createEventBridge(fakeStream(events2) as any, fakeModel(), { watermark });
    bridge2.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 60, completionTokens: 10, cachedTokens: 20 },
    });
    // The watermark advances on the _meta frame immediately, before any terminal.
    expect(watermark.current()).toEqual({ inputTokens: 60, outputTokens: 10, cachedReadTokens: 20 });
    // Error terminal carries no new usage: no second counting of the same _meta.
    bridge2.applyResult({ stopReason: "refusal" });
    expect(bridge2.getOutput().stopReason).toBe("error");
    expect(bridge2.getOutput().usage.input).toBe(22);
    expect(bridge2.getOutput().usage.output).toBe(7);
    expect(bridge2.getOutput().usage.cacheRead).toBe(16);
    expect(watermark.current()).toEqual({ inputTokens: 60, outputTokens: 10, cachedReadTokens: 20 });
    expect(bridge1.getOutput().usage.input + bridge2.getOutput().usage.input).toBe(40);
  });

  it("commitUsage advances the watermark and returns a copy of the cumulative", () => {
    const watermark = createSessionUsageWatermark();
    const bridge = createEventBridge(fakeStream([]) as any, fakeModel(), { watermark });
    bridge.handleUpdate({
      sessionUpdate: "usage_update",
      _meta: { promptTokens: 22, completionTokens: 3, cachedTokens: 4 },
    });
    const committed = bridge.commitUsage();
    expect(committed).toEqual({ inputTokens: 22, outputTokens: 3, cachedReadTokens: 4 });
    expect(watermark.current()).toEqual({ inputTokens: 22, outputTokens: 3, cachedReadTokens: 4 });
    committed.inputTokens = 999;
    expect(watermark.current().inputTokens).toBe(22);
  });
});

describe("usageReport cost fields on stream output", () => {
  it("exposes costKnown/costBasis/estimatedCost on stream events and getOutput for listed and unlisted models", () => {
    // Listed model: non-null estimatedCost once spend is reported.
    const listedEvents: any[] = [];
    const listed = createEventBridge(fakeStream(listedEvents) as any, fakeModel({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }, "mistral-large-4-0"));
    listed.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
    listed.handleUpdate({
      sessionUpdate: "usage_update",
      used: 2500,
      size: 262144,
      _meta: { promptTokens: 100, completionTokens: 10, cachedTokens: 20 },
    });
    listed.applyResult({
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 20 },
    });
    // start event carries the live report
    const startEvent = listedEvents.find((e: any) => e.type === "start");
    expect(startEvent?.partial?.usageReport).toBeDefined();
    expect(startEvent.partial.usageReport.costKnown).toBe(true);
    expect(startEvent.partial.usageReport.costBasis).toBe("api-equivalent");
    // Done is not pushed by the bridge itself; getOutput is the terminal surface.
    const listedOut = listed.getOutput() as any;
    expect(listedOut.usageReport.availability).toBe("reported");
    expect(listedOut.usageReport.costKnown).toBe(true);
    expect(listedOut.usageReport.costBasis).toBe("api-equivalent");
    expect(listedOut.usageReport.estimatedCost).not.toBeNull();
    expect(listedOut.usageReport.estimatedCost.total).toBeGreaterThan(0);
    expect((listedOut.usage.cost as any).costKnown).toBe(true);
    expect((listedOut.usage.cost as any).costBasis).toBe("api-equivalent");
    expect(listed.getUsageReport().estimatedCost).toEqual(listedOut.usageReport.estimatedCost);
    expect(listed.getUsageReport().costKnown).toBe(true);

    // Unlisted model: estimatedCost stays null, never numeric zero.
    const unlistedEvents: any[] = [];
    const unlisted = createEventBridge(fakeStream(unlistedEvents) as any, fakeModel({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }, "unlisted-model-xyz"));
    unlisted.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
    unlisted.handleUpdate({
      sessionUpdate: "usage_update",
      used: 2500,
      _meta: { promptTokens: 100, completionTokens: 10, cachedTokens: 20 },
    });
    const unlistedOut = unlisted.getOutput() as any;
    expect(unlistedOut.usageReport.availability).toBe("reported");
    expect(unlistedOut.usageReport.costKnown).toBe(false);
    expect(unlistedOut.usageReport.costBasis).toBe("unknown");
    expect(unlistedOut.usageReport.estimatedCost).toBeNull();
    expect((unlistedOut.usage.cost as any).costKnown).toBe(false);
    expect((unlistedOut.usage.cost as any).costBasis).toBe("unknown");
    expect(unlisted.getUsageReport().estimatedCost).toBeNull();
    // Context-only frame on a listed model still reports unknown spend, not $0.
    const ctxOnly = createEventBridge(fakeStream([]) as any, fakeModel({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }, "mistral-large-4-0"));
    ctxOnly.handleUpdate({ sessionUpdate: "usage_update", used: 2500, size: 262144 });
    expect((ctxOnly.getOutput() as any).usageReport.estimatedCost).toBeNull();
    expect((ctxOnly.getOutput() as any).usageReport.availability).toBe("unavailable");
  });

  it("builds an unavailable report with the shared shape for empty/error messages", () => {
    const unavailable = createUnavailableUsageReport("unlisted-model-xyz");
    expect(unavailable.availability).toBe("unavailable");
    expect(unavailable.spend).toBeNull();
    expect(unavailable.contextTokens).toBeNull();
    expect(unavailable.contextSize).toBeNull();
    expect(unavailable.costKnown).toBe(false);
    expect(unavailable.costBasis).toBe("unknown");
    expect(unavailable.estimatedCost).toBeNull();
    const listedUnavailable = createUnavailableUsageReport("mistral-large-4-0");
    expect(listedUnavailable.costKnown).toBe(true);
    expect(listedUnavailable.costBasis).toBe("api-equivalent");
    expect(listedUnavailable.estimatedCost).toBeNull();
  });
});

describe("stop reason errors", () => {
  it("marks max_turn_requests as an error with rawStopReason and errorMessage", () => {
    const bridge = createEventBridge(fakeStream([]) as any, fakeModel());
    bridge.applyResult({ stopReason: "max_turn_requests" });
    const output = bridge.getOutput();
    expect(output.stopReason).toBe("error");
    expect(output.rawStopReason).toBe("max_turn_requests");
    expect(output.errorMessage).toBe(
      "Mistral Vibe stopped early: reached max_turn_requests limit (stopReason=max_turn_requests).",
    );
  });

  it("marks refusal as an error with rawStopReason and errorMessage", () => {
    const bridge = createEventBridge(fakeStream([]) as any, fakeModel());
    bridge.applyResult({ stopReason: "refusal" });
    const output = bridge.getOutput();
    expect(output.stopReason).toBe("error");
    expect(output.rawStopReason).toBe("refusal");
    expect(output.errorMessage).toBe(
      "Mistral Vibe refused to complete the turn (stopReason=refusal).",
    );
  });

  it("marks an unknown stop reason string as an error", () => {
    const bridge = createEventBridge(fakeStream([]) as any, fakeModel());
    bridge.applyResult({ stopReason: "future_reason" });
    const output = bridge.getOutput();
    expect(output.stopReason).toBe("error");
    expect(output.rawStopReason).toBe("future_reason");
    expect(output.errorMessage).toBe(
      "Mistral Vibe returned unrecognized ACP stopReason: future_reason.",
    );
  });

  it("marks a missing stop reason as an error", () => {
    const bridge = createEventBridge(fakeStream([]) as any, fakeModel());
    bridge.applyResult({});
    const output = bridge.getOutput();
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toBe(
      "Mistral Vibe returned unrecognized ACP stopReason: missing.",
    );
  });
});

describe("context-only usage_update populates totalTokens for Pi's context estimator", () => {
  it("exposes observed context occupancy as totalTokens while spend stays unavailable (Pi real consumers)", () => {
    const events: any[] = [];
    const bridge = createEventBridge(fakeStream(events) as any, fakeModel());
    bridge.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ok" },
    });
    bridge.handleUpdate({ sessionUpdate: "usage_update", used: 650, size: 1000 });
    // end_turn without usage: applyResult must not clobber the context occupancy.
    bridge.applyResult({ stopReason: "end_turn" });

    const output = bridge.getOutput();
    expect(output.usage.totalTokens).toBe(650);
    expect(output.usage.input).toBe(0);
    expect(output.usage.output).toBe(0);
    expect(output.usage.cacheRead).toBe(0);
    expect(output.usage.cacheWrite).toBe(0);
    expect(output.usage.cost.total).toBe(0);

    expect((output as any).usageReport).toMatchObject({
      availability: "unavailable",
      spend: null,
      contextTokens: 650,
      contextSize: 1000,
      estimatedCost: null,
    });
    expect(bridge.getUsageReport()).toMatchObject({
      availability: "unavailable",
      spend: null,
      contextTokens: 650,
      contextSize: 1000,
      estimatedCost: null,
    });

    // Pi's real public consumers see the context occupancy:
    const lastUsage = getLastAssistantUsage([
      { type: "message", message: output } as any,
    ])!;
    expect(lastUsage).toBe(output.usage);
    expect(calculateContextTokens(lastUsage)).toBe(650);
    expect(
      shouldCompact(calculateContextTokens(lastUsage), 1000, {
        enabled: true,
        reserveTokens: 400,
        keepRecentTokens: 200,
      }),
    ).toBe(true);
  });
});
