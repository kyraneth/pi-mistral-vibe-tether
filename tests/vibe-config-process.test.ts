import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  removeSessionVibeHome,
  stageProbeVibeHome,
  stageSessionVibeHome,
} from "../src/vibe-config.js";
import {
  CLI_ENV,
  captureStderr,
  cliEnvironment,
  forceKillProcess,
  killAllProcesses,
  registerProcess,
  resolveCli,
  spawnAcpProbe,
  spawnVibeAcp,
  validateCliPresence,
} from "../src/process-manager.js";
import { cleanupRuntimeDir, resetRuntimeDirForTests, runtimeDir } from "../src/runtime-dir.js";

const tempDirs: string[] = [];

function track(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function freshDir(prefix: string): string {
  return track(mkdtempSync(join(tmpdir(), prefix)));
}

afterEach(async () => {
  cleanupRuntimeDir();
  resetRuntimeDirForTests();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort test cleanup */
    }
  }
});

describe("session vibe home staging", () => {
  it("stages a private home with an exact prompt, agent profile, and config", async () => {
    const prompt = "You are Pi.\nKeep this exact text, including  trailing spaces.  \n";
    const home = await stageSessionVibeHome({
      sessionId: "sess-tools",
      systemPrompt: prompt,
      hasTools: true,
    });
    expect(home.startsWith(runtimeDir())).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "workspace")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "agents")).isDirectory()).toBe(true);
    expect(statSync(join(home, "prompts")).isDirectory()).toBe(true);

    expect(readFileSync(join(home, "prompts", "pi.md"), "utf8")).toBe(prompt);

    const agent = readFileSync(join(home, "agents", "pi.toml"), "utf8");
    expect(agent).toContain('display_name = "Pi"');
    expect(agent).toContain('description = "Pi-driven session"');
    expect(agent).toContain('system_prompt_id = "pi"');
    expect(agent).toContain('enabled_tools = ["pi_*"]');
    expect(agent).not.toContain("disabled_tools");

    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain('default_agent = "pi"');
    expect(config).toContain('default_approval_policy = "ask"');
    expect(config).toContain("include_project_context = false");
    expect(config).toContain("include_commit_signature = false");
    expect(config).toContain("enable_subagents = false");
    expect(config).toContain("enable_background_processes = false");
    expect(config).toContain("enable_connectors = false");
    expect(config).toContain("enable_mcp = true");
    expect(config).toContain("enable_update_checks = false");
    expect(config).toContain("enable_auto_update = false");
    expect(config).toContain("enable_telemetry = false");
    expect(config).toContain('enabled_tools = ["pi_*"]');
    expect(config).not.toContain("active_model");
    expect(config).toContain("[session_logging]");
    expect(config).toContain("generate_titles = false");
  });

  it("appends the programmatic MCP routing note when tool names are given", async () => {
    const prompt = "You are Pi.";
    const home = await stageSessionVibeHome({
      sessionId: "sess-routing",
      systemPrompt: prompt,
      hasTools: true,
      toolNames: ["read", "edit", "bash"],
    });
    const note = "[Tool transport note: Vibe's built-in direct tools (read_file, write_file, edit, bash, grep, glob, web_fetch, skill) are disabled in this session. Every Pi tool is mounted on the `mcp_pi` programmatic MCP namespace and must be invoked via `run_typescript` as `await tools.mcp_pi.<name>(args)` (use `search_tool_functions` with query \"mcp_pi\" to inspect parameter schemas). Available Pi tools: read, edit, bash.]";
    const staged = readFileSync(join(home, "prompts", "pi.md"), "utf8");
    expect(staged).toBe(`${prompt}\n\n${note}`);
    expect(staged.startsWith(prompt)).toBe(true);
  });

  it("keeps the prompt byte-for-byte without tool names or when tools are disabled", async () => {
    const prompt = "Exact prompt bytes.\nWith a trailing newline and spaces.  \n";
    const noNames = await stageSessionVibeHome({
      sessionId: "sess-no-names",
      systemPrompt: prompt,
      hasTools: true,
    });
    expect(readFileSync(join(noNames, "prompts", "pi.md"), "utf8")).toBe(prompt);
    const disabled = await stageSessionVibeHome({
      sessionId: "sess-disabled",
      systemPrompt: prompt,
      hasTools: false,
      toolNames: ["read", "edit"],
    });
    expect(readFileSync(join(disabled, "prompts", "pi.md"), "utf8")).toBe(prompt);
    const emptyNames = await stageSessionVibeHome({
      sessionId: "sess-empty-names",
      systemPrompt: prompt,
      hasTools: true,
      toolNames: [],
    });
    expect(readFileSync(join(emptyNames, "prompts", "pi.md"), "utf8")).toBe(prompt);
  });

  it("disables tools and MCP for a tool-less session", async () => {
    const home = await stageSessionVibeHome({
      sessionId: "sess-quiet",
      systemPrompt: "Prompt",
      hasTools: false,
    });
    const agent = readFileSync(join(home, "agents", "pi.toml"), "utf8");
    expect(agent).toContain('disabled_tools = ["*"]');
    expect(agent).not.toContain("enabled_tools");

    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain("enable_mcp = false");
    expect(config).toContain('disabled_tools = ["*"]');
    expect(config).not.toContain("enabled_tools");
  });

  it("records the active model when provided", async () => {
    const home = await stageSessionVibeHome({
      sessionId: "sess-model",
      systemPrompt: "Prompt",
      hasTools: true,
      activeModel: "mistral-large-4-0",
    });
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain('active_model = "mistral-large-4-0"');
  });

  it("keeps the workspace empty so project files stay invisible", async () => {
    const home = await stageSessionVibeHome({
      sessionId: "sess-empty",
      systemPrompt: "Prompt",
      hasTools: true,
    });
    expect(readdirSync(join(home, "workspace"))).toEqual([]);
  });

  it("re-staging replaces the previous profile instead of appending", async () => {
    await stageSessionVibeHome({ sessionId: "sess-again", systemPrompt: "first", hasTools: false });
    const home = await stageSessionVibeHome({ sessionId: "sess-again", systemPrompt: "second", hasTools: true });
    expect(readFileSync(join(home, "prompts", "pi.md"), "utf8")).toBe("second");
    expect(readFileSync(join(home, "agents", "pi.toml"), "utf8")).toContain('enabled_tools = ["pi_*"]');
  });

  it("removes the staged home", async () => {
    await stageSessionVibeHome({ sessionId: "sess-gone", systemPrompt: "Prompt", hasTools: true });
    await removeSessionVibeHome("sess-gone");
    expect(readdirSync(runtimeDir()).filter((entry) => entry.includes("sess-gone"))).toEqual([]);
    await expect(removeSessionVibeHome("sess-gone")).resolves.toBeUndefined();
  });

  it("isolates different sessions from each other", async () => {
    const first = await stageSessionVibeHome({ sessionId: "sess-a", systemPrompt: "A", hasTools: true });
    const second = await stageSessionVibeHome({ sessionId: "sess-b", systemPrompt: "B", hasTools: false });
    expect(first).not.toBe(second);
    expect(readFileSync(join(first, "prompts", "pi.md"), "utf8")).toBe("A");
    expect(readFileSync(join(second, "prompts", "pi.md"), "utf8")).toBe("B");
  });
});

describe("probe vibe home staging", () => {
  it("stages a quiet probe home without prompts or tools", async () => {
    const dir = freshDir("t-probe-");
    await stageProbeVibeHome(dir);
    const config = readFileSync(join(dir, "config.toml"), "utf8");
    expect(config).toContain("enable_mcp = false");
    expect(config).toContain('disabled_tools = ["*"]');
    expect(config).toContain("enable_update_checks = false");
    expect(config).toContain("enable_auto_update = false");
    expect(config).toContain("enable_telemetry = false");
    expect(existsSync(join(dir, "prompts"))).toBe(false);
    expect(readdirSync(join(dir, "workspace"))).toEqual([]);
  });
});

describe("CLI resolution", () => {
  function fakeCli(prefix: string): string {
    const dir = freshDir(prefix);
    const bin = join(dir, "vibe-acp");
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.on(\"SIGTERM\", () => process.exit(0));\nprocess.stdin.resume();\nconsole.log(\"ready\");\n");
    chmodSync(bin, 0o755);
    return bin;
  }

  it("exposes the executable override knob", () => {
    expect(CLI_ENV).toBe("PI_MISTRAL_VIBE_TETHER_CLI");
  });

  it("resolves the override without executing it", () => {
    const bin = fakeCli("t-cli-");
    process.env[CLI_ENV] = bin;
    expect(resolveCli()).toBe(bin);
    expect(validateCliPresence()).toBe(bin);
  });

  it("finds the executable on PATH", () => {
    const bin = fakeCli("t-bin-");
    process.env[CLI_ENV] = "";
    const savedPath = process.env.PATH;
    process.env.PATH = `${dirname(bin)}${process.env.PATH ? `:${savedPath}` : ""}`;
    try {
      expect(resolveCli()).toBe(bin);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("fails loudly when no executable is available", () => {
    delete process.env[CLI_ENV];
    const empty = freshDir("t-empty-bin-");
    const savedPath = process.env.PATH;
    process.env.PATH = empty;
    try {
      expect(() => resolveCli()).toThrow("vibe-acp");
      expect(() => resolveCli()).toThrow(CLI_ENV);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("child environment", () => {
  it("strips shell API keys and pins the private home", () => {
    const parent = {
      ...process.env,
      MISTRAL_API_KEY: "shell-key",
      MISTRAL_VIBE_API_KEY: "shell-vibe-key",
      KEEP_ME: "kept",
    };
    const env = cliEnvironment("/private/vibe-home", parent);
    expect(env.MISTRAL_API_KEY).toBeUndefined();
    expect(env.MISTRAL_VIBE_API_KEY).toBeUndefined();
    expect(env.VIBE_HOME).toBe("/private/vibe-home");
    expect(env.VIBE_ENABLE_UPDATE_CHECKS).toBe("false");
    expect(env.VIBE_ENABLE_AUTO_UPDATE).toBe("false");
    expect(env.VIBE_ENABLE_TELEMETRY).toBe("false");
    expect(env.VIBE_TEST_DISABLE_KEYRING).toBe("1");
    expect(env.KEEP_ME).toBe("kept");
  });

  it("does not mutate the caller's environment", () => {
    const parent = { MISTRAL_API_KEY: "shell-key", PATH: "/usr/bin" };
    cliEnvironment("/private/vibe-home", parent);
    expect(parent.MISTRAL_API_KEY).toBe("shell-key");
    expect((parent as Record<string, unknown>).VIBE_HOME).toBeUndefined();
  });

  it("strips inherited Vibe settings case-insensitively and pins the safe values", () => {
    const parent = {
      ...process.env,
      MISTRAL_API_KEY: "leak",
      mistral_api_key: "leak",
      mistral_vibe_api_key: "leak",
      VIBE_ENABLE_CONNECTORS: "true",
      vibe_include_project_context: "true",
      VIBE_DEFAULT_APPROVAL_POLICY: "auto",
      VIBE_CUSTOM_OVERRIDE: "1",
      VIBE_HOME: "/inherited-home",
      KEEP_ME: "kept",
    };
    const env = cliEnvironment("/private/vibe-home", parent);
    expect(env.VIBE_HOME).toBe("/private/vibe-home");
    expect(env.VIBE_DEFAULT_APPROVAL_POLICY).toBe("ask");
    expect(env.VIBE_INCLUDE_PROJECT_CONTEXT).toBe("false");
    expect(env.VIBE_INCLUDE_COMMIT_SIGNATURE).toBe("false");
    expect(env.VIBE_ENABLE_SUBAGENTS).toBe("false");
    expect(env.VIBE_ENABLE_BACKGROUND_PROCESSES).toBe("false");
    expect(env.VIBE_ENABLE_CONNECTORS).toBe("false");
    expect(env.VIBE_ENABLE_UPDATE_CHECKS).toBe("false");
    expect(env.VIBE_ENABLE_AUTO_UPDATE).toBe("false");
    expect(env.VIBE_ENABLE_TELEMETRY).toBe("false");
    expect(env.VIBE_TEST_DISABLE_KEYRING).toBe("1");
    expect(env.MISTRAL_API_KEY).toBeUndefined();
    expect(env.mistral_api_key).toBeUndefined();
    expect(env.MISTRAL_VIBE_API_KEY).toBeUndefined();
    expect(env.mistral_vibe_api_key).toBeUndefined();
    expect(env.VIBE_CUSTOM_OVERRIDE).toBeUndefined();
    expect(env.vibe_include_project_context).toBeUndefined();
    const vibeKeys = Object.keys(env)
      .filter((key) => key.toUpperCase().startsWith("VIBE_"))
      .sort();
    expect(vibeKeys).toEqual(
      [
        "VIBE_HOME",
        "VIBE_DEFAULT_APPROVAL_POLICY",
        "VIBE_INCLUDE_PROJECT_CONTEXT",
        "VIBE_INCLUDE_COMMIT_SIGNATURE",
        "VIBE_ENABLE_SUBAGENTS",
        "VIBE_ENABLE_BACKGROUND_PROCESSES",
        "VIBE_ENABLE_CONNECTORS",
        "VIBE_ENABLE_UPDATE_CHECKS",
        "VIBE_ENABLE_AUTO_UPDATE",
        "VIBE_ENABLE_TELEMETRY",
        "VIBE_TEST_DISABLE_KEYRING",
      ].sort(),
    );
    expect(env.KEEP_ME).toBe("kept");
  });
});

describe("process lifecycle", () => {
  function installFakeCli(): string {
    const dir = freshDir("t-fake-");
    const bin = join(dir, "vibe-acp");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        "process.on(\"SIGTERM\", () => process.exit(0));",
        "process.stdin.resume();",
        "console.log(\"ready\");",
        "process.stderr.write(\"diag-line\\n\");",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    process.env[CLI_ENV] = bin;
    return bin;
  }

  it("spawns a session process with a private home and captures stderr", async () => {
    installFakeCli();
    const vibeHome = freshDir("t-vibe-proc-");
    const cwd = freshDir("t-cwd-");
    const proc = spawnVibeAcp({ cwd, vibeHome });
    const exited = once(proc, "exit");
    const readStderr = captureStderr(proc);
    try {
      await once(proc.stdout!, "data");
      await once(proc.stderr!, "data");
      expect(readStderr()).toContain("diag-line");
      forceKillProcess(proc);
      const [code, signal] = (await exited) as [number | null, string | null];
      expect(code !== null || signal !== null).toBe(true);
      expect(proc.killed).toBe(true);
    } finally {
      await exited;
    }
  });

  it("spawns a probe process with the same private environment", async () => {
    installFakeCli();
    const vibeHome = freshDir("t-vibe-probe-");
    const proc = spawnAcpProbe(vibeHome);
    const exited = once(proc, "exit");
    try {
      await once(proc.stdout!, "data");
      forceKillProcess(proc);
      await exited;
      expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    } finally {
      await exited;
    }
  });

  it("waits for vendor shutdown before allowing runtime cleanup", async () => {
    installFakeCli();
    const vibeHome = freshDir("t-vibe-kill-");
    const cwd = freshDir("t-cwd-kill-");
    const proc = spawnVibeAcp({ cwd, vibeHome });
    const exited = once(proc, "exit");
    try {
      await once(proc.stdout!, "data");
      registerProcess(proc);
      await killAllProcesses();
      expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    } finally {
      await exited;
    }
  });

  it("ignores kill requests for already-exited processes", async () => {
    installFakeCli();
    const vibeHome = freshDir("t-vibe-gone-");
    const cwd = freshDir("t-cwd-gone-");
    const proc = spawnVibeAcp({ cwd, vibeHome });
    const exited = once(proc, "exit");
    await once(proc.stdout!, "data");
    forceKillProcess(proc);
    await exited;
    expect(() => forceKillProcess(proc)).not.toThrow();
    expect(() => forceKillProcess(undefined)).not.toThrow();
  });

  it("pins effective settings at the real child boundary", async () => {
    const dir = freshDir("t-env-boundary-");
    const bin = join(dir, "vibe-acp");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        "process.stdout.write(JSON.stringify(process.env) + \"\\n\");",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    const savedEnv = { ...process.env };
    process.env[CLI_ENV] = bin;
    process.env.VIBE_ENABLE_CONNECTORS = "true";
    process.env.vibe_include_project_context = "true";
    process.env.VIBE_DEFAULT_APPROVAL_POLICY = "auto";
    process.env.VIBE_CUSTOM_OVERRIDE = "1";
    process.env.MISTRAL_API_KEY = "leak";
    process.env.mistral_vibe_api_key = "leak";
    const vibeHome = freshDir("t-vibe-env-");
    const cwd = freshDir("t-cwd-env-");
    let proc: ReturnType<typeof spawnVibeAcp> | undefined;
    try {
      proc = spawnVibeAcp({ cwd, vibeHome });
      proc.on("error", () => {});
      const [line] = (await once(proc.stdout!, "data")) as [Buffer];
      const actual = JSON.parse(String(line)) as Record<string, string>;
      expect(actual.VIBE_HOME).toBe(vibeHome);
      expect(actual.VIBE_DEFAULT_APPROVAL_POLICY).toBe("ask");
      expect(actual.VIBE_INCLUDE_PROJECT_CONTEXT).toBe("false");
      expect(actual.VIBE_INCLUDE_COMMIT_SIGNATURE).toBe("false");
      expect(actual.VIBE_ENABLE_SUBAGENTS).toBe("false");
      expect(actual.VIBE_ENABLE_BACKGROUND_PROCESSES).toBe("false");
      expect(actual.VIBE_ENABLE_CONNECTORS).toBe("false");
      expect(actual.VIBE_ENABLE_UPDATE_CHECKS).toBe("false");
      expect(actual.VIBE_ENABLE_AUTO_UPDATE).toBe("false");
      expect(actual.VIBE_ENABLE_TELEMETRY).toBe("false");
      expect(actual.VIBE_TEST_DISABLE_KEYRING).toBe("1");
      expect(actual.VIBE_CUSTOM_OVERRIDE).toBeUndefined();
      expect(actual.vibe_include_project_context).toBeUndefined();
      expect(actual.MISTRAL_API_KEY).toBeUndefined();
      expect(actual.mistral_vibe_api_key).toBeUndefined();
      const vibeKeys = Object.keys(actual)
        .filter((key) => key.toUpperCase().startsWith("VIBE_"))
        .sort();
      expect(vibeKeys).toEqual(
        [
          "VIBE_HOME",
          "VIBE_DEFAULT_APPROVAL_POLICY",
          "VIBE_INCLUDE_PROJECT_CONTEXT",
          "VIBE_INCLUDE_COMMIT_SIGNATURE",
          "VIBE_ENABLE_SUBAGENTS",
          "VIBE_ENABLE_BACKGROUND_PROCESSES",
          "VIBE_ENABLE_CONNECTORS",
          "VIBE_ENABLE_UPDATE_CHECKS",
          "VIBE_ENABLE_AUTO_UPDATE",
          "VIBE_ENABLE_TELEMETRY",
          "VIBE_TEST_DISABLE_KEYRING",
        ].sort(),
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value !== undefined) process.env[key] = value;
      }
      if (proc) {
        const exited = once(proc, "exit").catch(() => []);
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        await exited;
      }
    }
  });

  function installTrappingCli(prefix: string): string {
    const dir = freshDir(prefix);
    const bin = join(dir, "vibe-acp");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        "process.on(\"SIGTERM\", () => { process.stdout.write(\"TERM ignored\\n\"); });",
        "process.stdin.resume();",
        "process.stdout.write(\"READY\\n\");",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    process.env[CLI_ENV] = bin;
    return bin;
  }

  it("escalates to SIGKILL when abort leaves a SIGTERM-trapping child alive", async () => {
    installTrappingCli("t-fake-trap-");
    const vibeHome = freshDir("t-vibe-trap-");
    const cwd = freshDir("t-cwd-trap-");
    const abort = new AbortController();
    const proc = spawnVibeAcp({ cwd, vibeHome, signal: abort.signal });
    proc.on("error", () => {});
    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
    });
    try {
      const [ready] = (await once(proc.stdout!, "data")) as [Buffer];
      expect(String(ready)).toContain("READY");
      const ignored = once(proc.stdout!, "data");
      abort.abort();
      const [line] = (await ignored) as [Buffer];
      expect(String(line)).toContain("TERM ignored");
      expect(proc.killed).toBe(true);
      expect(proc.exitCode).toBe(null);
      expect(proc.signalCode).toBe(null);
      const spy = vi.spyOn(globalThis, "setTimeout");
      try {
        let resolved = false;
        const killing = forceKillProcess(proc, 120).then(() => {
          resolved = true;
        });
        expect(spy).toHaveBeenCalled();
        // Red-first: an AbortError emitted while the SIGTERM-trapping child
        // is still alive must not resolve the kill before observed exit.
        proc.emit("error", new Error("AbortError"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(proc.exitCode).toBe(null);
        expect(proc.signalCode).toBe(null);
        expect(resolved).toBe(false);
        await killing;
        expect(resolved).toBe(true);
      } finally {
        spy.mockRestore();
      }
      expect(proc.signalCode).toBe("SIGKILL");
      expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await exited;
    }
  });

  it("waits for observed exit when killing a SIGTERM-ignoring child", async () => {
    installTrappingCli("t-fake-ignore-");
    const vibeHome = freshDir("t-vibe-ignore-");
    const cwd = freshDir("t-cwd-ignore-");
    const proc = spawnVibeAcp({ cwd, vibeHome });
    proc.on("error", () => {});
    const exited = once(proc, "exit");
    try {
      await once(proc.stdout!, "data");
      registerProcess(proc);
      await killAllProcesses();
      expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
      expect(proc.signalCode).toBe("SIGKILL");
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await exited;
    }
  });
});
