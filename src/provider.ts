import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { endStreamWithError } from "pi-tether-core/pi-stream";
import { matchesPrefix, requestSignature } from "pi-tether-core/request";
import {
  VIBE_MAX_PROMPT_IMAGES,
  countBlockImages,
  guardLeadingSlashCommand,
  hasOlderImages,
  hasPromptBlockSeparation,
  hasThinkingBlocks,
  hasWarmImageWindowOverflow,
  historyHash,
  piContext,
  replayPiMessages,
  type PromptBlock,
} from "./pi-context.js";
import {
  CliProcess,
  getCliProcess,
  retireCliProcess,
  takeUnexpectedParkedExit,
  type EpisodeSink,
} from "./cli-process.js";
import {
  assertImageSupport,
  effortFor,
  modelSpecFor,
} from "./catalog.js";
import {
  autoCompactionDisclosure,
  builtinSchemasDisclosure,
  coldReplayDisclosure,
  emitDisclosure,
  findToolResultSpills,
  imageAttachmentLimitDisclosure,
  olderImagesDisclosure,
  parkedProcessExitDisclosure,
  promptBlockSeparationDisclosure,
  slashCommandCollisionDisclosure,
  strictTransport,
  systemOverheadDisclosure,
  toolResultSpillDisclosure,
  unsupportedControlDisclosure,
  type Disclosure,
  type DisclosureRecord,
} from "./degradations.js";
import { createEventBridge, createUnavailableUsageReport, PROVIDER_ID } from "./event-bridge.js";
import type { ToolDefinition } from "./mcp-config.js";
import { startHandoffBroker, type HandoffResult } from "./handoff-broker.js";
import {
  VibeProcessExitError,
  classifyVibeError,
  formatVibeError,
  sanitizeUntrustedDiagnostic,
} from "./errors.js";
import { recordStatus } from "./cli-status.js";
import {
  nativeSearchEnabled,
  type NativeSearchEntry,
  type NativeSearchSurface,
} from "./native-search.js";

function processErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Extended stream options: Pi's SimpleStreamOptions plus host plumbing. */
export type StreamOptions = SimpleStreamOptions & {
  cwd?: string;
  notify?: (message: string) => void;
  recordDisclosure?: (entry: DisclosureRecord) => void;
  /** Broker socket for the MCP handoff; started lazily when omitted. */
  handoffSocket?: string;
  /** Real Pi session id for anonymous-call dedupe (extension-owned). */
  reportingSessionId?: string;
  /** Scope object for anonymous-call dedupe when no Pi session id exists. */
  reportingScope?: object;
  /** Display surface for native web search entries (extension-owned). */
  nativeSearch?: NativeSearchSurface;
};

/** The request the transport is asked for; any change retires the session. */
export function buildRequestSignature(input: {
  modelId: string;
  effort?: string;
  systemPrompt: string;
  tools: readonly ToolDefinition[];
  nativeSearch?: boolean;
}): string {
  return requestSignature([
    input.modelId,
    input.effort ?? null,
    input.systemPrompt,
    JSON.stringify(input.tools),
    ...(input.nativeSearch === true ? ["native-search:web_search,open_url"] : []),
  ]);
}

function toToolDefinitions(tools: any[]): ToolDefinition[] {
  return tools.map((tool: Tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
}

function userMessagesToBlocks(messages: any[]): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  for (const message of messages) {
    if (message?.role !== "user") continue;
    blocks.push(...userMessageToBlocks(message));
  }
  return blocks;
}

function userMessageToBlocks(message: any): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  const content = message?.content;
  if (typeof content === "string") {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text") blocks.push({ type: "text", text: block.text });
      else if (block?.type === "image") blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  } else if (content != null) {
    try {
      blocks.push({ type: "text", text: JSON.stringify(content) });
    } catch {
      /* unserializable content */
    }
  }
  return blocks;
}

/** Tool-result content into the broker result the blocked call receives. */
export function toHandoffResult(msg: any, modelId: string): HandoffResult {
  const content: HandoffResult["content"] = [];
  const raw = msg?.content;
  if (typeof raw === "string") {
    content.push({ type: "text", text: raw });
  } else if (Array.isArray(raw)) {
    assertImageSupport(modelId, raw);
    for (const block of raw) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        content.push({ type: "image", data: block.data, mimeType: block.mimeType });
      } else {
        try {
          content.push({ type: "text", text: JSON.stringify(block) });
        } catch {
          /* unserializable block */
        }
      }
    }
  } else if (raw != null) {
    try {
      content.push({ type: "text", text: JSON.stringify(raw) });
    } catch {
      /* skip */
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return msg?.isError ? { content, isError: true } : { content };
}

function emptyMessage(model: Model<any>): any {
  const usageReport = createUnavailableUsageReport(model);
  const usageCost: any = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  usageCost.costKnown = usageReport.costKnown;
  usageCost.costBasis = usageReport.costBasis;
  return {
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
      cost: usageCost,
    },
    usageReport,
    stopReason: "stop",
  };
}

/** Stream a response from `vibe-acp` as an AssistantMessageEventStream. */
export function streamViaAcp(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string; tools?: any[] },
  options?: StreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  function failStream(error: string, reason: "error" | "aborted" = "error") {
    endStreamWithError(stream, emptyMessage(model), error, reason);
  }

  // Sessions without a Pi id (compaction / completeSimple) run on an
  // ephemeral key and are retired when the turn ends.
  const ephemeral = !options?.sessionId;
  const processKey = options?.sessionId ?? `ephemeral-${randomUUID()}`;
  let openedCli: CliProcess | undefined;

  if (options?.signal?.aborted) {
    failStream("Request aborted", "aborted");
    return stream;
  }

  async function run(): Promise<void> {
    const nativeSearch = nativeSearchEnabled();
    if (strictTransport() && nativeSearch) {
      throw new Error(
        "PI_MISTRAL_VIBE_TETHER_STRICT refuses native web search. Unset PI_MISTRAL_VIBE_TETHER_NATIVE_SEARCH; no prompt was sent.",
      );
    }
    const sessionId = options?.sessionId;
    const reportingSessionId = options?.sessionId ?? options?.reportingSessionId;
    const emit = (disclosure: Disclosure) =>
      emitDisclosure({
        sessionId: reportingSessionId,
        reportingScope: options?.reportingScope,
        ...disclosure,
        notify: options?.notify,
        recordDisclosure: options?.recordDisclosure,
      });

    // Payload hooks are a mutating boundary: apply the replacement before
    // the prompt, signature, and tool schema are built.
    let prepared = piContext(context);
    if (options?.onPayload) {
      const replacement = await options.onPayload(
        {
          system: prepared.systemPrompt,
          messages: prepared.messages,
          tools: prepared.tools,
        } as any,
        model,
      );
      if (replacement !== undefined) {
        const payload = replacement as any;
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) {
          throw new Error("before_provider_request returned an invalid payload");
        }
        prepared = piContext({
          systemPrompt: payload.systemPrompt ?? payload.system,
          messages: payload.messages,
          tools: payload.tools,
        });
      }
    }

    const systemPrompt = prepared.systemPrompt ?? "";
    const tools = toToolDefinitions(prepared.tools ?? []);
    const messages = prepared.messages as any[];

    // Effort validation: an unsupported level is a refusal, never a clamp.
    const spec = modelSpecFor(model.id);
    let effort: string | undefined;
    if (options?.reasoning !== undefined) {
      if (spec) {
        effort = effortFor(spec, options.reasoning as string);
      } else {
        throw new Error(
          `${model.id} does not offer adjustable thinking levels (fixed by vibe); omit thinking or use off.`,
        );
      }
    }

    const requestSignatureValue = buildRequestSignature({
      modelId: model.id,
      effort,
      systemPrompt,
      tools,
      nativeSearch,
    });

    // Resolve the parked session and classify this call.
    let cli: CliProcess | undefined = sessionId ? getCliProcess(sessionId) : undefined;
    let mode: "handoff" | "turn" | "spawn" = "spawn";
    let promptBlocks: PromptBlock[] = [];

    if (cli) {
      const checkpoint = cli.piHistory;
      const historyMatches =
        !!checkpoint && matchesPrefix(messages, checkpoint, historyHash);
      const reusable =
        cli.alive &&
        !cli.compactionTainted &&
        cli.requestSignature === requestSignatureValue &&
        historyMatches;
      if (reusable && sessionId) {
        const delta = messages.slice(checkpoint!.length);
        const toolResults = delta.filter((m) => m?.role === "toolResult");
        if (cli.turnInFlight && cli.hasPendingHandoffs) {
          const ids = toolResults.map((m) => String(m.toolCallId ?? ""));
          if (delta.every((m) => m?.role === "toolResult") && cli.canContinueHandoff(ids)) {
            mode = "handoff";
          }
        } else if (!cli.turnInFlight && delta.every((m) => m?.role === "user") && delta.length > 0) {
          mode = "turn";
          promptBlocks = userMessagesToBlocks(delta);
        }
      }
      if (mode === "spawn") {
        await cli.retire([cli.compactionTainted ? "compactionTainted" : "sessionMismatch"]);
        cli = undefined;
      }
    }
    const parkedExit = !cli && sessionId ? takeUnexpectedParkedExit(sessionId) : undefined;

    if (mode === "handoff") {
      // ---- 1. Pending tool-result continuation on the in-flight turn.
      // This is a continuation of an already-open ACP turn: do not re-emit
      // systemOverhead / builtinSchemas. Validate the batch, convert the
      // results and run spill disclosure inside one guarded block; any
      // throw (strict spill refusal, malformed batch, conversion fault)
      // cancels and retires the parked process without delivering anything.
      let results: Array<{ id: string; tool: string; result: HandoffResult }>;
      try {
        const toolResultMessages = messages.slice(cli!.piHistory!.length);
        results = toolResultMessages
          .filter((m) => m?.role === "toolResult")
          .map((m) => ({
            id: String(m.toolCallId ?? ""),
            tool: String(m.toolName ?? "tool"),
            result: toHandoffResult(m, model.id),
          }));
        const pendingIds = cli!.pendingHandoffIds();
        const resultIds = results.map((r) => r.id);
        if (
          results.length !== pendingIds.length ||
          !resultIds.every((id) => pendingIds.includes(id))
        ) {
          throw new Error(
            "Pi tool results do not match the blocked Vibe calls; the results were kept in Pi history and no tool was retried.",
          );
        }
        for (const { tool, result } of results) {
          for (const spill of findToolResultSpills(tool, result)) {
            emit(toolResultSpillDisclosure(spill.tool, spill.chars));
          }
        }
      } catch (error) {
        cli!.cancel();
        await cli!.retire(["strict_spill_refusal"]);
        throw error;
      }
      const delivered = cli!.deliverToolResults(
        results.map(({ id, result }) => ({ id, result })),
      );
      if (!delivered) {
        throw new Error("Vibe could not match a Pi tool result to its blocked call");
      }
    } else {
      // ---- 2. Fresh or warm prompt turn.
      let spawnPrior: any[] = [];
      if (mode === "spawn") {
        let lastNonUserIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role !== "user") {
            lastNonUserIndex = i;
            break;
          }
        }
        if (lastNonUserIndex < 0) {
          promptBlocks = userMessagesToBlocks(messages);
        } else {
          spawnPrior = messages.slice(0, lastNonUserIndex + 1);
          const trailing = messages.slice(lastNonUserIndex + 1);
          promptBlocks = [...replayPiMessages(spawnPrior), ...userMessagesToBlocks(trailing)];
        }
      }
      let imageLimitRefusal = false;
      try {
        if (mode === "spawn" && parkedExit) emit(parkedProcessExitDisclosure(parkedExit));
        for (const control of ["temperature", "maxTokens"] as const) {
          if (options?.[control] !== undefined) {
            emit(unsupportedControlDisclosure(control));
          }
        }
        emit(systemOverheadDisclosure());
        if (tools.length > 0) emit(builtinSchemasDisclosure());
        const promptImageCount = countBlockImages(promptBlocks);
        if (promptImageCount > VIBE_MAX_PROMPT_IMAGES) {
          const disclosure = imageAttachmentLimitDisclosure(promptImageCount, VIBE_MAX_PROMPT_IMAGES);
          imageLimitRefusal = true;
          emit(disclosure);
          throw new Error(disclosure.message);
        }
        if (mode === "spawn") {
          if (spawnPrior.length > 0) {
            emit(coldReplayDisclosure({ omittedThinking: hasThinkingBlocks(spawnPrior) }));
            if (hasOlderImages(messages)) emit(olderImagesDisclosure());
          }
        } else if (mode === "turn") {
          if (hasWarmImageWindowOverflow(messages)) emit(olderImagesDisclosure());
        }
        if (hasPromptBlockSeparation(promptBlocks)) {
          emit(promptBlockSeparationDisclosure());
        }
        const firstTextIndex = promptBlocks.findIndex((b) => b.type === "text");
        if (firstTextIndex >= 0) {
          const block = promptBlocks[firstTextIndex]!;
          if (block.type === "text") {
            const guarded = guardLeadingSlashCommand(block.text);
            if (guarded.matchedCommand) {
              promptBlocks = [
                ...promptBlocks.slice(0, firstTextIndex),
                { type: "text", text: guarded.text },
                ...promptBlocks.slice(firstTextIndex + 1),
              ];
              emit(slashCommandCollisionDisclosure(guarded.matchedCommand));
            }
          }
        }
      } catch (error) {
        if (cli && !imageLimitRefusal) {
          try {
            cli.cancel();
          } catch {
            /* exit handling owns the message */
          }
          await cli.retire(["strict_refusal"]);
        }
        throw error;
      }
      assertImageSupport(model.id, promptBlocks);

      if (mode === "spawn") {
        if (options?.signal?.aborted) {
          throw new Error("Request aborted");
        }
        const handoffSocket =
          tools.length > 0
            ? options?.handoffSocket ?? (await startHandoffBroker())
            : options?.handoffSocket ?? "";
        const surface = options?.nativeSearch;
        const onNativeSearch = surface
          ? (entry: NativeSearchEntry) => {
              try {
                surface.record(entry);
              } catch {
                /* a display fault must not break ACP routing */
              }
            }
          : undefined;
        cli = await CliProcess.open({
          sessionId: processKey,
          requestSignature: requestSignatureValue,
          systemPrompt,
          tools,
          handoffSocket,
          modelId: model.id,
          effort,
          signal: options?.signal,
          nativeSearch,
          onNativeSearch,
        });
      }
    }

    const live = cli!;
    openedCli = live;
    let finished = false;
    let aborted = false;
    let compactionFailed = false;
    let compactionTaintedDuringTurn = false;
    let resolveFinished!: () => void;
    const finishedPromise = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const bridge = createEventBridge(stream, model, {
      watermark: live.usageWatermark,
      onCompactionDetected: () => {
        try {
          emit(autoCompactionDisclosure());
        } catch (error) {
          compactionFailed = true;
          live.cancel();
          live.markCompactionTainted();
          throw error;
        }
        compactionTaintedDuringTurn = true;
        live.markCompactionTainted();
      },
    });

    let onAbort: (() => void) | undefined;
    const cleanupAbortListener = () => {
      if (options?.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
    };

    async function endWithDone(reason: any) {
      if (finished) return;
      finished = true;
      bridge.commitUsage();
      cleanupAbortListener();
      const output = bridge.getOutput();
      live.detach();
      if (ephemeral || compactionTaintedDuringTurn) {
        try {
          await live.retire([ephemeral ? "ephemeral" : "compactionTainted"]);
        } catch {
          /* retirement records its own status; the turn still ends */
        }
      }
      stream.push({ type: "done", reason, message: { ...output, stopReason: reason } });
      stream.end();
      resolveFinished();
    }

    async function endWithError(error: unknown, reason: "error" | "aborted", retirement: string[]) {
      if (finished) return;
      finished = true;
      bridge.commitUsage();
      cleanupAbortListener();
      try {
        bridge.finalizeBlocks();
      } catch {
        /* already closed */
      }
      const formatted = formatVibeError(error);
      const classified = classifyVibeError(error);
      if (classified.stderrDiagnostic) {
        recordStatus({ lastError: `${formatted} [untrusted vibe-acp stderr: ${classified.stderrDiagnostic}]` });
      }
      live.detach();
      try {
        await live.retire(retirement.length ? retirement : ["episodeError"]);
      } catch {
        /* retirement records its own status; the turn still ends */
      }
      const output = bridge.getOutput() as any;
      const errorContent = output.content.length
        ? output.content
        : [
            {
              type: "text" as const,
              text: `Error: ${formatted}${classified.stderrDiagnostic ? ` [untrusted vibe-acp stderr: ${classified.stderrDiagnostic}]` : ""}`,
            },
          ];
      const errorMessage = {
        ...output,
        content: errorContent,
      } as any;
      if (classified.stderrDiagnostic) errorMessage.stderrDiagnostic = classified.stderrDiagnostic;
      if (classified.kind === "signal_kill" || classified.kind === "exit") {
        errorMessage.processExit = {
          kind: classified.kind,
          code: classified.exitCode ?? null,
          signal: classified.signal ?? null,
          stderrDiagnostic: classified.stderrDiagnostic,
        };
      }
      endStreamWithError(stream, errorMessage, formatted, reason);
      resolveFinished();
    }

    const sink: EpisodeSink = {
      async onUpdate(update) {
        if (finished) return;
        try {
          bridge.handleUpdate(update);
        } catch (error) {
          await endWithError(
            aborted ? new Error("Request aborted") : error,
            aborted ? "aborted" : "error",
            ["auto_compaction"],
          );
        }
      },
      async onPromptResult(result) {
        if (finished) return;
        if (compactionFailed) {
          await endWithError(new Error("Mistral Vibe automatic compaction refusal."), "error", ["auto_compaction"]);
          return;
        }
        bridge.applyResult(result);
        bridge.commitUsage();
        live.cumulativeUsage = bridge.getCumulativeUsage();
        bridge.finalizeBlocks();
        const output = bridge.getOutput();
        if (output.stopReason === "toolUse") {
          // A handoff already claimed this episode; the Pi loop ends at toolUse.
        } else if (aborted) {
          await endWithError(new Error("Request aborted"), "aborted", ["abort"]);
          return;
        } else {
          // Claim the terminal synchronously so a concurrent close/fatal
          // cannot win while the async login check is in flight; the
          // terminal helpers re-claim in the same synchronous segment.
          finished = true;
          live.detach();
          let verifyError: unknown;
          try {
            await live.verifyLoginLink();
          } catch (error) {
            verifyError = error;
          }
          finished = false;
          if (verifyError) {
            await endWithError(verifyError, "error", ["login_link_fault"]);
            return;
          }
          if (output.stopReason === "error" || output.stopReason === "aborted") {
            await endWithError(new Error(output.errorMessage ?? `Mistral Vibe stopped with ${result.stopReason ?? output.stopReason}`), output.stopReason, [result.stopReason ?? output.stopReason]);
            return;
          }
          live.piHistory = {
            length: messages.length + 1,
            hash: historyHash([...messages, output]),
          };
          await endWithDone(output.stopReason);
          return;
        }
      },
      async onHandoffCall(invocation) {
        if (finished) return;
        if (aborted) {
          invocation.respond({
            content: [{ type: "text", text: "Pi aborted this turn; tool not executed" }],
            isError: true,
          });
          return;
        }
        bridge.pushToolCall({
          id: invocation.piCallId,
          name: invocation.name,
          arguments: invocation.arguments,
        });
        bridge.commitUsage();
        bridge.finalizeBlocks();
        live.piHistory = {
          length: messages.length + 1,
          hash: historyHash([...messages, bridge.getOutput()]),
        };
        // endWithDone claims + detaches synchronously, so attach() stops
        // after this call. Post-prompt login re-verification is authoritative
        // on onPromptResult; adding an async check here would race the
        // in-flight prompt's terminal and surface buffered calls early.
        await endWithDone("toolUse");
      },
      async onClose(code, signal) {
        if (finished) return;
        const stderr = live.stderr();
        await endWithError(new VibeProcessExitError({ code, signal, stderr }), "error", ["exit"]);
      },
      async onFatal(error) {
        if (finished) return;
        await endWithError(error, aborted ? "aborted" : "error", ["episode_error"]);
      },
    };

    live.attach(sink);

    if (mode !== "handoff") {
      assertImageSupport(model.id, promptBlocks);
      try {
        options?.signal?.throwIfAborted();
        options?.nativeSearch?.announce();
        live.sendPrompt(promptBlocks);
      } catch (error) {
        await endWithError(error, "error", ["prompt_not_sent"]);
        return;
      }
    }

    if (options?.signal) {
      onAbort = () => {
        if (finished) return;
        aborted = true;
        live.cancel();
        void endWithError(new Error("Request aborted"), "aborted", ["abort"]);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        aborted = true;
        live.cancel();
        await endWithError(new Error("Request aborted"), "aborted", ["abort"]);
        return;
      }
    }

    // Non-strict compaction that did not stop the turn: the tainted session
    // retires in the finally below once the terminal lands; a parked clean
    // session stays for the next turn.
    void finishedPromise.finally(() => {
      cleanupAbortListener();
      if (compactionTaintedDuringTurn && !finished) {
        void live.retire(["compactionTainted"]);
      }
    });

    await finishedPromise;
    cleanupAbortListener();
  }

  (async () => {
    try {
      await run();
    } catch (error) {
      if (ephemeral && openedCli) {
        await openedCli.retire(["episodeError"]);
      }
      const aborted = options?.signal?.aborted;
      const errorObj = error instanceof Error ? error : new Error(processErrorMessage(error));
      const message = aborted
        ? "Request aborted"
        : formatVibeError(errorObj);
      const classified = classifyVibeError(errorObj);
      if (classified.kind === "signal_kill" || classified.kind === "exit") {
        const canonical = sanitizeUntrustedDiagnostic(classified.message);
        const base = emptyMessage(model) as any;
        if (classified.stderrDiagnostic) {
          recordStatus({ lastError: `${canonical} [untrusted vibe-acp stderr: ${classified.stderrDiagnostic}]` });
          base.stderrDiagnostic = classified.stderrDiagnostic;
          base.content = [{ type: "text" as const, text: `Error: ${canonical} [untrusted vibe-acp stderr: ${classified.stderrDiagnostic}]` }];
        } else {
          base.content = [{ type: "text" as const, text: `Error: ${canonical}` }];
        }
        base.processExit = {
          kind: classified.kind,
          code: classified.exitCode ?? null,
          signal: classified.signal ?? null,
          stderrDiagnostic: classified.stderrDiagnostic,
        };
        endStreamWithError(stream, base, canonical, aborted ? "aborted" : "error");
        return;
      }
      if (classified.stderrDiagnostic) {
        recordStatus({ lastError: `${message} [untrusted vibe-acp stderr: ${classified.stderrDiagnostic}]` });
        const base = emptyMessage(model) as any;
        base.stderrDiagnostic = classified.stderrDiagnostic;
        base.content = [{ type: "text" as const, text: `Error: ${message} [untrusted vibe-acp stderr: ${classified.stderrDiagnostic}]` }];
        endStreamWithError(stream, base, message, aborted ? "aborted" : "error");
        return;
      }
      failStream(message, aborted ? "aborted" : "error");
    }
  })();

  return stream;
}
