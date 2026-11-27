/**
 * On-disk identity for this package. The tether never touches the official
 * client's own `~/.vibe` tree: it keeps its own data home and private
 * per-session `VIBE_HOME` trees, and links the existing login into them
 * (src/login.ts).
 *
 * Ephemeral state lives in the process's private runtime directory, which is
 * created on first use and removed on exit. The data home holds only
 * read-tolerant optional caches (the discovered model catalog); failing to
 * write them must never fail a turn.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existingRuntimeDir, runtimeDir } from "./runtime-dir.js";

/** Private cache home override. */
export const DATA_DIR_ENV = "PI_MISTRAL_VIBE_TETHER_DATA_DIR";

/** Existing official `VIBE_HOME` override (tests, isolated installs). */
export const SOURCE_VIBE_HOME_ENV = "PI_MISTRAL_VIBE_TETHER_SOURCE_VIBE_HOME";

/** Root of everything this package owns. Tests and proofs override it. */
export function tetherDataDir(): string {
  const override = process.env[DATA_DIR_ENV];
  if (override) return override;
  return join(homedir(), ".pi", "agent", "mistral-vibe-tether");
}

/** The existing official client home the login is linked from. */
export function hostVibeHomePath(): string {
  const override = process.env[SOURCE_VIBE_HOME_ENV];
  if (override) return override;
  return join(homedir(), ".vibe");
}

/** The existing official login, exactly as the official client installed it. Never read or copied. */
export function hostLoginPath(): string {
  return join(hostVibeHomePath(), ".env");
}

/** The official client's own catalog cache, if present. */
export function hostCatalogCachePath(): string {
  return join(hostVibeHomePath(), "model_catalog_cache.json");
}

/** The discovered model catalog cache kept in the private home. */
export function catalogCachePath(): string {
  return join(tetherDataDir(), "catalog-cache.json");
}

/** Reduce an id to characters that cannot escape or confuse a path. */
function safeFileSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "session";
  return segment === "." || segment === ".." ? "session" : segment;
}

/** Per-ACP-session staging inside the private runtime directory. */
export function sessionDir(sessionId: string): string {
  return join(runtimeDir(), "sessions", safeFileSegment(sessionId));
}

/** Existing per-session staging path without allocating a new runtime directory. */
export function existingSessionDir(sessionId: string): string | undefined {
  const base = existingRuntimeDir();
  return base ? join(base, "sessions", safeFileSegment(sessionId)) : undefined;
}

/** The private `VIBE_HOME` staged for one ACP session. */
export function sessionVibeHome(sessionId: string): string {
  return join(sessionDir(sessionId), "vibe-home");
}

/** The empty isolated workspace `vibe-acp` uses as its working directory. */
export function sessionWorkspaceDir(sessionId: string): string {
  return join(sessionVibeHome(sessionId), "workspace");
}
