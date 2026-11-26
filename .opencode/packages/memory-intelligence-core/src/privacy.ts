/** Best-effort privacy boundary for anything retained by Memory Intelligence or sent to a remote model. */
export interface PrivacyOptions {
  redactCredentials?: boolean;
  redactPrivateTags?: boolean;
}

const DEFAULTS: Required<PrivacyOptions> = { redactCredentials: true, redactPrivateTags: true };

function redactPrivateSections(input: string): string {
  const lower = input.toLowerCase();
  let output = "";
  let cursor = 0;
  while (cursor < input.length) {
    const open = lower.indexOf("<private>", cursor);
    if (open < 0) { output += input.slice(cursor); break; }
    output += input.slice(cursor, open);
    let depth = 1;
    let scan = open + 9;
    while (scan < input.length && depth > 0) {
      const nextOpen = lower.indexOf("<private>", scan);
      const nextClose = lower.indexOf("</private>", scan);
      if (nextClose < 0) { scan = input.length; depth = 0; break; }
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; scan = nextOpen + 9; }
      else { depth--; scan = nextClose + 10; }
    }
    output += "[PRIVATE CONTENT REDACTED]";
    cursor = scan;
  }
  return output;
}

function redactCredentials(input: string): string {
  let text = input;
  // PEM private keys and certificates containing private key material.
  text = text.replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]");
  // Provider and source-control tokens.
  text = text.replace(/\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENROUTER_KEY]");
  text = text.replace(/\bnvapi-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_NVIDIA_KEY]");
  text = text.replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_ANTHROPIC_KEY]");
  text = text.replace(/\bsk-[A-Za-z0-9_-]{24,}\b/g, "[REDACTED_API_KEY]");
  text = text.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]");
  text = text.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED_GOOGLE_KEY]");
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}/gi, "Bearer [REDACTED]");
  // JWT-shaped credentials. Do not treat arbitrary hashes as secrets.
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]");
  // Explicit credential assignments, including JSON/YAML/env files pasted into chat.
  text = text.replace(/((?:api[_-]?key|client[_-]?secret|secret[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|auth[_-]?token)\s*["']?\s*[:=]\s*["']?)([^\s"'`,;]{8,})/gi, "$1[REDACTED]");
  return text;
}

export function sanitizeSensitiveText(value: unknown, options: PrivacyOptions = {}): string {
  const settings = { ...DEFAULTS, ...options };
  let text = String(value ?? "").replace(/\u0000/g, "");
  if (settings.redactPrivateTags) text = redactPrivateSections(text);
  if (settings.redactCredentials) text = redactCredentials(text);
  return text;
}

export function sanitizeSensitiveValue<T>(value: T, options: PrivacyOptions = {}, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return sanitizeSensitiveText(value, options) as T;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[CIRCULAR_VALUE]" as T;
  seen.add(value as object);
  if (Array.isArray(value)) {
    const clean = value.map((item) => sanitizeSensitiveValue(item, options, seen));
    seen.delete(value as object);
    return clean as T;
  }
  const clean: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    clean[key] = sanitizeSensitiveValue(child, options, seen);
  }
  // Track only the current recursion path so shared-but-acyclic objects are not
  // incorrectly reported as cycles when referenced by multiple properties.
  seen.delete(value as object);
  return clean as T;
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, any>;
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.parts)) return collectText(item.parts);
  if (Array.isArray(item.content)) return collectText(item.content);
  return "";
}

/** Extract the latest authored user prompt from V2 stored-message shapes. */
export function extractLatestUserPrompt(messages: unknown, maxChars = 8000): string {
  const items = Array.isArray(messages) ? messages : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const message = items[i] as Record<string, any>;
    const info = message?.info && typeof message.info === "object" ? message.info : {};
    const data = message?.data && typeof message.data === "object" ? message.data : {};
    const role = String(info.role || message?.role || data.role || "").toLowerCase();
    if (role !== "user") continue;
    const body = collectText(message?.parts ?? info.parts ?? data.parts ?? message?.content ?? info.content ?? data.content);
    if (body.trim()) return sanitizeSensitiveText(body).slice(-maxChars).trim();
  }
  return "";
}
