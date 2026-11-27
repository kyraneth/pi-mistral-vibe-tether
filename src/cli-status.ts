/**
 * What the last ACP session established, for the `/vibe-status` command.
 *
 * The handshake is observed live; the account readout comes from the
 * transport's own account and identity replies, never from credential bytes.
 */

import { PERMANENT_ROUTE_FACTS, STRICT_ENV } from "./degradations.js";

export interface VibeAccountInfo {
  planName?: string;
  planTitle?: string;
  usagePercentage?: number;
  resetAt?: string;
  paygEnabled?: boolean;
  keyScope?: string;
  accessScope?: string;
  workspace?: string;
  organization?: string;
}

export interface CliStatus {
  binary?: string;
  agentVersion?: string;
  agentName?: string;
  offeredModels?: string[];
  configured?: { model: string; effort?: string };
  loginLinked?: boolean;
  account?: VibeAccountInfo;
  lastRetirement?: string[];
  lastError?: string;
}

const status: CliStatus = {};

export function recordStatus(patch: Partial<CliStatus>): void {
  Object.assign(status, patch);
}

export function cliStatus(): CliStatus {
  return { ...status };
}

export function resetStatusForTests(): void {
  for (const key of Object.keys(status)) delete (status as any)[key];
}

/** One human-readable block for `/vibe-status`. */
export function cliStatusLine(s: CliStatus = cliStatus()): string {
  const lines = [
    `binary: ${s.binary ?? "unknown"}`,
    `vibe-acp: ${s.agentVersion ?? "not observed in this Pi process yet"}`,
    `agent: ${s.agentName ?? "not observed"}`,
    `offered models: ${s.offeredModels?.length ? s.offeredModels.join(", ") : "not observed"}`,
    `configured: ${s.configured ? `${s.configured.model}${s.configured.effort ? ` / effort ${s.configured.effort}` : ""}` : "not observed"}`,
    `login: ${s.loginLinked ? "official login linked by reference" : "not observed"}`,
  ];
  if (s.account) {
    const account = s.account;
    if (account.planName !== undefined || account.planTitle !== undefined) {
      lines.push(
        `plan: ${account.planName ?? "unknown"}${account.planTitle ? ` (${account.planTitle})` : ""}`,
      );
    }
    if (account.usagePercentage !== undefined) {
      lines.push(
        `vibe budget usage: ${account.usagePercentage}%${account.resetAt ? ` (resets ${account.resetAt})` : ""}`,
      );
    }
    if (account.paygEnabled !== undefined) {
      lines.push(`payg enabled: ${account.paygEnabled ? "yes" : "no"}`);
    }
    if (account.keyScope) lines.push(`key scope: ${account.keyScope}`);
    if (account.accessScope) lines.push(`access scope: ${account.accessScope}`);
    if (account.workspace) lines.push(`workspace: ${account.workspace}`);
    if (account.organization) lines.push(`organization: ${account.organization}`);
  }
  if (s.lastRetirement?.length) lines.push(`last retirement: ${s.lastRetirement.join(", ")}`);
  if (s.lastError) lines.push(`last error: ${s.lastError}`);
  lines.push(`route facts (log-only; set ${STRICT_ENV}=1 to refuse):`);
  for (const fact of PERMANENT_ROUTE_FACTS) lines.push(`- ${fact}`);
  return lines.join("\n");
}
