import { createHash } from "node:crypto";

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function finite(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function pickTokens(message: any): Record<string, any> | null {
  const info = object(message?.info);
  const data = object(message?.data);
  const dataInfo = object(data.info);
  const candidates = [
    object(object(info.metadata).assistant).tokens,
    object(object(message?.metadata).assistant).tokens,
    object(info.assistant).tokens,
    info.tokens,
    object(object(dataInfo.metadata).assistant).tokens,
    object(dataInfo.assistant).tokens,
    dataInfo.tokens,
    object(object(data.metadata).assistant).tokens,
    object(data.assistant).tokens,
    data.tokens,
  ];
  for (const candidate of candidates) {
    const tokens = object(candidate);
    if (["input", "output", "reasoning"].some((key) => finite(tokens[key]) !== undefined) ||
        ["read", "write"].some((key) => finite(object(tokens.cache)[key]) !== undefined)) return tokens;
  }
  return null;
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, any>;
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (typeof item.output === "string") return item.output;
  if (Array.isArray(item.parts)) return collectText(item.parts);
  if (Array.isArray(item.content)) return collectText(item.content);
  if (Array.isArray(item.messages)) return collectText(item.messages);
  return "";
}


/** Read a session ID from the current OpenCode V2 event envelope (data), with a V1 fallback. */
export function getSessionIdFromEvent(event: any): string | null {
  const payload = event?.data && typeof event.data === "object" ? event.data :
    event?.properties && typeof event.properties === "object" ? event.properties : {};
  const value = payload.sessionID ?? payload.info?.id ?? payload.session?.id ?? event?.sessionID;
  return typeof value === "string" && value ? value : null;
}

/** Auto-save only at completed execution boundaries, never while a response is streaming. */
export function isSessionCompletionEvent(type: unknown): boolean {
  return type === "session.idle" || type === "session.execution.succeeded" ||
    type === "session.execution.failed" || type === "session.execution.interrupted";
}

export interface SessionTokenMeasurement {
  totalTokens: number;
  source: "session_usage" | "provider_usage" | "estimated_chars";
  usageMessages: number;
  estimatedTokens: number;
}

/**
 * Prefer OpenCode's persisted per-assistant-message usage. It counts input + output +
 * reasoning + cache read/write, i.e. cumulative model-token consumption, not the
 * current context-window occupancy. If a provider omitted usage, estimate from text.
 */
export function measureSessionTokens(messages: any[], sessionUsage?: unknown): SessionTokenMeasurement {
  const aggregateCandidates = [
    sessionUsage,
    (sessionUsage as any)?.tokens,
    (sessionUsage as any)?.data?.tokens,
    (sessionUsage as any)?.info?.tokens,
  ];
  for (const candidate of aggregateCandidates) {
    const tokens = object(candidate);
    const cache = object(tokens.cache);
    const values = [finite(tokens.input), finite(tokens.output), finite(tokens.reasoning), finite(cache.read), finite(cache.write)];
    if (values.some((value) => value !== undefined)) {
      const aggregateTotal = Math.round(values.reduce((sum, value) => sum + (value || 0), 0));
      if (aggregateTotal > 0) {
        const usageMessages = (messages || []).filter((message) => {
          const info = object(message?.info);
          const data = object(message?.data);
          const role = String(info.role || message?.role || message?.type || data.role || data.type || "").toLowerCase();
          return (!role || role === "assistant") && pickTokens(message) !== null;
        }).length;
        return { totalTokens: aggregateTotal, source: "session_usage", usageMessages, estimatedTokens: 0 };
      }
    }
  }

  let usageTotal = 0;
  let usageMessages = 0;
  for (const message of messages || []) {
    const info = object(message?.info);
    const data = object(message?.data);
    const role = String(info.role || message?.role || message?.type || data.role || data.type || "").toLowerCase();
    const tokens = pickTokens(message);
    if (!tokens || (role && role !== "assistant")) continue;
    const cache = object(tokens.cache);
    const values = [
      finite(tokens.input), finite(tokens.output), finite(tokens.reasoning),
      finite(cache.read), finite(cache.write),
    ];
    if (values.some((value) => value !== undefined)) {
      usageTotal += values.reduce((sum, value) => sum + (value || 0), 0);
      usageMessages++;
    }
  }
  const textChars = (messages || []).reduce((sum, message) => {
    const candidates = [
      message?.parts, message?.info?.parts, message?.data?.parts,
      message?.content, message?.info?.content, message?.data?.content,
      message?.info, message?.data, message,
    ];
    let text = "";
    for (const candidate of candidates) {
      text = collectText(candidate);
      if (text) break;
    }
    let fallbackLength = 0;
    if (!text) {
      try { fallbackLength = JSON.stringify(message ?? "").length; } catch { fallbackLength = 0; }
    }
    return sum + (text ? text.length : fallbackLength);
  }, 0);
  const estimatedTokens = Math.ceil(textChars / 3.6);
  if (usageMessages > 0) {
    return { totalTokens: Math.round(usageTotal), source: "provider_usage", usageMessages, estimatedTokens };
  }
  return { totalTokens: estimatedTokens, source: "estimated_chars", usageMessages: 0, estimatedTokens };
}

export function getMessageId(message: any): string | null {
  const info = object(message?.info);
  const data = object(message?.data);
  const dataInfo = object(data.info);
  const value = message?.id ?? info.id ?? data.id ?? dataInfo.id;
  return typeof value === "string" && value ? value : null;
}

/** Return only messages after the last message included in a successful auto-checkpoint. */
export function messagesAfterCursor(messages: any[], cursor: string | null | undefined) {
  if (!cursor) return { messages: [...(messages || [])], cursorFound: true };
  const index = (messages || []).findIndex((message) => getMessageId(message) === cursor);
  if (index < 0) return { messages: [...(messages || [])], cursorFound: false };
  return { messages: messages.slice(index + 1), cursorFound: true };
}

export function hashTranscript(messages: any[]): string {
  return createHash("sha256").update(JSON.stringify(messages || [])).digest("hex");
}

/** Convert a message delta into bounded chunks accepted by Memory Intelligence's LLM limit. */
export function splitMessagesForExtraction(messages: any[], maxChars = 38000): Array<Array<{ role: string; content: string }>> {
  const limit = Math.max(3000, Math.min(43000, Math.floor(maxChars)));
  const chunks: Array<Array<{ role: string; content: string }>> = [];
  let current: Array<{ role: string; content: string }> = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    currentChars = 0;
  };
  for (const message of messages || []) {
    const info = object(message?.info);
    const data = object(message?.data);
    const role = String(info.role || message?.role || data.role || "message").slice(0, 30);
    const bodyCandidates = [message?.parts, info.parts, data.parts, message?.content, info.content, data.content, message];
    let body = "";
    for (const candidate of bodyCandidates) {
      body = collectText(candidate);
      if (body) break;
    }
    if (!body) {
      try { body = JSON.stringify(message).slice(0, limit * 2); } catch { body = "[unserializable message]"; }
    }
    if (body.length > limit) {
      flush();
      for (let offset = 0; offset < body.length; offset += limit) {
        chunks.push([{ role, content: body.slice(offset, offset + limit) }]);
      }
      continue;
    }
    const cost = body.length + role.length + 16;
    if (current.length && currentChars + cost > limit) flush();
    current.push({ role, content: body });
    currentChars += cost;
  }
  flush();
  return chunks;
}
