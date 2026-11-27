/**
 * Configuration notices raised while loading. Pi's interactive screen does not
 * show console output, so index.ts delivers them with ctx.ui.notify at
 * session_start, and to stderr when there is no UI (print/JSON mode).
 */
const pending: string[] = [];
const seen = new Set<string>();

export function addStartupNotice(message: string): void {
  if (seen.has(message)) return;
  seen.add(message);
  pending.push(message);
}

export function takeStartupNotices(): string[] {
  return pending.splice(0, pending.length);
}
