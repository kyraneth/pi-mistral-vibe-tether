/**
 * Spawning and guarding the official `vibe-acp` process.
 *
 * The tether never launches the user's production configuration: it always
 * passes a private `VIBE_HOME`, deletes shell API keys from the child
 * environment, and turns client self-update and telemetry off. The only
 * thing shared with the official client is the login (src/login.ts).
 */

import spawn from "cross-spawn";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ChildProcess } from "node:child_process";

/** Executable override for tests and isolated installs. */
export const CLI_ENV = "PI_MISTRAL_VIBE_TETHER_CLI";

export function cliPathKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return (
    Object.keys(env)
      .reverse()
      .find((key) => key.toUpperCase() === "PATH") ?? "Path"
  );
}

/** Resolve the executable the child receives, without running it. */
export function resolveCli(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CLI_ENV];
  if (override) {
    accessSync(override, constants.X_OK);
    return realpathSync(override);
  }
  const windows = process.platform === "win32";
  const extensions = windows
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const directories = [
    ...(windows ? [process.cwd()] : []),
    ...(env[cliPathKey(env)] ?? "").split(windows ? ";" : delimiter),
  ];
  for (const extension of extensions) {
    for (const rawDirectory of directories) {
      const directory = /^".*"$/.test(rawDirectory)
        ? rawDirectory.slice(1, -1)
        : rawDirectory;
      const candidate = join(directory, `vibe-acp${extension}`);
      try {
        if (!windows) accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return realpathSync(candidate);
      } catch {
        // Missing, non-executable, or inaccessible: try the next PATH entry.
      }
    }
  }
  throw new Error(
    `vibe-acp CLI not found on PATH. Install the official Mistral Vibe CLI or set ${CLI_ENV}.`,
  );
}

/** Startup validation: fail loudly at load time, not on the first turn. */
export function validateCliPresence(): string {
  return resolveCli();
}

/**
 * The child environment. The shell API routes are removed so the tether runs
 * on the linked Vibe login it was asked to use, and the client's own updater,
 * telemetry, and keyring stay off (the tether never updates the official
 * client behind the user's back).
 */
export function cliEnvironment(
  vibeHome: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: { nativeSearch?: boolean },
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(next)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith("VIBE_") ||
      upper === "MISTRAL_API_KEY" ||
      upper === "MISTRAL_VIBE_API_KEY"
    ) {
      delete next[key];
    }
  }
  next.VIBE_HOME = vibeHome;
  next.VIBE_DEFAULT_APPROVAL_POLICY = "ask";
  next.VIBE_INCLUDE_PROJECT_CONTEXT = "false";
  next.VIBE_INCLUDE_COMMIT_SIGNATURE = "false";
  next.VIBE_ENABLE_SUBAGENTS = "false";
  next.VIBE_ENABLE_BACKGROUND_PROCESSES = "false";
  if (options?.nativeSearch === true) {
    next.VIBE_ENABLE_CONNECTORS = "true";
    next.VIBE_EXPERIMENTAL_ENABLE_DOCUMENT_LIBRARY_CONNECTOR = "false";
    next.VIBE_EXPERIMENTAL_ENABLE_MISTRAL_MCP_CONNECTOR = "false";
  } else {
    next.VIBE_ENABLE_CONNECTORS = "false";
  }
  next.VIBE_ENABLE_UPDATE_CHECKS = "false";
  next.VIBE_ENABLE_AUTO_UPDATE = "false";
  next.VIBE_ENABLE_TELEMETRY = "false";
  next.VIBE_TEST_DISABLE_KEYRING = "1";
  return next;
}

export interface SpawnInput {
  cwd: string;
  vibeHome: string;
  signal?: AbortSignal;
  nativeSearch?: boolean;
}

/** A live ACP session process over stdio. */
export function spawnVibeAcp(input: SpawnInput): ChildProcess {
  const proc = spawn(resolveCli(), [], {
    cwd: input.cwd,
    env: cliEnvironment(input.vibeHome, process.env, { nativeSearch: input.nativeSearch }),
    stdio: ["pipe", "pipe", "pipe"],
    signal: input.signal,
  });
  registerProcess(proc);
  if (input.signal) {
    const onAbort = () => {
      void forceKillProcess(proc);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    proc.once("exit", () => input.signal?.removeEventListener("abort", onAbort));
  }
  return proc;
}

/**
 * Handshake-only process: the same private home and environment, no prompt.
 * Used to ask the build what it advertises before Pi registers models.
 */
export function spawnAcpProbe(vibeHome: string, options?: { signal?: AbortSignal }): ChildProcess {
  const proc = spawn(resolveCli(), [], {
    cwd: vibeHome,
    env: cliEnvironment(vibeHome),
    stdio: ["pipe", "pipe", "pipe"],
    signal: options?.signal,
  });
  registerProcess(proc);
  if (options?.signal) {
    const onAbort = () => {
      void forceKillProcess(proc);
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    proc.once("exit", () => options.signal?.removeEventListener("abort", onAbort));
  }
  return proc;
}

/** Bounded stderr capture for error messages; never returned as model output. */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 16_384) buffer = buffer.slice(-16_384);
  });
  return () => buffer.trim();
}

const killTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();

export function forceKillProcess(
  proc: ChildProcess | undefined,
  graceMs = 2_000,
): Promise<void> {
  if (!proc || !proc.pid || proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    // An AbortSignal emits "error" (AbortError) while the child may still
    // be alive. Swallow that error so it neither resolves here before
    // observed exit nor throws as an unhandled "error" event.
    proc.on("error", () => {});
  });
  if (!proc.killed) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const previous = killTimers.get(proc);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, graceMs);
  timer.unref?.();
  killTimers.set(proc, timer);
  proc.once("exit", () => {
    clearTimeout(timer);
  });
  return exited;
}

const liveProcesses = new Set<ChildProcess>();
export function registerProcess(proc: ChildProcess): void {
  liveProcesses.add(proc);
  proc.once("exit", () => liveProcesses.delete(proc));
}
export async function killAllProcesses(graceMs?: number): Promise<void> {
  // The client can still write its private state after accepting SIGTERM.
  // Observe exit before allowing normal shutdown to remove the runtime directory.
  await Promise.all([...liveProcesses].map((proc) => forceKillProcess(proc, graceMs)));
}
