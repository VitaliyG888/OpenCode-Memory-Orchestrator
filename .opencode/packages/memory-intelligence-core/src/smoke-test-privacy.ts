import assert from "node:assert/strict";
import { extractLatestUserPrompt, sanitizeSensitiveText, sanitizeSensitiveValue } from "./privacy.ts";

const source = [
  "OpenRouter key: sk-or-v1-0123456789abcdefghijklmnop",
  "GitHub token ghp_123456789012345678901234567890123456",
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
  "apiKey: \"my-secret-value-123456\"",
  "JWT eyJabcdefghijk.abcdefghijk.abcdefghijk",
  "<private>my private instructions</private>",
].join("\n");
const clean = sanitizeSensitiveText(source);
assert(!clean.includes("sk-or-v1-" + "0123456789"));
assert(!clean.includes("ghp_" + "123456789"));
assert(!clean.includes("abcdefghijklmnopqrstuvwxyz123456"));
assert(!clean.includes("my-secret-value-123456"));
assert(!clean.includes("my private instructions"));
assert(clean.includes("[PRIVATE CONTENT REDACTED]"));
assert(sanitizeSensitiveText("public <private>secret").endsWith("[PRIVATE CONTENT REDACTED]"));
assert.equal(sanitizeSensitiveValue({ token: "sk-or-v1-" + "0123456789abcdefghijklmnop" }).token, "[REDACTED_OPENROUTER_KEY]");
const shared = { value: "ordinary text" };
const sharedClean = sanitizeSensitiveValue({ first: shared, second: shared });
assert.equal(sharedClean.first.value, "ordinary text");
assert.equal(sharedClean.second.value, "ordinary text", "shared non-cyclic references must not be treated as circular");
const cyclic: any = { value: "safe" };
cyclic.self = cyclic;
assert.equal(sanitizeSensitiveValue(cyclic).self, "[CIRCULAR_VALUE]");
const prompt = extractLatestUserPrompt([
  { info: { role: "user" }, parts: [{ type: "text", text: "earlier prompt" }] },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "response" }] },
  { info: { role: "user" }, parts: [{ type: "text", text: "current <private>do-not-leak</private>" }] },
]);
assert(prompt.startsWith("current"));
assert(!prompt.includes("do-not-leak"));
console.log("[OK] privacy redaction and V2 user-prompt extraction passed");
