/**
 * One NDJSON frame from the ACP server's stdout.
 *
 * ACP speaks JSON-RPC 2.0 over stdio, one JSON object per line. Anything that
 * is not a JSON object is surfaced as a parse fault instead of being silently
 * dropped: a parser that guesses at torn frames invents conversation.
 */

export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

export function parseFrame(line: string): RpcMessage | { fault: string } {
  const trimmed = line.trim();
  if (!trimmed) return { fault: "empty frame" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { fault: `non-JSON frame: ${trimmed.slice(0, 200)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { fault: `non-object frame: ${trimmed.slice(0, 200)}` };
  return parsed as RpcMessage;
}

export function isServerRequest(frame: unknown): frame is Required<Pick<RpcMessage, "id" | "method">> {
  const f = frame as RpcMessage;
  return !!f && typeof f.method === "string" && f.id !== undefined && f.id !== null;
}

export function isResponse(frame: unknown): frame is RpcMessage & { id: number | string } {
  const f = frame as RpcMessage;
  return (
    !!f &&
    f.id !== undefined &&
    f.id !== null &&
    typeof f.method !== "string" &&
    ("result" in f || "error" in f)
  );
}
