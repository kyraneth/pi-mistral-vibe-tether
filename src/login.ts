/**
 * Login handoff.
 *
 * The official client owns its credential file (`~/.vibe/.env`). The tether
 * links that existing login into the private per-session `VIBE_HOME` so
 * `vibe-acp` reads the file it already trusts, and never reads, copies,
 * prints, or parses the bytes itself. Only file metadata (`stat`, `lstat`,
 * `readlink`) is ever observed. A broken link is a hard stop: there is no
 * fallback credential path and no repair attempt.
 */

import { mkdir, stat, lstat, readlink, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostLoginPath } from "./data-dir.js";

export interface LoginMetadata {
  inode: string;
  size: number;
  mtimeMs: number;
}

export interface LoginVerification {
  before: LoginMetadata;
  after: LoginMetadata;
  realMetadataChanged: boolean;
  symlinkIntact: boolean;
}

let linkFault: string | undefined;

export function assertLoginSafe(): void {
  if (linkFault) throw new Error(linkFault);
}

/**
 * Link `real` (default: the official login) into the private `vibeHome` and
 * return the verification step the caller repeats after the client has run.
 * Metadata is reported, never edited: the official client refreshing its own
 * credential file is normal, not an incident.
 */
export async function linkHostLogin(
  vibeHome: string,
  real = hostLoginPath(),
): Promise<() => Promise<LoginVerification>> {
  assertLoginSafe();
  const link = join(vibeHome, ".env");
  try {
    await stat(real);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `Mistral Vibe login not found at ${real}. Sign in with the official Mistral Vibe first; the tether links that login and never creates one.`
        : `Mistral Vibe login is not readable at ${real} (${code ?? "unknown error"}). Fix the official login; the tether does not copy or repair credentials.`,
    );
  }
  await mkdir(dirname(link), { recursive: true, mode: 0o700 });
  let before = await stat(real);
  try {
    await symlink(real, link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let stagedIntact = false;
  let stagedMissing = false;
  try {
    const privateState = await lstat(link);
    stagedIntact = privateState.isSymbolicLink() && (await readlink(link)) === real;
  } catch (error) {
    stagedMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!stagedIntact) {
    linkFault = `Mistral Vibe login metadata symlink ${stagedMissing ? "missing" : "replaced"}; STOP, retain the private config and request account-owner review`;
    throw new Error(linkFault);
  }

  return async () => {
    let intact = false;
    let missing = false;
    try {
      const privateState = await lstat(link);
      intact = privateState.isSymbolicLink() && (await readlink(link)) === real;
    } catch (error) {
      missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (!intact) {
      linkFault = `Mistral Vibe login metadata symlink ${missing ? "missing" : "replaced"}; STOP, retain the private config and request account-owner review`;
      throw new Error(linkFault);
    }
    const after = await stat(real);
    const metadata: LoginVerification = {
      before: {
        inode: String(before.ino),
        size: before.size,
        mtimeMs: before.mtimeMs,
      },
      after: {
        inode: String(after.ino),
        size: after.size,
        mtimeMs: after.mtimeMs,
      },
      realMetadataChanged:
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs,
      symlinkIntact: intact,
    };
    // A normal official-client refresh replaces the file. Report it; never
    // call it a credential incident and never repair it.
    before = after;
    return metadata;
  };
}

/** Test seam: a fault from a previous test must not outlive it. */
export function resetLoginFaultForTests(): void {
  linkFault = undefined;
}
