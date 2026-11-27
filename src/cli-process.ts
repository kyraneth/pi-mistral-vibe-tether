/**
 * One live `vibe-acp` connection that outlives a single Pi call.
 *
 * Pi owns the transcript; this connection caches the acknowledged prefix and
 * the ACP session that produced it. It stays alive:
 * - through a handoff: the transport blocks inside a Pi MCP tool call, Pi's
 *   stream ends at `toolcall_end`, and the next Pi call answers that same
 *   blocked call;
 * - between turns: after the prompt terminal the process is parked and the
 *   next user message is sent to the same ACP session.
 *
 * Exactly one episode (one Pi call) is attached at a time. Permission
 * requests are answered here, attached or not: the transport must never wait
 * on one.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { AcpClient, AcpRpcError, CLIENT_CAPABILITIES, CLIENT_INFO } from "./acp-client.js";
import {
  createSessionUsageWatermark,
  type AcpPromptResult,
  type CumulativeUsageSnapshot,
  type SessionUsageWatermark,
} from "./event-bridge.js";
import { sessionDir } from "./data-dir.js";
import {
  MCP_SERVER_NAME,
  sessionMcpServer,
  writeToolSchema,
  type AcpMcpServerStdio,
  type ToolDefinition,
} from "./mcp-config.js";
import {
  handoffSecretFile,
  registerHandoffTarget,
  unregisterHandoffTarget,
  type HandoffInvocation,
  type HandoffResult,
} from "./handoff-broker.js";
import { linkHostLogin } from "./login.js";
import { rememberOfferedModels } from "./model-discovery.js";
import {
  captureStderr,
  forceKillProcess,
  spawnAcpProbe,
  spawnVibeAcp,
} from "./process-manager.js";
import { recordStatus, type VibeAccountInfo } from "./cli-status.js";
import { sanitizeUntrustedDiagnostic, VibeProcessExitError } from "./errors.js";
import type { ParkedProcessExitInfo } from "./degradations.js";
import {
  isAuthorizedNativeSearchTool,
  isValidNativeSearchInput,
  watchNativeSearch,
  type NativeSearchEntry,
  type NativeSearchWatcher,
} from "./native-search.js";
import type { PromptBlock } from "./pi-context.js";
import { stageSessionVibeHome } from "./vibe-config.js";
import { removeTreeSync, runtimeDir } from "./runtime-dir.js";
import { stageProbeVibeHome } from "./vibe-config.js";

const VIBE_BUILTINS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit",
  "bash",
  "grep",
  "glob",
  "web_fetch",
  "skill",
  "task",
  "run_typescript",
  "search_tool_functions",
]);

function sanitizeToolName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

/**
 * Authorize a transport tool request only when it names a Pi-declared tool
 * on the `pi` MCP server. Built-ins and undeclared names are denied even
 * when they happen to appear in the declared set.
 */
export function isAuthorizedPiTool(
  toolName: string | undefined,
  declaredNames: ReadonlySet<string>,
): boolean {
  if (!toolName) return false;
  if (VIBE_BUILTINS.has(toolName)) return false;
  for (const name of declaredNames) {
    const sanitized = sanitizeToolName(name);
    if (
      toolName === `mcp_pi.${name}` ||
      toolName === `mcp_pi.${sanitized}` ||
      toolName === `pi_${name}` ||
      toolName === `pi.${name}` ||
      toolName === `pi_${sanitized}`
    ) {
      return true;
    }
  }
  return false;
}

/** What an attached episode receives. */
export interface EpisodeSink {
  onUpdate(update: any): void | Promise<void>;
  /** The ACP prompt terminal (`{stopReason, usage}`). */
  onPromptResult(result: AcpPromptResult): void | Promise<void>;
  onHandoffCall(invocation: HandoffInvocation): void | Promise<void>;
  onClose(code: number | null, signal: NodeJS.Signals | null): void | Promise<void>;
  onFatal(error: unknown): void | Promise<void>;
}

function isLoginFault(error: unknown): boolean {
  return error instanceof Error && error.message.includes("STOP, retain the private config");
}

export interface OpenInput {
  /** Pi session id: keys the pool, the staged home, and the tool schema. */
  sessionId: string;
  requestSignature: string;
  systemPrompt: string;
  tools: readonly ToolDefinition[];
  handoffSocket: string;
  modelId: string;
  effort?: string;
  signal?: AbortSignal;
  nativeSearch?: boolean;
  onNativeSearch?: (entry: NativeSearchEntry) => void;
}

const parked = new Map<string, CliProcess>();
const live = new Set<CliProcess>();
const pendingRetires = new Set<Promise<void>>();
const unexpectedParkedExits = new Map<string, ParkedProcessExitInfo>();

export function takeUnexpectedParkedExit(sessionId: string): ParkedProcessExitInfo | undefined {
  const info = unexpectedParkedExits.get(sessionId);
  if (info !== undefined) unexpectedParkedExits.delete(sessionId);
  return info;
}

export function getCliProcess(sessionId: string): CliProcess | undefined {
  return parked.get(sessionId);
}

export function activeCliProcessCount(): number {
  let count = 0;
  for (const cli of live) {
    if (!cli.retired) count += 1;
  }
  for (const cli of parked.values()) {
    if (!cli.retired && !live.has(cli)) count += 1;
  }
  return count;
}

export async function retireCliProcess(
  sessionId: string,
  reason: string,
): Promise<void> {
  unexpectedParkedExits.delete(sessionId);
  const cli = parked.get(sessionId);
  if (!cli) return;
  parked.delete(sessionId);
  await cli.retire([reason]);
}

export async function retireAllCliProcesses(reason: string): Promise<void> {
  const entries = [...parked.entries()];
  parked.clear();
  unexpectedParkedExits.clear();
  const toRetire = new Set<CliProcess>([...live]);
  for (const [, cli] of entries) toRetire.add(cli);
  await Promise.all([...toRetire].map((cli) => cli.retire([reason])));
  await Promise.all([...pendingRetires]);
}

export class CliProcess {
  readonly piSessionId: string;
  readonly requestSignature: string;
  /** Acknowledged history prefix on this ACP session. */
  piHistory: { length: number; hash: string } | undefined;
  /** Session-cumulative usage watermark shared across broker episodes. */
  readonly usageWatermark: SessionUsageWatermark = createSessionUsageWatermark();
  get cumulativeUsage(): CumulativeUsageSnapshot {
    return this.usageWatermark.current();
  }
  set cumulativeUsage(next: CumulativeUsageSnapshot) {
    this.usageWatermark.advance(next);
  }
  compactionTainted = false;
  retired = false;
  /** ACP session id (the transport's own handle). */
  acpSessionId = "";
  readonly sessionKey: string;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;

  private sink: EpisodeSink | undefined;
  private promptInFlight = false;
  private handoffs: HandoffInvocation[] = [];
  private pending = new Map<string, HandoffInvocation>();
  /** Tool calls actually delivered to Pi via sink.onHandoffCall. */
  private surfacedIds = new Set<string>();
  private readonly toolNamesByCallId = new Map<string, string>();
  private readonly toolInputsByCallId = new Map<string, unknown>();
  private readonly toolMetaByCallId = new Map<string, unknown>();
  private readonly nativeSearchEnabled: boolean;
  private readonly onNativeSearch: ((entry: NativeSearchEntry) => void) | undefined;
  private nativeSearchWatcher: NativeSearchWatcher | undefined;
  private readonly getStderr: () => string;
  private readonly declaredNames: ReadonlySet<string>;
  readonly incarnationRoot: string;
  readonly vibeHome: string;
  private readonly verifyLogin: (() => Promise<unknown>) | undefined;
  private retiring: Promise<void> | undefined;
  private readonly statusControllers = new Set<AbortController>();

  private constructor(
    readonly proc: ChildProcess,
    private readonly client: AcpClient,
    private readonly input: OpenInput,
    private readonly toolsPath: string | undefined,
    private readonly sessionKeyInit: string,
    getStderr: () => string,
    extra: { incarnationRoot: string; vibeHome: string; verifyLogin: (() => Promise<unknown>) | undefined },
  ) {
    this.piSessionId = input.sessionId;
    this.requestSignature = input.requestSignature;
    this.sessionKey = sessionKeyInit;
    this.getStderr = getStderr;
    this.nativeSearchEnabled = input.nativeSearch === true;
    this.onNativeSearch = input.onNativeSearch;
    this.declaredNames = new Set(input.tools.map((tool) => tool.name));
    this.incarnationRoot = extra.incarnationRoot;
    this.vibeHome = extra.vibeHome;
    this.verifyLogin = extra.verifyLogin;
  }

  static async open(input: OpenInput): Promise<CliProcess> {
    // Setup-scoped abort: do not pass input.signal directly to spawnVibeAcp,
    // where process-manager would listen for the entire parked lifetime.
    const setupAbort = new AbortController();
    const forwardSetupAbort = () => setupAbort.abort();
    if (input.signal) {
      if (input.signal.aborted) setupAbort.abort();
      else input.signal.addEventListener("abort", forwardSetupAbort, { once: true });
    }
    try {
      return await CliProcess.openSetup(input, setupAbort.signal);
    } finally {
      if (input.signal) input.signal.removeEventListener("abort", forwardSetupAbort);
    }
  }

  private static async openSetup(input: OpenInput, setupSignal: AbortSignal): Promise<CliProcess> {
    const piSessionId = input.sessionId;
    const acpKey = randomUUID();
    const incarnationRoot = join(sessionDir(piSessionId), acpKey);
    const vibeHome = join(incarnationRoot, "vibe-home");
    const workspace = join(vibeHome, "workspace");
    input.signal?.throwIfAborted();

    let verifyLogin: (() => Promise<unknown>) | undefined;
    let toolsPath: string | undefined;
    let mcpServer: AcpMcpServerStdio | undefined;

    try {
      // 1-3: stage the private home, link the login, stage the tool schema.
      await stageSessionVibeHome({
        sessionId: piSessionId,
        systemPrompt: input.systemPrompt,
        hasTools: input.tools.length > 0,
        activeModel: input.modelId,
        vibeHome,
        toolNames: input.tools.map((t) => t.name),
        nativeSearch: input.nativeSearch,
      });
      verifyLogin = await linkHostLogin(vibeHome);
      if (input.tools.length > 0) {
        toolsPath = writeToolSchema(piSessionId, input.tools, incarnationRoot);
        mcpServer = sessionMcpServer({
          toolsPath,
          socketPath: input.handoffSocket,
          sessionId: acpKey,
          secretPath: handoffSecretFile(),
        });
      }
    } catch (error) {
      if (!isLoginFault(error)) {
        try {
          removeTreeSync(incarnationRoot);
        } catch {
          /* already gone */
        }
      }
      throw error;
    }

    let proc: ChildProcess;
    try {
      input.signal?.throwIfAborted();
      proc = spawnVibeAcp({
        cwd: workspace,
        vibeHome,
        signal: setupSignal,
        nativeSearch: input.nativeSearch,
      });
    } catch (error) {
      if (!isLoginFault(error)) {
        try {
          removeTreeSync(incarnationRoot);
        } catch {
          /* already gone */
        }
      }
      throw error;
    }
    const getStderr = captureStderr(proc);

    let instance: CliProcess | undefined;
    const client = new AcpClient(proc, {
      onUpdate(update, params) {
        if (params?.sessionId && instance?.acpSessionId && params.sessionId !== instance.acpSessionId) return;
        // Track toolCallId -> toolName/input for the permission boundary.
        if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
          const callId =
            update.toolCallId ?? update.id ?? update.callId;
          const name =
            update._meta?.tool_name ?? update.rawInput?.tool_name ?? update.tool_name;
          if (typeof callId === "string" && callId) {
            instance?.noteToolFrame(callId, name, update.rawInput ?? update.input, update._meta);
          }
        }
        instance?.routeUpdate(update);
      },
      onPermissionRequest(params) {
        return instance?.decidePermission(params) ?? { outcome: "denied" as const };
      },
      onDiagnostic() {},
    });

    try {
      // 7: initialize.
      const initialized = await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      }, { signal: input.signal });
      const agentVersion =
        typeof initialized?.agentInfo?.version === "string"
          ? initialized.agentInfo.version
          : "unknown";
      const agentName =
        typeof initialized?.agentInfo?.name === "string"
          ? initialized.agentInfo.name
          : "vibe-acp";
      recordStatus({ agentVersion, agentName });

      // 8: session/new.
      const opened = await client.request("session/new", {
        cwd: workspace,
        mcpServers: mcpServer ? [mcpServer] : [],
        // The staged agent profile already restricts the tool surface; never
        // ask the transport to disable its built-ins (it cannot honor it).
      }, { signal: input.signal });
      const acpSessionId = String(opened?.sessionId ?? "");
      if (!acpSessionId) throw new Error("vibe-acp session/new returned no sessionId");
      const configOptions: any[] = Array.isArray(opened?.configOptions)
        ? opened.configOptions
        : [];
      let currentConfigOptions: any[] = configOptions;
      let lastKnownOptions: any[] = configOptions;
      let settledConfigOptions: any[] | undefined = undefined;

      const findOption = (id: string) =>
        lastKnownOptions.find((option) => option?.id === id);
      const setConfig = async (configId: string, value: string) => {
        settledConfigOptions = undefined;
        const answered = await client.request("session/set_config_option", {
          sessionId: acpSessionId,
          configId,
          value,
        }, { signal: input.signal });
        if (Array.isArray(answered?.configOptions)) {
          lastKnownOptions = answered.configOptions;
          settledConfigOptions = answered.configOptions;
          currentConfigOptions = answered.configOptions;
        }
      };

      // 9: approval mode and agent. Track observations for settled proof.
      // Vibe 3.1.5: session/set_mode("ask") returns {} (SetSessionModeResponse
      // in vibe/acp/agent.py:1132-1140), while every set_config_option
      // returns configOptions including mode (vibe/acp/agent.py:1797-1808).
      // An empty set_mode response is therefore legitimate; settled proof
      // comes from the final configOptions below.
      const modes = opened?.modes;
      const availableModes: any[] = Array.isArray(modes?.availableModes)
        ? modes.availableModes
        : Array.isArray(opened?.availableModes)
          ? opened.availableModes
          : [];
      const currentModeId =
        (typeof modes?.currentModeId === "string" ? modes.currentModeId : undefined) ??
        (typeof opened?.currentModeId === "string" ? opened.currentModeId : undefined);
      if (availableModes.length > 0) {
        const offersAsk = availableModes.some(
          (mode) => mode?.id === "ask" || mode === "ask",
        );
        if (!offersAsk) {
          throw new Error('vibe-acp does not offer approval mode "ask"');
        }
      }
      if (currentModeId !== "ask" || (availableModes.length > 0 && currentModeId !== "ask")) {
        settledConfigOptions = undefined;
        const modeResponse = await client.request("session/set_mode", {
          sessionId: acpSessionId,
          modeId: "ask",
        }, { signal: input.signal });
        const responseMode =
          (typeof modeResponse?.modes?.currentModeId === "string" ? modeResponse.modes.currentModeId : undefined) ??
          (typeof modeResponse?.currentModeId === "string" ? modeResponse.currentModeId : undefined) ??
          (typeof modeResponse?.modeId === "string" ? modeResponse.modeId : undefined) ??
          (typeof modeResponse?.modes?.modeId === "string" ? modeResponse.modes.modeId : undefined);
        if (responseMode !== undefined && responseMode !== "ask") {
          throw new Error(
            `vibe-acp did not adopt approval mode "ask" (readback ${JSON.stringify(responseMode ?? "missing")})`,
          );
        }
      }
      {
        const modeOption = findOption("mode");
        if (modeOption && modeOption.currentValue !== "ask") {
          await setConfig("mode", "ask");
        }
      }
      {
        const agentOption = findOption("agent");
        if (agentOption && agentOption.currentValue !== "pi") {
          await setConfig("agent", "pi");
        }
      }

      // 11: the requested model, preserving AcpRpcError provenance.
      try {
        await setConfig("model", input.modelId);
      } catch (error) {
        if (error instanceof AcpRpcError) {
          throw new AcpRpcError(`vibe-acp refused model ${input.modelId}: ${sanitizeUntrustedDiagnostic(error.message)}`, { code: error.code, data: error.data, method: error.method });
        }
        throw new Error(
          `vibe-acp refused model ${input.modelId}: ${sanitizeUntrustedDiagnostic(error instanceof Error ? error.message : String(error))}`,
          { cause: error },
        );
      }

      // 12: the requested effort.
      if (input.effort !== undefined) {
        try {
          await setConfig("thinking", input.effort);
        } catch (error) {
          if (error instanceof AcpRpcError) {
            throw new AcpRpcError(`vibe-acp refused thinking level ${input.effort}: ${sanitizeUntrustedDiagnostic(error.message)}`, { code: error.code, data: error.data, method: error.method });
          }
          throw new Error(
            `vibe-acp refused thinking level ${input.effort}: ${sanitizeUntrustedDiagnostic(error instanceof Error ? error.message : String(error))}`,
            { cause: error },
          );
        }
      }

      // FINAL SETTLED VERIFICATION after ALL set_mode / set_config_option
      // calls (model and thinking included). Required selectors must EXIST
      // with the requested values; absence is never confirmation.
      if (settledConfigOptions === undefined) {
        throw new Error("vibe-acp did not return a fresh post-write configOptions snapshot");
      }
      const settledSnapshot: any[] = settledConfigOptions as any[];
      const settledModeOption = settledSnapshot.find((option: any) => option?.id === "mode");
      if (!settledModeOption || settledModeOption.currentValue !== "ask") {
        throw new Error(
          `vibe-acp did not confirm approval mode "ask" (readback ${JSON.stringify(settledModeOption?.currentValue ?? "missing")})`,
        );
      }
      const settledAgentOption = settledSnapshot.find((option: any) => option?.id === "agent");
      if (!settledAgentOption || settledAgentOption.currentValue !== "pi") {
        throw new Error(
          `vibe-acp did not adopt the pi agent (readback ${JSON.stringify(settledAgentOption?.currentValue ?? "missing")})`,
        );
      }
      const settledModelOption = settledSnapshot.find(
        (option: any) => option?.id === "model",
      ) as any;
      if (!settledModelOption || settledModelOption.currentValue !== input.modelId) {
        throw new Error(
          `vibe-acp did not confirm model ${input.modelId} (readback ${JSON.stringify(settledModelOption?.currentValue ?? "missing")})`,
        );
      }
      if (input.effort !== undefined) {
        const settledThinkingOption = settledSnapshot.find(
          (option: any) => option?.id === "thinking",
        ) as any;
        if (!settledThinkingOption || settledThinkingOption.currentValue !== input.effort) {
          throw new Error(
            `vibe-acp did not confirm thinking level ${input.effort} (readback ${JSON.stringify(settledThinkingOption?.currentValue ?? "missing")})`,
          );
        }
        if (Array.isArray(settledThinkingOption.options) && settledThinkingOption.options.length > 0) {
          const offered: string[] = settledThinkingOption.options
            .map((option: any) => option?.value)
            .filter((value: unknown): value is string => typeof value === "string");
          if (!offered.includes(input.effort)) {
            throw new Error(
              `vibe-acp did not confirm thinking level ${input.effort} (readback ${JSON.stringify(settledThinkingOption.currentValue ?? "missing")})`,
            );
          }
        }
      }

      currentConfigOptions = settledSnapshot;

      // Remember the catalog only after model (and thinking) selection: a
      // cold session/new may list only built-ins, while selecting a model
      // can fetch the full remote catalog.
      const offeredModels = rememberOfferedModels(currentConfigOptions, { authority: "partial" });
      recordStatus({
        offeredModels: offeredModels.map((spec) => spec.id),
        configured: { model: input.modelId, effort: input.effort ?? "unset" },
      });

      // 13: the linked credential is still intact by metadata only.
      if (verifyLogin) await verifyLogin();
      input.signal?.throwIfAborted();
      if (proc.signalCode) {
        throw new VibeProcessExitError({ code: proc.exitCode, signal: proc.signalCode, stderr: getStderr() });
      }
      if (proc.exitCode !== null) {
        throw new VibeProcessExitError({ code: proc.exitCode, signal: proc.signalCode ?? null, stderr: getStderr() });
      }

      instance = new CliProcess(proc, client, input, toolsPath, acpKey, getStderr, { incarnationRoot, vibeHome, verifyLogin });
      instance.acpSessionId = acpSessionId;
      if (instance.nativeSearchEnabled) {
        instance.nativeSearchWatcher = watchNativeSearch((entry) => {
          instance?.onNativeSearch?.(entry);
        });
      }
      live.add(instance);
      parked.set(piSessionId, instance);
      if (mcpServer) {
        registerHandoffTarget(
          acpKey,
          instance,
          input.tools.map((tool) => tool.name),
        );
      }
      recordStatus({ loginLinked: true });
      proc.once("exit", (code, signal) => instance?.handleExit(code, signal));
      return instance;
    } catch (error) {
      try {
        client.dispose();
      } catch {
        /* already disposed */
      }
      await forceKillProcess(proc);
      if (!isLoginFault(error)) {
        try {
          removeTreeSync(incarnationRoot);
        } catch {
          /* already gone */
        }
      }
      throw error;
    }
  }

  get alive(): boolean {
    return !this.retired && this.exitCode === null && this.exitSignal === null;
  }

  get hasPendingHandoffs(): boolean {
    return this.pending.size > 0;
  }

  get turnInFlight(): boolean {
    return this.promptInFlight;
  }

  /** Acknowledged prefix under the name the provider checks. */
  get ackedHistory(): { length: number; hash: string } | undefined {
    return this.piHistory;
  }

  set ackedHistory(value: { length: number; hash: string } | undefined) {
    this.piHistory = value;
  }

  stderr(): string {
    return this.getStderr();
  }

  async verifyLoginLink(): Promise<void> {
    if (this.verifyLogin) await this.verifyLogin();
  }

  noteToolName(toolCallId: string, toolName: string): void {
    this.toolNamesByCallId.set(toolCallId, toolName);
  }

  noteToolFrame(
    toolCallId: string,
    toolName: unknown,
    input: unknown,
    meta: unknown,
  ): void {
    if (typeof toolName === "string" && toolName) {
      this.toolNamesByCallId.set(toolCallId, toolName);
    }
    if (input !== undefined) this.toolInputsByCallId.set(toolCallId, input);
    if (meta !== undefined) this.toolMetaByCallId.set(toolCallId, meta);
  }

  markCompactionTainted(): void {
    this.compactionTainted = true;
  }

  pendingHandoffIds(): string[] {
    return this.surfacedIds.size > 0
      ? [...this.surfacedIds]
      : [...this.pending.keys()];
  }

  canContinueHandoff(ids: string[]): boolean {
    return (
      ids.length > 0 &&
      ids.length === this.surfacedIds.size &&
      ids.every((id) => this.surfacedIds.has(id) && this.pending.has(id))
    );
  }

  decidePermission(params: any): { outcome: "allowed" | "denied" } {
    if (this.retired) return { outcome: "denied" };
    const toolCall = params?.toolCall ?? {};
    const callId: string | undefined =
      typeof toolCall.toolCallId === "string"
        ? toolCall.toolCallId
        : typeof params?.toolCallId === "string"
          ? params.toolCallId
          : undefined;
    // Declared Pi tools accept the identifier-only wire shape stock Vibe
    // 3.1.5 can send (a ToolCallUpdate carrying only the tool_call_id):
    // the call id itself names the declared tool. Native web search uses
    // the strict lookup below and must never fall back to the call id,
    // or an identifier-only frame could spoof a web tool.
    const piToolName =
      (callId ? this.toolNamesByCallId.get(callId) : undefined) ??
      toolCall._meta?.tool_name ??
      toolCall.toolCallId;
    if (isAuthorizedPiTool(piToolName, this.declaredNames)) {
      return { outcome: "allowed" };
    }
    if (this.nativeSearchEnabled) {
      const observedName =
        (callId ? this.toolNamesByCallId.get(callId) : undefined) ??
        toolCall._meta?.tool_name;
      const observedInput =
        (callId ? this.toolInputsByCallId.get(callId) : undefined) ??
        toolCall.rawInput ??
        toolCall.input;
      const observedMeta =
        (callId ? this.toolMetaByCallId.get(callId) : undefined) ??
        toolCall._meta;
      if (
        isAuthorizedNativeSearchTool(observedName) &&
        isValidNativeSearchInput(observedName, observedInput, observedMeta)
      ) {
        return { outcome: "allowed" };
      }
    }
    return { outcome: "denied" };
  }

  attach(sink: EpisodeSink): void {
    this.sink = sink;
    while (this.sink === sink && this.handoffs.length > 0) {
      const call = this.handoffs.shift()!;
      this.surfacedIds.add(call.piCallId);
      sink.onHandoffCall(call);
    }
  }

  detach(): void {
    this.sink = undefined;
  }

  private routeUpdate(update: any): void {
    if (!this.retired) {
      this.nativeSearchWatcher?.handleUpdate(update, this.acpSessionId);
    }
    this.sink?.onUpdate(update);
  }

  /** Broker callback: a Pi tool call is blocked and waiting for Pi. */
  onHandoffCall(invocation: HandoffInvocation): void {
    if (!this.alive || !this.promptInFlight) {
      invocation.respond({
        content: [{ type: "text", text: "Pi is not accepting tool calls; tool not executed" }],
        isError: true,
      });
      return;
    }
    this.pending.set(invocation.piCallId, invocation);
    if (this.sink) {
      this.surfacedIds.add(invocation.piCallId);
      this.sink.onHandoffCall(invocation);
    } else this.handoffs.push(invocation);
  }

  /**
   * Answer blocked MCP calls with Pi's tool results. Whole-batch: nothing is
   * delivered unless every id matches a pending call exactly.
   */
  deliverToolResults(
    results: Array<{ id: string; result: HandoffResult }>,
  ): boolean {
    const expected =
      this.surfacedIds.size > 0
        ? this.surfacedIds
        : new Set(this.pending.keys());
    if (results.length === 0 || results.length !== expected.size) return false;
    if (!results.every(({ id }) => expected.has(id) && this.pending.has(id))) return false;
    for (const { id, result } of results) {
      const call = this.pending.get(id);
      if (!call) return false;
      this.pending.delete(id);
      this.surfacedIds.delete(id);
      call.respond(result);
    }
    return true;
  }

  sendPrompt(blocks: PromptBlock[]): void {
    if (this.promptInFlight) {
      throw new Error("vibe-acp session already has a prompt in flight");
    }
    this.promptInFlight = true;
    this.client
      .request("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: blocks,
      })
      .then((result: AcpPromptResult) => {
        this.promptInFlight = false;
        if (this.retired) return;
        this.sink?.onPromptResult(result ?? {});
      })
      .catch((error: unknown) => {
        this.promptInFlight = false;
        if (this.retired) return;
        this.sink?.onFatal(error);
      });
  }

  cancel(): void {
    if (!this.alive) return;
    try {
      this.client.notify("session/cancel", { sessionId: this.acpSessionId });
    } catch {
      /* the process is already gone; exit handling owns the message */
    }
    this.nativeSearchWatcher?.flushIncomplete(this.acpSessionId, "cancelled");
  }

  /** Read account and identity on this live connection. */
  async readAccountStatus(options?: { signal?: AbortSignal }): Promise<VibeAccountInfo> {
    const opAbort = new AbortController();
    this.statusControllers.add(opAbort);
    const forwardAbort = () => opAbort.abort();
    if (options?.signal) {
      if (options.signal.aborted) opAbort.abort();
      else options.signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const accountReq = this.client.request("_account/read", {}, { signal: opAbort.signal });
    const identityReq = this.client.request("_identity/read", {}, { signal: opAbort.signal });
    accountReq.catch(() => {});
    identityReq.catch(() => {});
    try {
      const [account, identity] = await Promise.all([accountReq, identityReq]);
      const info = parseAccountInfo(account, identity);
      recordStatus({ account: info });
      return info;
    } finally {
      opAbort.abort();
      this.statusControllers.delete(opAbort);
      if (options?.signal) options.signal.removeEventListener("abort", forwardAbort);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.exitSignal = signal;
    for (const controller of this.statusControllers) {
      try { controller.abort(); } catch { /* already settled */ }
    }
    this.statusControllers.clear();
    try {
      (this.client as unknown as { dispose?: (r?: string) => void }).dispose?.(
        "vibe-acp exited",
      );
    } catch {
      /* already disposed */
    }
    live.delete(this);
    unregisterHandoffTarget(this.sessionKey);
    if (parked.get(this.piSessionId) === this) parked.delete(this.piSessionId);
    if (this.retired) return;
    this.nativeSearchWatcher?.flushIncomplete(this.acpSessionId, "failed");
    for (const [, call] of this.pending) {
      call.respond({
        content: [{ type: "text", text: "vibe-acp exited before Pi answered this tool call" }],
        isError: true,
      });
    }
    this.pending.clear();
    this.surfacedIds.clear();
    if (this.sink) {
      this.sink.onClose(code, signal);
    } else {
      unexpectedParkedExits.set(this.piSessionId, { code, signal, stderr: this.stderr() });
      void this.retire(["exit"]);
    }
  }

  async retire(reasons: string[] = []): Promise<void> {
    if (this.retiring) return this.retiring;
    const retiring = (async () => {
      this.retired = true;
      this.nativeSearchWatcher?.flushIncomplete(this.acpSessionId, "cancelled");
      recordStatus({ lastRetirement: reasons });
      live.delete(this);
      if (parked.get(this.piSessionId) === this) parked.delete(this.piSessionId);
      unregisterHandoffTarget(this.sessionKey);
      for (const controller of this.statusControllers) {
        try { controller.abort(); } catch { /* already settled */ }
      }
      this.statusControllers.clear();
      try {
        (this.client as unknown as { dispose?: (r?: string) => void }).dispose?.(
          "vibe-acp tether session retired",
        );
      } catch {
        /* already disposed */
      }
      // Observe the child exit before answering blocked MCP calls: a
      // retired session must never deliver a tool result (strict spill
      // refusal relies on this), and answering first could let the old
      // child log a result after retirement was decided.
      await forceKillProcess(this.proc);
      for (const [, call] of this.pending) {
        call.respond({
          content: [
            {
              type: "text",
              text: "Pi tether retired the session before answering this tool call",
            },
          ],
          isError: true,
        });
      }
      this.pending.clear();
      this.surfacedIds.clear();
      const rootExists = await stat(this.incarnationRoot).then(() => true).catch(() => false);
      if (rootExists) {
        try {
          if (this.verifyLogin) await this.verifyLogin();
        } catch (error) {
          recordStatus({ lastError: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
      try {
        removeTreeSync(this.incarnationRoot);
      } catch {
        /* already gone */
      }
    })();
    this.retiring = retiring;
    pendingRetires.add(retiring);
    void retiring.finally(() => pendingRetires.delete(retiring));
    return retiring;
  }
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/** Merge the account and identity replies into one readout. */
function parseAccountInfo(account: any, identity: any): VibeAccountInfo {
  const plan = account?.plan ?? identity?.plan ?? {};
  const budget = account?.budget ?? identity?.budget ?? {};
  return {
    planName: pickString(plan?.name, account?.planName, identity?.planName),
    planTitle: pickString(plan?.title, account?.planTitle, identity?.planTitle),
    usagePercentage: pickNumber(
      budget?.usagePercentage,
      budget?.usage_percentage,
      account?.usagePercentage,
      account?.usage_percentage,
    ),
    resetAt: pickString(budget?.resetAt, budget?.reset_at, account?.resetAt),
    paygEnabled: pickBoolean(
      budget?.paygEnabled,
      budget?.payg_enabled,
      account?.paygEnabled,
      account?.payg_enabled,
    ),
    keyScope: pickString(
      account?.keyScope,
      account?.key_scope,
      identity?.keyScope,
      identity?.key_scope,
    ),
    accessScope: pickString(
      account?.accessScope,
      account?.access_scope,
      identity?.accessScope,
      identity?.access_scope,
    ),
    workspace: pickString(identity?.workspace, account?.workspace),
    organization: pickString(identity?.organization, account?.organization),
  };
}

/**
 * Read the Vibe account and budget on an existing connection, or on a
 * short-lived probe that links the host login by reference (metadata only)
 * and never reads credential bytes. Records the readout and returns it.
 */
export async function queryVibeAccountStatus(options?: { signal?: AbortSignal }): Promise<VibeAccountInfo> {
  const open = [...live, ...parked.values()].find((cli) => cli.alive);
  if (open) return open.readAccountStatus({ signal: options?.signal });

  const probeHome = join(runtimeDir(), `account-probe-${randomUUID().slice(0, 8)}`);
  let verifyLogin: (() => Promise<unknown>) | undefined;
  let proc: ChildProcess | undefined;
  let client: AcpClient | undefined;
  let loginFaulted = false;
  try {
    options?.signal?.throwIfAborted();
    await stageProbeVibeHome(probeHome);
    verifyLogin = await linkHostLogin(probeHome);
    proc = spawnAcpProbe(probeHome, { signal: options?.signal });
    client = new AcpClient(proc, {
      onUpdate() {},
      onPermissionRequest: () => ({ outcome: "denied" as const }),
      onDiagnostic() {},
    });
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    }, { signal: options?.signal });
    const opAbort = new AbortController();
    const forwardProbeAbort = () => opAbort.abort();
    if (options?.signal) {
      if (options.signal.aborted) opAbort.abort();
      else options.signal.addEventListener("abort", forwardProbeAbort, { once: true });
    }
    let account: any;
    let identity: any;
    try {
      const accountReq = client.request("_account/read", {}, { signal: opAbort.signal });
      const identityReq = client.request("_identity/read", {}, { signal: opAbort.signal });
      accountReq.catch(() => {});
      identityReq.catch(() => {});
      [account, identity] = await Promise.all([accountReq, identityReq]);
    } finally {
      opAbort.abort();
      if (options?.signal) options.signal.removeEventListener("abort", forwardProbeAbort);
    }
    try {
      if (verifyLogin) await verifyLogin();
    } catch (error) {
      loginFaulted = true;
      throw error;
    }
    const info = parseAccountInfo(account, identity);
    recordStatus({ account: info, loginLinked: true });
    return info;
  } catch (error) {
    if (isLoginFault(error)) loginFaulted = true;
    throw error;
  } finally {
    try { client?.dispose(); } catch { /* already disposed */ }
    await forceKillProcess(proc);
    if (!loginFaulted) {
      try {
        removeTreeSync(probeHome);
      } catch {
        /* already gone */
      }
    }
  }
}
