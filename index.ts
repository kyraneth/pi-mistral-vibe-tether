/**
 * Pi extension entry point for pi-mistral-vibe-tether.
 *
 * Registers a custom provider that routes LLM calls through Mistral's
 * official `vibe-acp` server (ACP / JSON-RPC over stdio), and gives vibe
 * Pi's tools through the handoff broker so Pi remains the only tool
 * executor and history owner.
 */

import { registerApiDispatch } from "pi-tether-core/register";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamViaAcp } from "./src/provider.js";
import { setVibeCatalog, vibeModels } from "./src/catalog.js";
import { adoptCatalogModels, cachedOrFallbackCatalog, probeStartup } from "./src/model-discovery.js";
import { cliStatusLine, recordStatus } from "./src/cli-status.js";
import { addStartupNotice, takeStartupNotices } from "./src/startup-notices.js";
import { killAllProcesses, validateCliPresence } from "./src/process-manager.js";
import { stopHandoffBroker } from "./src/handoff-broker.js";
import { cleanupRuntimeDir } from "./src/runtime-dir.js";
import { queryVibeAccountStatus, retireAllCliProcesses } from "./src/cli-process.js";
import { rewriteOverflowMessage } from "./src/overflow.js";

import { PROVIDER_ID } from "./src/event-bridge.js";
import { DISCLOSURE_ENTRY_TYPE, rememberDisclosure, strictTransport } from "./src/degradations.js";
import { Text } from "@earendil-works/pi-tui";
import {
  NATIVE_SEARCH_ENTRY,
  NATIVE_SEARCH_NOTICE,
  NATIVE_SEARCH_NOTICE_ENTRY,
  nativeSearchEnabled,
  nativeSearchLabel,
  type NativeSearchEntry,
  type NativeSearchSurface,
} from "./src/native-search.js";

// Graceful observed-exit shutdown happens in session_shutdown / beforeExit;
// abrupt process-exit cleanup here is best-effort only (the process may not
// observe children or complete async removal after exit).
process.on("exit", () => {
  void killAllProcesses();
});
process.on("exit", () => {
  void stopHandoffBroker();
});
process.on("exit", cleanupRuntimeDir);
process.on("beforeExit", () => {
  void retireAllCliProcesses("beforeExit");
});

/** Deliver load-time configuration notices where the user can see them. */
function notifyPi(
  ctx: { hasUI: boolean; ui: { notify: (message: string, type: "warning") => void } } | undefined,
  message: string,
): void {
  if (ctx?.hasUI) ctx.ui.notify(`pi-mistral-vibe-tether: ${message}`, "warning");
  else console.warn(`[pi-mistral-vibe-tether] ${message}`);
}

export default function (pi: ExtensionAPI) {
  let notify: (message: string) => void = (message) => notifyPi(undefined, message);
  let recordDisclosure: ((entry: any) => void) | undefined;
  let activePiSessionId: string | undefined;
  let activeStatusAbort: AbortController | undefined;
  let activeNativeSurface: NativeSearchSurface | undefined;
  const nativeAnnouncedSessions = new Set<string>();

  if (nativeSearchEnabled() && !strictTransport()) {
    pi.registerEntryRenderer(NATIVE_SEARCH_NOTICE_ENTRY, (entry: any) => {
      const notice =
        entry?.data && typeof entry.data.notice === "string"
          ? entry.data.notice
          : NATIVE_SEARCH_NOTICE;
      return new Text(notice, 1, 0);
    });
    pi.registerEntryRenderer(NATIVE_SEARCH_ENTRY, (entry: any) => {
      const data = (entry?.data ?? entry) as NativeSearchEntry | undefined;
      return new Text(data ? nativeSearchLabel(data) : "", 1, 0);
    });
  }

  pi.on("session_start", (_event, ctx) => {
    activeStatusAbort?.abort();
    notify = (message) => notifyPi(ctx, message);
    const sessionId = ctx.sessionManager.getSessionId();
    activePiSessionId = sessionId;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== DISCLOSURE_ENTRY_TYPE) continue;
      const data = entry.data as ({ sessionId?: string; key?: string; surface?: string } | undefined);
      if (data?.surface === "log") continue;
      if (data?.sessionId === sessionId && typeof data.key === "string") {
        rememberDisclosure(sessionId, data.key);
      }
    }
    recordDisclosure = (entry) => pi.appendEntry(DISCLOSURE_ENTRY_TYPE, { ...entry, sessionId });
    if (nativeSearchEnabled() && !strictTransport()) {
      const alreadyNoticed = ctx.sessionManager
        .getEntries()
        .some(
          (entry: any) =>
            entry.type === "custom" &&
            entry.customType === NATIVE_SEARCH_NOTICE_ENTRY &&
            (entry.data as { sessionId?: string } | undefined)?.sessionId === sessionId,
        );
      if (alreadyNoticed) nativeAnnouncedSessions.add(sessionId);
      const hasUI = (ctx as any)?.hasUI === true;
      const surface: NativeSearchSurface = {
        announce: () => {
          if (activeNativeSurface !== surface) return;
          if (nativeAnnouncedSessions.has(sessionId)) return;
          nativeAnnouncedSessions.add(sessionId);
          pi.appendEntry(NATIVE_SEARCH_NOTICE_ENTRY, {
            sessionId,
            notice: NATIVE_SEARCH_NOTICE,
          });
          if (!hasUI) {
            console.warn(`[pi-mistral-vibe-tether] ${NATIVE_SEARCH_NOTICE}`);
          }
        },
        record: (entry) => {
          if (activeNativeSurface !== surface) return;
          pi.appendEntry(NATIVE_SEARCH_ENTRY, entry);
          if (!hasUI) {
            console.warn(`[pi-mistral-vibe-tether] ${nativeSearchLabel(entry)}`);
          }
        },
      };
      activeNativeSurface = surface;
    } else {
      activeNativeSurface = undefined;
    }
    const modelProvider =
      (ctx as any)?.model?.provider ?? (_event as any)?.model?.provider ?? (ctx as any)?.selectedModel?.provider;
    if (modelProvider === PROVIDER_ID) {
      for (const message of takeStartupNotices()) notify(message);
    }
  });

  // Non-Mistral Pi startup must never wait on Vibe: load cached/fallback
  // models synchronously, register immediately without spawning vibe-acp.
  const initial = cachedOrFallbackCatalog();
  setVibeCatalog(initial.models);

  try {
    const binary = validateCliPresence();
    recordStatus({ binary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordStatus({ lastError: message });
    addStartupNotice(message);
  }

  const streamFn = (
    model: Parameters<typeof streamViaAcp>[0],
    context: Parameters<typeof streamViaAcp>[1],
    options?: Parameters<typeof streamViaAcp>[2],
  ) => {
    for (const message of takeStartupNotices()) notify(message);
    return streamViaAcp(model, context, {
      ...options,
      notify,
      recordDisclosure,
      reportingSessionId: options?.sessionId ?? activePiSessionId,
      nativeSearch: activeNativeSurface,
    });
  };

  // Pi's provider catalog and its legacy api dispatch are separate
  // registries; print mode and nested agent loops take the second one.
  registerApiDispatch(PROVIDER_ID, streamFn);

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "pi-mistral-vibe-tether",
    apiKey: "unused",
    api: PROVIDER_ID as any,
    models: vibeModels({ images: true }),
    streamSimple: streamFn as any,
    async refreshModels(context: any) {
      if (!context?.allowNetwork) return vibeModels({ images: true });
      const probed = await probeStartup(true, { signal: context.signal });
      if (probed.models.length > 0) {
        adoptCatalogModels(probed.models, { authority: probed.authority });
      }
      return vibeModels({ images: probed.image ?? true });
    },
  } as any);

  // Pi's own overflow recovery needs its recognized prefix.
  (pi.on as any)("message_end", (event: any, ctx: any) =>
    rewriteOverflowMessage(event?.message ?? {}, PROVIDER_ID, ctx?.model?.provider),
  );

  // Pi's cache refresher would send a real extra turn through vibe; decline
  // refreshes for this provider only (other providers keep their decision).
  pi.on("cache_warming_decision", (_event, ctx) => {
    if (ctx.model?.provider === PROVIDER_ID) return { action: "stop" as const };
  });

  pi.registerCommand("vibe-status", {
    description:
      "Show the Vibe account and budget readout: client version, active model, plan, usage and reset",
    handler: async (_args, ctx) => {
      activeStatusAbort?.abort();
      const controller = new AbortController();
      activeStatusAbort = controller;
      const incomingSignal = (ctx as any)?.signal as AbortSignal | undefined;
      const forwardAbort = () => controller.abort();
      if (incomingSignal) {
        if (incomingSignal.aborted) controller.abort();
        else incomingSignal.addEventListener("abort", forwardAbort, { once: true });
      }
      try {
        await queryVibeAccountStatus({ signal: controller.signal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-mistral-vibe-tether: vibe status unavailable: ${message}`, "error");
        return;
      } finally {
        controller.abort();
        if (incomingSignal) incomingSignal.removeEventListener("abort", forwardAbort);
        if (activeStatusAbort === controller) activeStatusAbort = undefined;
      }
      for (const message of takeStartupNotices()) {
        ctx.ui.notify(`pi-mistral-vibe-tether: ${message}`, "warning");
      }
      ctx.ui.notify(cliStatusLine(), "info");
    },
  });

  const retire = async (event: { type: string }) => {
    activeStatusAbort?.abort();
    await retireAllCliProcesses(event.type);
  };
  pi.on("session_start", async (event: { type: string }) => {
    activeStatusAbort?.abort();
    await retire(event);
  });
  pi.on("model_select", async (event: any, ctx: any) => {
    await retire(event);
    const provider = event?.model?.provider ?? event?.provider ?? ctx?.model?.provider;
    if (provider === PROVIDER_ID) {
      for (const message of takeStartupNotices()) notify(message);
    }
  });
  pi.on("session_compact", retire);
  pi.on("session_tree", retire);
  pi.on("session_shutdown", async (event: { type: string }) => {
    activeStatusAbort?.abort();
    await retire(event);
    await killAllProcesses();
    await stopHandoffBroker();
  });
}
