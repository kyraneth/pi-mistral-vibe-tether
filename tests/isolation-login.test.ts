import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RUNTIME_FILE_MODE,
  cleanupRuntimeDir,
  existingRuntimeDir,
  removeTreeSync,
  resetRuntimeDirForTests,
  runtimeDir,
  runtimeFile,
} from "../src/runtime-dir.js";
import {
  DATA_DIR_ENV,
  SOURCE_VIBE_HOME_ENV,
  catalogCachePath,
  existingSessionDir,
  hostCatalogCachePath,
  hostLoginPath,
  hostVibeHomePath,
  sessionDir,
  sessionVibeHome,
  sessionWorkspaceDir,
  tetherDataDir,
} from "../src/data-dir.js";
import {
  linkHostLogin,
  resetLoginFaultForTests,
} from "../src/login.js";

const tempDirs: string[] = [];

function track(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function freshDir(prefix: string): string {
  return track(mkdtempSync(join(tmpdir(), prefix)));
}

afterEach(() => {
  cleanupRuntimeDir();
  resetRuntimeDirForTests();
  resetLoginFaultForTests();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort test cleanup */
    }
  }
});

describe("runtime directory", () => {
  it("is private and owned by this process", () => {
    const dir = runtimeDir();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(() => statSync(dir)).not.toThrow();
  });

  it("returns the same directory across calls", () => {
    expect(runtimeDir()).toBe(runtimeDir());
    expect(existingRuntimeDir()).toBe(runtimeDir());
  });

  it("honours the explicit runtime base override", () => {
    const base = freshDir("t-rt-base-");
    process.env.PI_MISTRAL_VIBE_TETHER_RUNTIME_DIR = base;
    resetRuntimeDirForTests();
    expect(runtimeDir().startsWith(join(base, "pi-mistral-vibe-"))).toBe(true);
    expect(statSync(runtimeDir()).mode & 0o777).toBe(0o700);
  });

  it("falls back to the system temporary directory", () => {
    delete process.env.PI_MISTRAL_VIBE_TETHER_RUNTIME_DIR;
    resetRuntimeDirForTests();
    const dir = runtimeDir();
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("names files inside the private directory", () => {
    expect(dirname(runtimeFile("handoff.sock"))).toBe(runtimeDir());
    expect(runtimeFile("catalog-cache.json")).toBe(join(runtimeDir(), "catalog-cache.json"));
  });

  it("cleans up so the next lookup is fresh", () => {
    const dir = runtimeDir();
    cleanupRuntimeDir();
    expect(existsSync(dir)).toBe(false);
    expect(existingRuntimeDir()).toBeUndefined();
    const next = runtimeDir();
    expect(next.startsWith(dir)).toBe(false);
    expect(existsSync(next)).toBe(true);
  });

  it("removes read-only trees without touching symlink targets", () => {
    const dir = runtimeDir();
    const frozen = join(dir, "frozen");
    const inner = join(frozen, "inner");
    mkdirSync(inner, { recursive: true });
    const frozenFile = join(inner, "locked.txt");
    writeFileSync(frozenFile, "locked");
    chmodSync(frozenFile, 0o400);
    const externalDir = freshDir("t-external-");
    const externalFile = join(externalDir, "external.txt");
    writeFileSync(externalFile, "external-contents");
    chmodSync(externalFile, 0o640);
    const beforeMode = statSync(externalFile).mode & 0o777;
    symlinkSync(externalFile, join(inner, "link-to-external"));
    chmodSync(inner, 0o500);
    chmodSync(frozen, 0o500);
    cleanupRuntimeDir();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(externalFile)).toBe(true);
    expect(readFileSync(externalFile, "utf8")).toBe("external-contents");
    expect(statSync(externalFile).mode & 0o777).toBe(beforeMode);
  });

  it("does not mutate the mode of a file also held outside the retired tree", () => {
    const outsideDir = freshDir("t-outside-");
    const outside = join(outsideDir, "outside.txt");
    writeFileSync(outside, "inert fixture");
    chmodSync(outside, 0o644);
    const tree = freshDir("t-locked-tree-");
    linkSync(outside, join(tree, "alias.txt"));
    chmodSync(tree, 0o500);
    removeTreeSync(tree);
    expect(existsSync(tree)).toBe(false);
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  });

  it("uses a restrictive file mode for secrets", () => {
    expect(RUNTIME_FILE_MODE).toBe(0o600);
  });
});

describe("tether data directory", () => {
  it("honours the data dir override", () => {
    expect(tetherDataDir()).toBe(process.env[DATA_DIR_ENV]);
  });

  it("falls back under the pi agent home", () => {
    delete process.env[DATA_DIR_ENV];
    expect(tetherDataDir()).toBe(join(homedir(), ".pi", "agent", "mistral-vibe-tether"));
  });

  it("resolves the official CLI state home", () => {
    expect(hostVibeHomePath()).toBe(process.env[SOURCE_VIBE_HOME_ENV]);
    delete process.env[SOURCE_VIBE_HOME_ENV];
    expect(hostVibeHomePath()).toBe(join(homedir(), ".vibe"));
  });

  it("points at the official login file and catalog cache it never reads", () => {
    expect(hostLoginPath()).toBe(join(hostVibeHomePath(), ".env"));
    expect(hostCatalogCachePath()).toBe(join(hostVibeHomePath(), "model_catalog_cache.json"));
  });

  it("keeps the discovered catalog cache inside the private home", () => {
    expect(catalogCachePath()).toBe(join(tetherDataDir(), "catalog-cache.json"));
    expect(catalogCachePath().startsWith(tetherDataDir())).toBe(true);
  });
});

describe("per-session paths", () => {
  it("are distinct per session and inside the runtime directory", () => {
    const one = sessionDir("sess-1");
    const two = sessionDir("sess-2");
    expect(one).not.toBe(two);
    expect(one.startsWith(runtimeDir())).toBe(true);
    expect(two.startsWith(runtimeDir())).toBe(true);
  });

  it("stage the VIBE_HOME and workspace beneath the session directory", () => {
    const home = sessionVibeHome("sess-1");
    expect(home.startsWith(sessionDir("sess-1"))).toBe(true);
    expect(sessionWorkspaceDir("sess-1")).toBe(join(home, "workspace"));
  });

  it("reduce hostile session ids to safe segments", () => {
    const hostile = sessionDir("../../etc/passwd");
    expect(dirname(hostile)).toBe(join(runtimeDir(), "sessions"));
    expect(hostile.endsWith(".._.._etc_passwd")).toBe(true);
    expect(hostile.includes("/etc")).toBe(false);
    expect(sessionDir("a/b:c").startsWith(runtimeDir())).toBe(true);
  });

  it("map dot-only session ids to a neutral segment", () => {
    expect(sessionDir(".")).toContain(`${join("", "sessions", "session")}`);
    expect(sessionDir("..")).toContain(`${join("", "sessions", "session")}`);
  });

  it("resolve the existing staging path without allocating a runtime directory", () => {
    expect(existingSessionDir("sess-1")).toBeUndefined();
    const allocated = sessionDir("sess-1");
    expect(existingSessionDir("sess-1")).toBe(allocated);
  });
});

describe("stat-only login handoff", () => {
  function arrangeHostLogin(): { hostHome: string; vibeHome: string } {
    const hostHome = freshDir("t-host-");
    process.env[SOURCE_VIBE_HOME_ENV] = hostHome;
    writeFileSync(join(hostHome, ".env"), "VIBE_TOKEN=placeholder\n");
    const vibeHome = freshDir("t-vibe-");
    return { hostHome, vibeHome };
  }

  it("links the host login into the private home and verifies by metadata", async () => {
    const { hostHome, vibeHome } = arrangeHostLogin();
    const verify = await linkHostLogin(vibeHome);
    const link = join(vibeHome, ".env");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(hostHome, ".env"));

    const result = await verify();
    expect(result.before.inode).toBe(String(statSync(join(hostHome, ".env")).ino));
    expect(result.after.inode).toBe(result.before.inode);
    expect(result.after.size).toBe(result.before.size);
    expect(result.realMetadataChanged).toBe(false);
    expect(result.symlinkIntact).toBe(true);
  });

  it("reports a host-side refresh as a metadata change, not a reopened link", async () => {
    const { hostHome, vibeHome } = arrangeHostLogin();
    const verify = await linkHostLogin(vibeHome);
    writeFileSync(join(hostHome, ".env"), "VIBE_TOKEN=refreshed-token-value\n");
    const result = await verify();
    expect(result.realMetadataChanged).toBe(true);
    expect(result.symlinkIntact).toBe(true);
  });

  it("fails loudly when the official login is missing", async () => {
    const vibeHome = freshDir("t-vibe-");
    process.env[SOURCE_VIBE_HOME_ENV] = freshDir("t-empty-");
    const error: unknown = await linkHostLogin(vibeHome).then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("official Mistral Vibe");
    expect((error as Error).message).toContain(".env");
  });

  it("treats a replaced link as a hard fault until reset", async () => {
    const { vibeHome } = arrangeHostLogin();
    const verify = await linkHostLogin(vibeHome);
    rmSync(join(vibeHome, ".env"));
    writeFileSync(join(vibeHome, ".env"), "not a link\n");

    const first: unknown = await verify().then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught,
    );
    expect((first as Error).message).toContain("replaced");

    const second: unknown = await linkHostLogin(vibeHome).then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught,
    );
    expect((second as Error).message).toBe((first as Error).message);

    resetLoginFaultForTests();
    rmSync(join(vibeHome, ".env"));
    await expect(linkHostLogin(vibeHome)).resolves.toBeDefined();
  });

  it("rejects immediately when a regular file preexists at the staged .env", async () => {
    const { vibeHome } = arrangeHostLogin();
    writeFileSync(join(vibeHome, ".env"), "inert replacement\n");
    const first: unknown = await linkHostLogin(vibeHome).then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught,
    );
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toMatch(/symlink/i);
    const second: unknown = await linkHostLogin(vibeHome).then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught,
    );
    expect((second as Error).message).toBe((first as Error).message);
  });

  it("rejects immediately when a wrong-target symlink preexists at the staged .env", async () => {
    const { hostHome, vibeHome } = arrangeHostLogin();
    const wrong = join(hostHome, "wrong.env");
    writeFileSync(wrong, "wrong\n");
    symlinkSync(wrong, join(vibeHome, ".env"));
    const first: unknown = await linkHostLogin(vibeHome).then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught,
    );
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toMatch(/symlink/i);
    const second: unknown = await linkHostLogin(vibeHome).then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught,
    );
    expect((second as Error).message).toBe((first as Error).message);
  });

  it("treats a missing link as a hard fault", async () => {
    const { vibeHome } = arrangeHostLogin();
    const verify = await linkHostLogin(vibeHome);
    rmSync(join(vibeHome, ".env"));
    const error: unknown = await verify().then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain("missing");
  });

  it("never surfaces credential bytes in its reports or messages", async () => {
    const { hostHome, vibeHome } = arrangeHostLogin();
    writeFileSync(join(hostHome, ".env"), "TOPSECRET-token-value-12345\n");
    const verify = await linkHostLogin(vibeHome);
    const result = await verify();
    expect(JSON.stringify(result)).not.toContain("TOPSECRET");
    rmSync(join(vibeHome, ".env"));
    const error: unknown = await verify().then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught,
    );
    expect((error as Error).message).not.toContain("TOPSECRET");
  });

  it("reuses an existing correct link instead of failing", async () => {
    const { vibeHome } = arrangeHostLogin();
    await linkHostLogin(vibeHome);
    resetLoginFaultForTests();
    const verifyAgain = await linkHostLogin(vibeHome);
    const result = await verifyAgain();
    expect(result.symlinkIntact).toBe(true);
  });

  it("can link a foreign-file placeholder without copying it", async () => {
    const { hostHome, vibeHome } = arrangeHostLogin();
    await linkHostLogin(vibeHome);
    const linkStat = lstatSync(join(vibeHome, ".env"));
    expect(linkStat.size).toBe(join(hostHome, ".env").length);
  });

  it("keeps the link target inside the host home, not the private tree", () => {
    const { hostHome, vibeHome } = arrangeHostLogin();
    expect(hostLoginPath()).toBe(join(hostHome, ".env"));
    expect(hostLoginPath().startsWith(vibeHome)).toBe(false);
  });

  it("points at a link location that is never the host file itself", () => {
    const { hostHome, vibeHome } = arrangeHostLogin();
    symlinkSync(join(hostHome, ".env"), join(vibeHome, ".env"));
    expect(lstatSync(join(vibeHome, ".env")).isSymbolicLink()).toBe(true);
  });
});
