/**
 * ACP `session/update` → Pi's AssistantMessageEventStream.
 *
 * The bridge is the only writer of Pi's assistant message. It materializes
 * text and thinking blocks from the transport's chunk updates, and
 * materializes a Pi `toolCall` only when the handoff broker surfaced one of
 * Pi's own tools — vendor `tool_call` updates never become Pi tool calls.
 */

import {
  calculateCost,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";

import { modelCostStatus } from "./catalog.js";

export const PROVIDER_ID = "mistral-vibe";

/** Session-cumulative token counters as the ACP prompt terminal reports them. */
export interface CumulativeUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
}

/** ACP prompt terminal: `{stopReason, usage}`. */
export interface AcpPromptResult {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    totalTokens?: number;
  };
}

export interface UsageReport {
  availability: "reported" | "unavailable";
  spend: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
  contextTokens: number | null;
  contextSize: number | null;
  costKnown: boolean;
  costBasis: "api-equivalent" | "unknown";
  estimatedCost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
}

export interface SessionUsageWatermark {
  current(): CumulativeUsageSnapshot;
  advance(next: CumulativeUsageSnapshot): void;
}

export function createSessionUsageWatermark(
  initial?: Partial<CumulativeUsageSnapshot>,
): SessionUsageWatermark {
  let currentState: CumulativeUsageSnapshot = {
    inputTokens: initial?.inputTokens ?? 0,
    outputTokens: initial?.outputTokens ?? 0,
    cachedReadTokens: initial?.cachedReadTokens ?? 0,
  };
  return {
    current(): CumulativeUsageSnapshot {
      return { ...currentState };
    },
    advance(next: CumulativeUsageSnapshot): void {
      currentState = {
        inputTokens: Math.max(currentState.inputTokens, next.inputTokens),
        outputTokens: Math.max(currentState.outputTokens, next.outputTokens),
        cachedReadTokens: Math.max(currentState.cachedReadTokens, next.cachedReadTokens),
      };
    },
  };
}

function resolveCostStatus(
  modelIdOrSpec: string | { id: string; costKnown?: unknown; costBasis?: unknown },
): { costKnown: boolean; costBasis: "api-equivalent" | "unknown" } {
  if (typeof modelIdOrSpec === "string") {
    const basis = modelCostStatus(modelIdOrSpec);
    return { costKnown: basis === "api-equivalent", costBasis: basis };
  }
  if (
    (modelIdOrSpec as any).costKnown === false ||
    (modelIdOrSpec as any).costBasis === "unknown"
  ) {
    return { costKnown: false, costBasis: "unknown" };
  }
  const basis = modelCostStatus(modelIdOrSpec as any);
  return { costKnown: basis === "api-equivalent", costBasis: basis };
}

export function buildUsageReport(input: {
  availability: "reported" | "unavailable";
  spend: UsageReport["spend"];
  contextTokens: number | null;
  contextSize: number | null;
  costKnown: boolean;
  costBasis: "api-equivalent" | "unknown";
  estimatedCost: UsageReport["estimatedCost"];
}): UsageReport {
  return { ...input };
}

export function createUnavailableUsageReport(
  modelIdOrSpec: string | { id: string; costKnown?: boolean; costBasis?: "api-equivalent" | "unknown" },
  extra?: Partial<UsageReport>,
): UsageReport {
  const { costKnown, costBasis } = resolveCostStatus(modelIdOrSpec as any);
  return {
    availability: "unavailable",
    spend: null,
    contextTokens: extra?.contextTokens ?? null,
    contextSize: extra?.contextSize ?? null,
    costKnown,
    costBasis,
    estimatedCost: null,
  };
}

export interface EventBridge {
  handleUpdate(update: any): void;
  /** Materialize a Pi tool call backed by a blocked MCP invocation. */
  pushToolCall(call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }): void;
  /** Apply the prompt terminal: usage, stop reason, final text safety net. */
  applyResult(result: AcpPromptResult): void;
  /** Append a provider diagnostic as a text block (used for exit detail). */
  appendMarker(text: string): void;
  /** Close any open text/thinking block before `toolcall_end` or `done`. */
  finalizeBlocks(): void;
  getOutput(): AssistantMessage;
  getCumulativeUsage(): CumulativeUsageSnapshot;
  getUsageReport(): UsageReport;
  commitUsage(): CumulativeUsageSnapshot;
  started(): boolean;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

const ZERO_USAGE: CumulativeUsageSnapshot = {
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
};

/**
 * Per-turn delta from session-cumulative counters.
 *
 * The transport's `inputTokens` includes `cachedReadTokens`, so the fresh
 * input is the input delta minus the cache delta.
 */
export function deltaUsage(
  current: AcpPromptResult["usage"],
  previous?: CumulativeUsageSnapshot,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  present: boolean;
  nextCumulative: CumulativeUsageSnapshot;
} {
  const prev = previous ?? ZERO_USAGE;
  const present =
    finite(current?.inputTokens) ||
    finite(current?.outputTokens) ||
    finite(current?.cachedReadTokens);
  const curInput = finite(current?.inputTokens) ? current!.inputTokens! : prev.inputTokens;
  const curOutput = finite(current?.outputTokens) ? current!.outputTokens! : prev.outputTokens;
  const curCache = finite(current?.cachedReadTokens) ? current!.cachedReadTokens! : prev.cachedReadTokens;
  const nextCumulative: CumulativeUsageSnapshot = {
    inputTokens: curInput,
    outputTokens: curOutput,
    cachedReadTokens: curCache,
  };
  if (!present) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      present: false,
      nextCumulative: { ...prev },
    };
  }
  const deltaCache = Math.max(0, curCache - prev.cachedReadTokens);
  const deltaInputTotal = Math.max(0, curInput - prev.inputTokens);
  const input = Math.max(0, deltaInputTotal - deltaCache);
  const output = Math.max(0, curOutput - prev.outputTokens);
  return {
    input,
    output,
    cacheRead: deltaCache,
    cacheWrite: 0,
    totalTokens: input + deltaCache + output,
    present: true,
    nextCumulative,
  };
}

export function isVibeCompactionUpdate(update: any): boolean {
  if (!update || typeof update !== "object") return false;
  if (update._meta?.checkpoint_kind === "compaction") return true;
  const sessionUpdate = update.sessionUpdate;
  if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") {
    return false;
  }
  return (
    update.title === "Compacting conversation history..." ||
    update.title === "Compacted conversation history"
  );
}

export function mapStopReason(
  reason: string | undefined,
): "stop" | "length" | "toolUse" | "aborted" | "error" {
  switch (reason) {
    case "max_tokens":
    case "max_output_tokens":
      return "length";
    case "cancelled":
      return "aborted";
    case "end_turn":
      return "stop";
    case "max_turn_requests":
    case "refusal":
      return "error";
    default:
      return "error";
  }
}

export function createEventBridge(
  stream: Pick<AssistantMessageEventStream, "push">,
  model: Model<any>,
  options?: {
    previousUsage?: CumulativeUsageSnapshot;
    watermark?: SessionUsageWatermark;
    onCompactionDetected?: (update: any) => void;
  },
): EventBridge {
  let started = false;
  let textBlock: { index: number; text: string } | undefined;
  let thinkingBlock: { index: number; text: string } | undefined;
  let lastStepUsed: number | undefined;
  let lastContextSize: number | undefined;
  let usageReported = false;
  const turnBaseline: CumulativeUsageSnapshot = {
    ...(options?.watermark
      ? options.watermark.current()
      : (options?.previousUsage ?? ZERO_USAGE)),
  };
  let latestCumulative: CumulativeUsageSnapshot = { ...turnBaseline };
  const costStatus = resolveCostStatus(model as any);
  const costKnown = costStatus.costKnown;
  const costBasis = costStatus.costBasis;

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: PROVIDER_ID as any,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  (output.usage.cost as any).costKnown = costKnown;
  (output.usage.cost as any).costBasis = costBasis;
  (output as any).usageReport = {
    availability: "unavailable",
    spend: null,
    contextTokens: null,
    contextSize: null,
    costKnown,
    costBasis,
    estimatedCost: null,
  };

  function syncUsageReport(): void {
    (output as any).usageReport = getUsageReport();
    (output.usage.cost as any).costKnown = costKnown;
    (output.usage.cost as any).costBasis = costBasis;
    if (costKnown && usageReported) {
      (output.usage.cost as any).totalFromProvider = false;
    }
  }

  function applyCumulativeSnapshot(raw: AcpPromptResult["usage"]): void {
    const hasFiniteCounter =
      finite(raw?.inputTokens) ||
      finite(raw?.outputTokens) ||
      finite(raw?.cachedReadTokens);
    if (!hasFiniteCounter) return;
    const merged: CumulativeUsageSnapshot = {
      inputTokens: finite(raw?.inputTokens)
        ? Math.max(raw!.inputTokens!, latestCumulative.inputTokens)
        : latestCumulative.inputTokens,
      outputTokens: finite(raw?.outputTokens)
        ? Math.max(raw!.outputTokens!, latestCumulative.outputTokens)
        : latestCumulative.outputTokens,
      cachedReadTokens: finite(raw?.cachedReadTokens)
        ? Math.max(raw!.cachedReadTokens!, latestCumulative.cachedReadTokens)
        : latestCumulative.cachedReadTokens,
    };
    const delta = deltaUsage(merged, turnBaseline);
    if (!delta.present) return;
    usageReported = true;
    latestCumulative = delta.nextCumulative;
    output.usage.input = delta.input;
    output.usage.output = delta.output;
    output.usage.cacheRead = delta.cacheRead;
    output.usage.cacheWrite = delta.cacheWrite;
    output.usage.totalTokens = lastStepUsed ?? delta.totalTokens;
    if (costKnown && model.cost) {
      calculateCost(model, output.usage);
      (output.usage.cost as any).totalFromProvider = false;
    }
    (output.usage.cost as any).costKnown = costKnown;
    (output.usage.cost as any).costBasis = costBasis;
    if (options?.watermark) options.watermark.advance(latestCumulative);
    syncUsageReport();
  }

  function getUsageReport(): UsageReport {
    if (!usageReported) {
      return {
        availability: "unavailable",
        spend: null,
        contextTokens: lastStepUsed ?? null,
        contextSize: lastContextSize ?? null,
        costKnown,
        costBasis,
        estimatedCost: null,
      };
    }
    let estimatedCost: UsageReport["estimatedCost"] = null;
    if (costKnown) {
      estimatedCost = {
        input: output.usage.cost.input,
        output: output.usage.cost.output,
        cacheRead: output.usage.cost.cacheRead,
        cacheWrite: output.usage.cost.cacheWrite,
        total: output.usage.cost.total,
      };
    }
    return {
      availability: "reported",
      spend: {
        input: output.usage.input,
        output: output.usage.output,
        cacheRead: output.usage.cacheRead,
        cacheWrite: output.usage.cacheWrite,
        total:
          output.usage.input +
          output.usage.output +
          output.usage.cacheRead +
          output.usage.cacheWrite,
      },
      contextTokens: lastStepUsed ?? null,
      contextSize: lastContextSize ?? null,
      costKnown,
      costBasis,
      estimatedCost,
    };
  }

  function start(): void {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial: output });
  }

  function closeBlocks(): void {
    if (thinkingBlock) {
      stream.push({
        type: "thinking_end",
        contentIndex: thinkingBlock.index,
        content: thinkingBlock.text,
        partial: output,
      });
      thinkingBlock = undefined;
    }
    if (textBlock) {
      stream.push({
        type: "text_end",
        contentIndex: textBlock.index,
        content: textBlock.text,
        partial: output,
      });
      textBlock = undefined;
    }
  }

  function appendText(text: string): void {
    if (!text) return;
    start();
    if (thinkingBlock) {
      stream.push({
        type: "thinking_end",
        contentIndex: thinkingBlock.index,
        content: thinkingBlock.text,
        partial: output,
      });
      thinkingBlock = undefined;
    }
    if (!textBlock) {
      const index = output.content.length;
      output.content.push({ type: "text", text: "" } as TextContent);
      textBlock = { index, text: "" };
      stream.push({ type: "text_start", contentIndex: index, partial: output });
    }
    textBlock.text += text;
    (output.content[textBlock.index] as TextContent).text = textBlock.text;
    stream.push({
      type: "text_delta",
      contentIndex: textBlock.index,
      delta: text,
      partial: output,
    });
  }

  function appendThinking(text: string): void {
    if (!text) return;
    start();
    if (textBlock) {
      stream.push({
        type: "text_end",
        contentIndex: textBlock.index,
        content: textBlock.text,
        partial: output,
      });
      textBlock = undefined;
    }
    if (!thinkingBlock) {
      const index = output.content.length;
      output.content.push({ type: "thinking", thinking: "" } as ThinkingContent);
      thinkingBlock = { index, text: "" };
      stream.push({ type: "thinking_start", contentIndex: index, partial: output });
    }
    thinkingBlock.text += text;
    (output.content[thinkingBlock.index] as ThinkingContent).thinking = thinkingBlock.text;
    stream.push({
      type: "thinking_delta",
      contentIndex: thinkingBlock.index,
      delta: text,
      partial: output,
    });
  }

  function handleUpdate(update: any): void {
    if (!update || typeof update !== "object") return;
    if (isVibeCompactionUpdate(update)) {
      options?.onCompactionDetected?.(update);
    }
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text" && typeof update.content.text === "string")
          appendText(update.content.text);
        syncUsageReport();
        return;
      case "agent_thought_chunk":
        if (update.content?.type === "text" && typeof update.content.text === "string")
          appendThinking(update.content.text);
        syncUsageReport();
        return;
      case "usage_update":
        // The transport emits each inference step's total token count (`used`)
        // before the prompt terminal. Record it immediately as
        // output.usage.totalTokens: observed context occupancy, not spend.
        // Pi's context/compaction estimator reads totalTokens (and ignores
        // messages whose calculated context is 0), while spend totals sum
        // only input/output/cacheRead/cacheWrite/cost, so this never books
        // context as spend. usageReported stays false until finite spend
        // counters arrive, so availability stays "unavailable" meanwhile.
        if (finite(update.used) && update.used > 0) {
          lastStepUsed = update.used;
          output.usage.totalTokens = lastStepUsed!;
        }
        if (finite(update.size) && update.size > 0) {
          lastContextSize = update.size;
        }
        if (update._meta && typeof update._meta === "object") {
          applyCumulativeSnapshot({
            inputTokens: update._meta.promptTokens,
            outputTokens: update._meta.completionTokens,
            cachedReadTokens: update._meta.cachedTokens,
          });
        }
        syncUsageReport();
        return;
      default:
        // user_message_chunk, tool_call, tool_call_update, plan,
        // available_commands_update, config_option_update, session_info_update:
        // transport state, never assistant content.
        syncUsageReport();
        return;
    }
  }

  function pushToolCall(call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }): void {
    start();
    closeBlocks();
    const index = output.content.length;
    const toolCall: ToolCall = {
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.arguments as any,
    };
    output.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
    output.stopReason = "toolUse";
  }

  function applyResult(result: AcpPromptResult): void {
    start();
    // No finite spend counters in the terminal leaves totalTokens (observed
    // context occupancy from a context-only usage_update) untouched:
    // applyCumulativeSnapshot returns before assigning usage.
    applyCumulativeSnapshot(result.usage);
    const mapped = mapStopReason(result.stopReason);
    // A handoff already claimed this episode: the turn continues in Pi.
    if (output.stopReason !== "toolUse") {
      output.stopReason = mapped;
      if (mapped === "error") {
        if (result.stopReason === "max_turn_requests") {
          output.errorMessage =
            "Mistral Vibe stopped early: reached max_turn_requests limit (stopReason=max_turn_requests).";
        } else if (result.stopReason === "refusal") {
          output.errorMessage =
            "Mistral Vibe refused to complete the turn (stopReason=refusal).";
        } else {
          output.errorMessage = `Mistral Vibe returned unrecognized ACP stopReason: ${result.stopReason ?? "missing"}.`;
        }
      }
    }
    output.rawStopReason = result.stopReason;
    syncUsageReport();
  }

  function commitUsage(): CumulativeUsageSnapshot {
    if (options?.watermark) options.watermark.advance(latestCumulative);
    syncUsageReport();
    return { ...latestCumulative };
  }

  function appendMarker(text: string): void {
    appendText(`\n\n[mistral-vibe tether] ${text}`);
  }

  return {
    handleUpdate,
    pushToolCall,
    applyResult,
    appendMarker,
    finalizeBlocks: closeBlocks,
    getOutput: () => output,
    getCumulativeUsage: () => ({ ...latestCumulative }),
    getUsageReport,
    commitUsage,
    started: () => started,
  };
}
