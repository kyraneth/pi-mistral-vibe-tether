/**
 * Private runtime directory for this package.
 *
 * Ephemeral state (staged per-session `VIBE_HOME` trees, session staging, and
 * handoff sockets) lives here. The directory is created on first use with
 * mode 0700 and removed on exit. The base directory is chosen explicitly:
 * `PI_MISTRAL_VIBE_TETHER_RUNTIME_DIR` when set, otherwise the system
 * temporary directory (which honours `TMPDIR`), falling back to
 * `XDG_RUNTIME_DIR` when a socket path would not fit under the temporary
 * directory. A path that fits nowhere fails loudly naming the bases, instead
 * of silently moving state elsewhere.
 */

import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_SOCKET_NAME, RUNTIME_FILE_MODE } from "pi-tether-core/runtime";

export { HANDOFF_SOCKET_NAME, RUNTIME_FILE_MODE };

/** Explicit base directory override for isolated installs and tests. */
export const RUNTIME_DIR_ENV = "PI_MISTRAL_VIBE_TETHER_RUNTIME_DIR";

const PREFIX = "pi-mistral-vibe-";

let dir: string | undefined;

function privateDir(base: string): string {
  const path = mkdtempSync(join(base, PREFIX));
  // mkdtempSync applies the inherited umask, which can remove owner search access.
  chmodSync(path, 0o700);
  return path;
}

function socketFits(base: string): boolean {
  // sockaddr_un.sun_path is 108 bytes on Linux (unix(7)) and 104 on macOS
  // (XNU bsd/sys/un.h). Leave one byte for NUL; count UTF-8 bytes, not JS chars.
  // https://man7.org/linux/man-pages/man7/unix.7.html
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h
  const sunPathBytes = process.platform === "darwin" ? 104 : 108;
  // Node mkdtempSync appends six random characters to the prefix.
  return (
    Buffer.byteLength(join(base, `${PREFIX}XXXXXX`, HANDOFF_SOCKET_NAME)) <
    sunPathBytes
  );
}

/** The private directory for this process, created on first use (mode 0700). */
function createRuntimeDir(): string {
  const override = process.env[RUNTIME_DIR_ENV];
  if (override) {
    try {
      return privateDir(override);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `mistral-vibe tether runtime directory unavailable under ${RUNTIME_DIR_ENV}: ${detail}. Check the override and the sandbox write grants.`,
        { cause: error },
      );
    }
  }
  const base = tmpdir();
  if (socketFits(base)) {
    try {
      return privateDir(base);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `mistral-vibe tether runtime directory unavailable under TMPDIR: ${detail}. Check TMPDIR and the sandbox write grants.`,
        { cause: error },
      );
    }
  }
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && socketFits(xdg)) {
    try {
      return privateDir(xdg);
    } catch {
      /* fall through to the loud failure below */
    }
  }
  throw new Error(
    `mistral-vibe tether runtime directory unavailable: no usable base. Set ${RUNTIME_DIR_ENV} or TMPDIR to a writable path short enough for a handoff socket.`,
  );
}

/** The private directory for this process, created on first use (mode 0700). */
export function runtimeDir(): string {
  dir ??= createRuntimeDir();
  return dir;
}

/** The cached directory, without allocating during shutdown cleanup. */
export function existingRuntimeDir(): string | undefined {
  return dir;
}

/** Path to `name` inside the private directory. */
export function runtimeFile(name: string): string {
  return join(runtimeDir(), name);
}

/**
 * Recursively restore owner permissions on directories only so a tree the
 * client locked down (read-only directories) can be removed. Files are
 * never chmodded: unlinking a file needs only a writable parent, and
 * mutating a file's mode would mutate a hardlink held outside the tree.
 * Symlinks are never followed, chmodded, or recursed into: their targets
 * are outside the tree and must be left untouched.
 */
function restorePermissions(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    try {
      chmodSync(path, 0o700);
    } catch {
      /* already writable, or not ours to change */
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(path);
    } catch {
      entries = [];
    }
    for (const entry of entries) restorePermissions(join(path, entry));
  }
}

/** Remove a tree, first restoring permissions the client may have locked down. */
export function removeTreeSync(target: string): void {
  restorePermissions(target);
  rmSync(target, { recursive: true, force: true });
}

/**
 * Remove the directory and everything in it. Registered on `process.on("exit")`,
 * so it must stay synchronous. A killed process can still leak the directory —
 * but it leaks a `0700` directory no other user can open.
 */
export function cleanupRuntimeDir(): void {
  if (!dir) return;
  const path = dir;
  dir = undefined;
  try {
    removeTreeSync(path);
  } catch {
    /* already gone, or not ours to remove */
  }
}

/** Test seam: forget the current directory without removing it. */
export function resetRuntimeDirForTests(): void {
  dir = undefined;
}
