import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store";
import { hashTranscript, measureSessionTokens, messagesAfterCursor, splitMessagesForExtraction, getSessionIdFromEvent, isSessionCompletionEvent } from "./session-autosave";
import { MemoryIntelligence } from "./intelligence";

const root = mkdtempSync(join(tmpdir(), "opencode-memory-autosave-"));
let store: MemoryStore | undefined;
try {
  store = new MemoryStore(root);
  store.vectorAvailable = false; // This smoke test validates local persistence, not remote embeddings.
  const { projectId } = store.registerProject({ name: "Auto-save smoke test", rootPath: root, goal: "Validate token threshold persistence" });
  store.createSessionRecord({ projectId, opencodeSessionId: "ses_smoke", title: "Deduplication smoke session" });
  const messages = [
    { id: "msg_user_1", role: "user", parts: [{ type: "text", text: "Implement token-aware memory persistence." }] },
    { id: "msg_assistant_1", role: "assistant", info: { metadata: { assistant: { tokens: {
      input: 42000, output: 3000, reasoning: 1000, cache: { read: 2000, write: 0 }
    } } } }, parts: [{ type: "text", text: "Implementation plan recorded." }] },
  ];
  const measured = measureSessionTokens(messages);
  assert.equal(measured.source, "provider_usage");
  assert.equal(measured.totalTokens, 48000);
  const sessionAggregate = measureSessionTokens(messages, { input: 45000, output: 4000, reasoning: 1000, cache: { read: 5000, write: 500 } });
  assert.equal(sessionAggregate.source, "session_usage");
  assert.equal(sessionAggregate.totalTokens, 55500);
  const messagesWithNextTurn = [...messages, { id: "msg_assistant_2", role: "assistant", info: { metadata: { assistant: { tokens: {
    input: 1000, output: 1500, reasoning: 0, cache: { read: 0, write: 0 }
  } } } }, parts: [{ type: "text", text: "Threshold crossed." }] }];
  assert.equal(measureSessionTokens(messagesWithNextTurn).totalTokens, 50500);
  const delta = messagesAfterCursor(messagesWithNextTurn, "msg_assistant_1");
  assert.equal(delta.cursorFound, true);
  assert.equal(delta.messages.length, 1);
  assert.ok(splitMessagesForExtraction(delta.messages, 38000).length === 1);
  // Current OpenCode V2 events use `data`; legacy events may use `properties`.
  assert.equal(getSessionIdFromEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_v2" } }), "ses_v2");
  assert.equal(getSessionIdFromEvent({ type: "session.idle", properties: { sessionID: "ses_v1" } }), "ses_v1");
  assert.equal(isSessionCompletionEvent("session.execution.succeeded"), true);
  assert.equal(isSessionCompletionEvent("session.execution.failed"), true);
  assert.equal(isSessionCompletionEvent("session.execution.interrupted"), true);
  assert.equal(isSessionCompletionEvent("session.text.delta"), false);

  const transcriptHash = hashTranscript(messagesWithNextTurn);
  const begin = store.beginSessionAutoSaveRun({ projectId, opencodeSessionId: "ses_smoke", transcriptHash,
    totalTokens: 50500, tokenSource: "provider_usage", messageCount: messagesWithNextTurn.length, lastMessageId: "msg_assistant_2" });
  assert.equal(begin.alreadyCompleted, false);
  const checkpoint = store.checkpoint({ projectId, sessionId: "ses_smoke", transcript: messagesWithNextTurn, type: "token_threshold_auto_save" });
  store.setSessionAutoSaveCheckpoint(begin.run.id, checkpoint.checkpointId);
  store.completeSessionAutoSaveRun({ runId: begin.run.id, projectId, opencodeSessionId: "ses_smoke", transcriptHash,
    totalTokens: 50500, tokenSource: "provider_usage", messageCount: 3, lastMessageId: "msg_assistant_2",
    checkpointId: checkpoint.checkpointId, result: { test: true } });
  const state = store.getSessionAutoSaveState(projectId, "ses_smoke");
  assert.equal(state.last_saved_tokens, 50500);
  assert.equal(state.last_message_id, "msg_assistant_2");
  const repeated = store.beginSessionAutoSaveRun({ projectId, opencodeSessionId: "ses_smoke", transcriptHash,
    totalTokens: 50500, tokenSource: "provider_usage", messageCount: 3, lastMessageId: "msg_assistant_2" });
  assert.equal(repeated.alreadyCompleted, true);

  const firstMemory = await store.writeMemoryDeduplicated({ projectId, kind: "decision", title: "Use SQLite", content: "Use SQLite for local persistence." });
  const secondMemory = await store.writeMemoryDeduplicated({ projectId, kind: "decision", title: "Use SQLite", content: "Use SQLite for local persistence." });
  assert.equal(firstMemory.duplicate, false);
  assert.equal(secondMemory.duplicate, true);
  assert.equal(firstMemory.memoryId, secondMemory.memoryId);
  assert.equal(Number(store.db.query("SELECT COUNT(*) AS n FROM memory_entry_evidence WHERE memory_id=?").get(firstMemory.memoryId)?.n), 1);
  const listed = store.listMemories(projectId, { query: "SQLite", limit: 5 });
  assert.ok(listed.some((item: any) => item.id === firstMemory.memoryId));
  const forgotten = store.forgetMemory(projectId, firstMemory.memoryId, "smoke-test");
  assert.equal(forgotten.forgotten, true);
  assert.equal(store.listMemories(projectId, { limit: 20 }).some((item: any) => item.id === firstMemory.memoryId), false);
  const restored = store.restoreMemory(projectId, firstMemory.memoryId);
  assert.equal(restored.restored, true);
  assert.equal(store.listMemories(projectId, { limit: 20 }).some((item: any) => item.id === firstMemory.memoryId), true);

  // Exercise semantic-object de-duplication without a live provider request.
  const intelligence = new MemoryIntelligence(root, store);
  let extractionVariant = 0;
  (intelligence as any).callModel = async () => {
    extractionVariant++;
    return extractionVariant === 1 ? {
      summary: "The project uses OpenAI structured outputs.",
      entities: [{ name: "OpenAI", type: "provider", aliases: ["OpenAI Inc."] }],
      facts: [{ subject: "OpenAI", predicate: "supports", object: "structured outputs", evidence: "First source." }],
      decisions: [{ title: "Use OpenAI API", decision: "Use structured output for response parsing", evidence: "First decision source." }],
      risks: [], open_questions: [], milestones: []
    } : {
      summary: "The same provider choice was confirmed again.",
      entities: [{ name: "OpenAI Inc.", type: "provider", aliases: ["OpenAI"] }],
      facts: [{ subject: "OpenAI Inc.", predicate: "Supports", object: "structured   outputs", evidence: "Second source." }],
      decisions: [{ title: " use openai api ", decision: "Use structured output for response   parsing", evidence: "Second decision source." }],
      risks: [], open_questions: [], milestones: []
    };
  };
  const longTranscript1 = "First extraction transcript. ".repeat(20);
  const longTranscript2 = "Second extraction transcript with repeated evidence. ".repeat(20);
  const firstExtraction = await intelligence.extract({ projectId, sessionId: "ses_smoke", title: "Initial design", transcript: longTranscript1, sourceRef: "checkpoint:1" });
  const secondExtraction = await intelligence.extract({ projectId, sessionId: "ses_smoke", title: "Design confirmation", transcript: longTranscript2, sourceRef: "checkpoint:2" });
  assert.equal(firstExtraction.entityCount, 1);
  assert.equal(firstExtraction.newEntityCount, 1);
  assert.equal(secondExtraction.entityCount, 1);
  assert.equal(secondExtraction.newEntityCount, 0);
  assert.equal(secondExtraction.duplicateEntityCount, 1);
  assert.equal(secondExtraction.duplicateFactCount, 1);
  assert.equal(secondExtraction.duplicateDecisionCount, 1);
  assert.equal(Number(store.db.query("SELECT COUNT(*) AS n FROM intelligence_entities WHERE project_id=?").get(projectId)?.n), 1);
  assert.equal(Number(store.db.query("SELECT COUNT(*) AS n FROM knowledge_claims WHERE project_id=?").get(projectId)?.n), 1);
  assert.equal(Number(store.db.query("SELECT COUNT(*) AS n FROM knowledge_decisions WHERE project_id=?").get(projectId)?.n), 1);
  assert.equal(Number(store.db.query("SELECT COUNT(*) AS n FROM knowledge_entity_evidence WHERE project_id=?").get(projectId)?.n), 2);
  assert.equal(Number(store.db.query("SELECT COUNT(*) AS n FROM knowledge_claim_evidence WHERE project_id=?").get(projectId)?.n), 2);
  assert.equal(Number(store.db.query("SELECT COUNT(*) AS n FROM knowledge_decision_evidence WHERE project_id=?").get(projectId)?.n), 2);

  console.log("[OK] auto-save threshold accounting, cursor/chunking, checkpoint idempotency, memory evidence, entity-alias deduplication, fact/decision deduplication and provenance checks passed.");
} finally {
  try { store?.close(); } catch {}
  rmSync(root, { recursive: true, force: true });
}
