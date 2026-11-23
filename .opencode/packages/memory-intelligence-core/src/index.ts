/** Stable public API for plugins consuming the shared Memory Intelligence service. */
export { acquireMemoryIntelligence, MemoryIntelligenceClient } from "./client";
export type { MemoryClientLease } from "./client";

export { readOpenCodeSessionHistory } from "./session-history";
export { measureSessionTokens, getMessageId, messagesAfterCursor, hashTranscript, splitMessagesForExtraction, getSessionIdFromEvent, isSessionCompletionEvent } from "./session-autosave";
export type { SessionTokenMeasurement } from "./session-autosave";
export { readMemoryAutoSaveConfig, readMemoryRecallConfig } from "./config";
export type { MemoryAutoSaveConfig, MemoryRecallConfig } from "./config";
export { sanitizeSensitiveText, sanitizeSensitiveValue, extractLatestUserPrompt } from "./privacy";
