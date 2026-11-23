import { Plugin } from "@opencode/plugin";
import {
  acquireMemoryIntelligence,
  hashTranscript,
  measureSessionTokens,
  messagesAfterCursor,
  readMemoryAutoSaveConfig,
  readMemoryRecallConfig,
  extractLatestUserPrompt,
  readOpenCodeSessionHistory,
  splitMessagesForExtraction,
  getMessageId,
  getSessionIdFromEvent,
  isSessionCompletionEvent,
} from "opencode-memory-intelligence-core";

function jsonResult(value: unknown) { return { content: JSON.stringify(value, null, 2) }; }
function scoped(input: any, projectId: string) { return { ...input, projectId: input?.projectId || projectId }; }

export default Plugin.define({
  id: "memory-intelligence",
  async setup(ctx) {
    const projectRoot = ctx.location.project.canonical || ctx.location.directory;
    const projectName = projectRoot.split(/[\\/]/).filter(Boolean).pop() || "OpenCode Project";
    const lease = acquireMemoryIntelligence(projectRoot);
    const memory = lease.client;
    const projectId = memory.ensureProject(projectName, projectRoot, "Shared project knowledge base managed by Memory Intelligence");
    const autoSaveConfig = readMemoryAutoSaveConfig(projectRoot);
    const recallConfig = readMemoryRecallConfig(projectRoot);
    const recallCache = new Map<string, { queryHash: string; text: string; expiresAt: number }>();
    const autoSaveInFlight = new Set<string>();
    const autoSavePending = new Set<string>();

    const autoSaveSession = async (sessionID: string) => {
      if (!autoSaveConfig.enabled || !autoSaveConfig.checkOnSessionIdle) return;
      // If another execution finishes while LLM extraction is still running, queue one
      // follow-up pass so the newest messages are not missed at a threshold boundary.
      if (autoSaveInFlight.has(sessionID)) { autoSavePending.add(sessionID); return; }
      autoSaveInFlight.add(sessionID);
      let runId: string | undefined;
      try {
        const history = readOpenCodeSessionHistory(sessionID);
        if (!history.complete || !history.messages.length) {
          memory.event(projectId, "SESSION_AUTO_SAVE_SKIPPED", { reason: history.warning || "complete_history_unavailable", source: history.source }, sessionID);
          return;
        }
        const messages = history.messages;
        let sessionInfo: any = null;
        try { sessionInfo = await ctx.session.get({ sessionID }) as any; } catch { /* Persisted message-level usage remains the fallback. */ }
        const measurement = measureSessionTokens(messages, sessionInfo?.tokens || sessionInfo?.data?.tokens || sessionInfo?.info?.tokens);
        if (measurement.source === "estimated_chars" && !autoSaveConfig.estimateFallback) {
          memory.event(projectId, "SESSION_AUTO_SAVE_SKIPPED", { reason: "provider_token_usage_unavailable_and_estimation_disabled", estimate: measurement.estimatedTokens }, sessionID);
          return;
        }
        const state = memory.getSessionAutoSaveState(projectId, sessionID);
        const lastSavedTokens = Number(state?.last_saved_tokens || 0);
        const tokenDelta = measurement.totalTokens - lastSavedTokens;
        if (tokenDelta < autoSaveConfig.tokenThreshold) return;

        const title = String(sessionInfo?.title || "OpenCode session");
        let sessionRecord = memory.findSession(projectId, sessionID);
        if (!sessionRecord) {
          memory.createSessionRecord({ projectId, opencodeSessionId: sessionID, title });
          sessionRecord = memory.findSession(projectId, sessionID);
        }

        const transcriptHash = hashTranscript(messages);
        const lastMessageId = getMessageId(messages[messages.length - 1]);
        const begun = memory.beginSessionAutoSaveRun({ projectId, opencodeSessionId: sessionID, transcriptHash,
          totalTokens: measurement.totalTokens, tokenSource: measurement.source, messageCount: messages.length, lastMessageId });
        const run = begun.run;
        runId = run?.id;
        if (!runId) throw new Error("Could not create or retrieve the idempotent auto-save run.");
        if (begun.alreadyCompleted) return;

        let checkpointId = run.checkpoint_id as string | null;
        if (!checkpointId) {
          const checkpoint = memory.checkpoint({ projectId, sessionId: sessionID, taskId: sessionRecord?.task_id || undefined,
            transcript: autoSaveConfig.saveRawTranscript ? messages : undefined,
            summary: `Automatic token-threshold checkpoint: ${measurement.totalTokens} tokens (${measurement.source}); ${messages.length} messages; source ${history.source}.`,
            type: "token_threshold_auto_save" });
          checkpointId = checkpoint.checkpointId;
          memory.setSessionAutoSaveCheckpoint(runId, checkpointId);
        }

        let delta = messagesAfterCursor(messages, state?.last_message_id);
        if (!delta.cursorFound) {
          console.warn(`[memory-intelligence] auto-save cursor not found for ${sessionID}; reprocessing full transcript with object-level deduplication.`);
        }
        const extractionResults: any[] = [];
        if (autoSaveConfig.extractNewObjects && memory.intelligenceEnabled && memory.allowRemoteProcessing && delta.messages.length) {
          const chunks = splitMessagesForExtraction(delta.messages, autoSaveConfig.maxTranscriptCharsPerChunk);
          for (let index = 0; index < chunks.length; index++) {
            const result = await memory.extract({ projectId, sessionId: sessionID, taskId: sessionRecord?.task_id || undefined,
              title, transcript: chunks[index], sourceRef: `${checkpointId}:token-auto-save:${index + 1}` });
            extractionResults.push(result);
          }
        }

        const result = {
          tokenThreshold: autoSaveConfig.tokenThreshold,
          totalTokens: measurement.totalTokens,
          tokensSincePreviousSave: tokenDelta,
          tokenSource: measurement.source,
          messageCount: messages.length,
          newlyProcessedMessages: delta.messages.length,
          cursorFound: delta.cursorFound,
          checkpointId,
          extractionChunks: extractionResults.length,
          extractedEntities: extractionResults.reduce((sum, item) => sum + Number(item?.newEntityCount || 0), 0),
          duplicateEntities: extractionResults.reduce((sum, item) => sum + Number(item?.duplicateEntityCount || 0), 0),
          newFacts: extractionResults.reduce((sum, item) => sum + Number(item?.factCount || 0), 0),
          duplicateFacts: extractionResults.reduce((sum, item) => sum + Number(item?.duplicateFactCount || 0), 0),
          newDecisions: extractionResults.reduce((sum, item) => sum + Number(item?.decisionCount || 0), 0),
          duplicateDecisions: extractionResults.reduce((sum, item) => sum + Number(item?.duplicateDecisionCount || 0), 0),
          historySource: history.source,
          extractionDisabled: !autoSaveConfig.extractNewObjects || !memory.intelligenceEnabled || !memory.allowRemoteProcessing,
        };
        memory.completeSessionAutoSaveRun({ runId, projectId, opencodeSessionId: sessionID, transcriptHash,
          totalTokens: measurement.totalTokens, tokenSource: measurement.source, messageCount: messages.length,
          lastMessageId, checkpointId, result });
        memory.event(projectId, "SESSION_AUTO_SAVE_COMPLETED", result, sessionID, sessionRecord?.task_id || undefined,
          `auto-save:${sessionID}:${transcriptHash}`);
        console.info("[memory-intelligence] token-threshold auto-save completed", result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (runId) memory.failSessionAutoSaveRun(runId, message);
        memory.event(projectId, "SESSION_AUTO_SAVE_FAILED", { error: message.slice(0, 1000) }, sessionID);
        console.error(`[memory-intelligence] automatic session save failed for ${sessionID}:`, message);
      } finally {
        autoSaveInFlight.delete(sessionID);
        if (autoSavePending.delete(sessionID)) queueMicrotask(() => { void autoSaveSession(sessionID); });
      }
    };

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "memory", description: "Shared project memory, hybrid semantic retrieval, Knowledge Graph RAG and Memory Intelligence. One database is shared by all OpenCode agents and plugins." });

      editor.add({ name: "write", description: "Write a durable project memory record with source provenance and graph links.",
        input: { type: "object", properties: { projectId: { type: "string" }, sessionId: { type: "string" }, taskId: { type: "string" }, kind: { type: "string" }, title: { type: "string" }, content: { type: "string" }, source: { type: "string" }, sourceRef: { type: "string" }, importance: { type: "number" }, confidence: { type: "number" }, status: { type: "string" }, tags: { type: "array", items: { type: "string" } }, concepts: { type: "array", items: { type: "string" } } }, required: ["kind", "title", "content"], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(await memory.writeMemoryDeduplicated(scoped(input, projectId))) });

      editor.add({ name: "list", description: "List recent or filtered active project memories with IDs, provenance and short content previews.",
        input: { type: "object", properties: { projectId: { type: "string" }, kind: { type: "string" }, status: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.listMemories(input.projectId || projectId, input)) });

      editor.add({ name: "forget", description: "Soft-delete a memory from recall. The record remains recoverable in SQLite; FTS and vector search entries are removed.",
        input: { type: "object", properties: { projectId: { type: "string" }, memoryId: { type: "string" }, reason: { type: "string" } }, required: ["memoryId"], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.forgetMemory(input.projectId || projectId, input.memoryId, input.reason)) });

      editor.add({ name: "restore", description: "Restore a previously forgotten memory to active search; vector embeddings can be regenerated with memory_vector_reindex.",
        input: { type: "object", properties: { projectId: { type: "string" }, memoryId: { type: "string" } }, required: ["memoryId"], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.restoreMemory(input.projectId || projectId, input.memoryId)) });

      editor.add({ name: "search", description: "Exact lexical retrieval from project memory (FTS5 with fallback), including IDs and provenance.",
        input: { type: "object", properties: { projectId: { type: "string" }, query: { type: "string" }, sessionId: { type: "string" }, taskId: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.searchMemory(scoped(input, projectId))) });

      editor.add({ name: "semantic_search", description: "Hybrid retrieval: vector KNN + FTS5 + Knowledge Graph RAG with provenance and freshness weighting.",
        input: { type: "object", properties: { projectId: { type: "string" }, query: { type: "string" }, sessionId: { type: "string" }, taskId: { type: "string" }, limit: { type: "number" }, vectorCandidates: { type: "number" } }, required: ["query"], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(await memory.semanticSearch(scoped(input, projectId))) });

      editor.add({ name: "vector_reindex", description: "Index pending or outdated memory chunks using the configured embedding model.",
        input: { type: "object", properties: { projectId: { type: "string" }, limit: { type: "number" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(await memory.reindexPending(scoped(input, projectId))) });

      editor.add({ name: "embedding_status", description: "Check embedding provider, API connection, sqlite-vec availability and index coverage.",
        input: { type: "object", properties: { projectId: { type: "string" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(await memory.embeddingStatus(input.projectId || projectId)) });

      editor.add({ name: "intelligence_extract", description: "Extract entities, time-aware facts, decisions, risks and open questions from a transcript. Idempotent for the same source content.",
        input: { type: "object", properties: { projectId: { type: "string" }, transcript: {}, sessionId: { type: "string" }, taskId: { type: "string" }, title: { type: "string" }, sourceRef: { type: "string" } }, required: ["transcript"], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(await memory.extract(scoped(input, projectId))) });

      editor.add({ name: "intelligence_status", description: "Show Memory Intelligence provider/model settings and counts for entities, claims, decisions, conflicts and extractions.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async () => jsonResult(memory.intelligenceStatus()) });

      editor.add({ name: "intelligence_consolidate", description: "Find duplicate claims, decisions and memories; create review candidates without deleting source records.",
        input: { type: "object", properties: { projectId: { type: "string" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.intelligenceConsolidate(input.projectId || projectId)) });

      editor.add({ name: "intelligence_report", description: "Report knowledge-graph health, recent decisions and unresolved contradictions.",
        input: { type: "object", properties: { projectId: { type: "string" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.intelligenceReport(input.projectId || projectId)) });

      editor.add({ name: "conflicts", description: "List conflicting claims and their evidence, confidence and temporal ranges.",
        input: { type: "object", properties: { projectId: { type: "string" }, status: { type: "string", enum: ["open", "resolved", "all"] }, limit: { type: "number" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.conflicts(input.projectId || projectId, input.status || "open", input.limit || 50)) });

      editor.add({ name: "conflict_resolve", description: "Resolve a contradiction explicitly; optionally select the accepted claim. No automatic winner is chosen.",
        input: { type: "object", properties: { projectId: { type: "string" }, conflictId: { type: "string" }, resolution: { type: "string" }, acceptedClaimId: { type: "string" } }, required: ["conflictId", "resolution"], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.resolveConflict(scoped(input, projectId))) });

      editor.add({ name: "state_at", description: "Reconstruct project knowledge at a historical timestamp using valid time and known-at time.",
        input: { type: "object", properties: { projectId: { type: "string" }, asOf: { type: "string" }, knownAt: { type: "string" }, includeMemory: { type: "boolean" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.projectStateAt(scoped(input, projectId))) });

      editor.add({ name: "graph_query", description: "Traverse the project's Knowledge Graph from matched nodes.",
        input: { type: "object", properties: { projectId: { type: "string" }, query: { type: "string" }, depth: { type: "number" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.graphQuery(scoped(input, projectId))) });

      editor.add({ name: "checkpoint", description: "Persist the current transcript or milestone before compaction or handoff.",
        input: { type: "object", properties: { projectId: { type: "string" }, sessionId: { type: "string" }, taskId: { type: "string" }, transcript: {}, summary: { type: "string" }, type: { type: "string" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.checkpoint(scoped(input, projectId))) });

      editor.add({ name: "consolidate", description: "Run a non-destructive duplicate-memory audit.",
        input: { type: "object", properties: { projectId: { type: "string" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.consolidate(input.projectId || projectId)) });

      editor.add({ name: "database_backup", description: "Create a consistent local SQLite backup.",
        input: { type: "object", properties: { projectId: { type: "string" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.createBackup(input.projectId || projectId)) });

      editor.add({ name: "export", description: "Export consolidated project memory to Markdown; SQLite remains the source of truth.",
        input: { type: "object", properties: { projectId: { type: "string" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.exportMemory(input.projectId || projectId)) });

      editor.add({ name: "file_lock", description: "Acquire a cooperative file ownership lock for agent coordination.",
        input: { type: "object", properties: { projectId: { type: "string" }, filePath: { type: "string" }, ownerSessionId: { type: "string" }, purpose: { type: "string" }, ttlMinutes: { type: "number" } }, required: ["filePath", "ownerSessionId"], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.lockFile(input.projectId || projectId, input.filePath, input.ownerSessionId, input.purpose, input.ttlMinutes)) });

      editor.add({ name: "autosave_status", description: "Show token-threshold auto-save settings, latest session checkpoints and run statistics.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async () => jsonResult({ config: autoSaveConfig, status: memory.sessionAutoSaveStatus(projectId) }) });

      editor.add({ name: "project_report", description: "Return project, task, session and memory status from the shared knowledge database.",
        input: { type: "object", properties: { projectId: { type: "string" } }, required: [], additionalProperties: false },
        options: { namespace: "memory", codemode: true }, execute: async (input: any) => jsonResult(memory.report(input.projectId || projectId)) });
    });

    // Persist a durable transcript checkpoint before context compaction. Extraction is best-effort.
    await ctx.session.hook("compaction", async (event: any) => {
      const saved = memory.checkpoint({ projectId, sessionId: event.sessionID, transcript: event.messages,
        summary: "Pre-compaction transcript snapshot. OpenCode will now create its continuation summary.", type: "pre_compaction" });
      if (!saved.saved) throw new Error("Memory checkpoint was not confirmed; retry compaction after storage recovery.");
      if (memory.intelligenceEnabled && memory.autoExtractOnCompaction && memory.allowRemoteProcessing) {
        try {
          const session = memory.findSession(projectId, event.sessionID);
          const result = await memory.extract({ projectId, sessionId: event.sessionID, taskId: session?.task_id,
            title: session?.title || "OpenCode session", transcript: event.messages, sourceRef: saved.checkpointId });
          console.log("[memory-intelligence] compaction extraction:", JSON.stringify(result));
        } catch (error) {
          console.warn("[memory-intelligence] extraction failed; checkpoint remains saved:", error);
        }
      }
    });

    // Automatic relevance-based recall: embed the latest authored user prompt and
    // inject only the most relevant project knowledge. Cache same-prompt tool loops.
    await ctx.session.hook("context", async (event: any) => {
      if (!recallConfig.enabled) return;
      try {
        const query = extractLatestUserPrompt(event.messages);
        const queryHash = hashTranscript([{ role: "user", content: query }]);
        const cached = recallCache.get(event.sessionID);
        const now = Date.now();
        let context: string;
        if (cached && cached.queryHash === queryHash && cached.expiresAt > now) {
          context = cached.text;
        } else {
          context = await memory.buildRelevantContextPack(projectId, event.sessionID, query, {
            maxMemories: recallConfig.maxMemories,
            maxChars: recallConfig.maxContextChars,
            mode: recallConfig.mode,
            includeRecentFallback: recallConfig.includeRecentFallback,
          });
          recallCache.set(event.sessionID, { queryHash, text: context, expiresAt: now + recallConfig.cacheMs });
          if (recallCache.size > 100) {
            const oldestKey = recallCache.keys().next().value;
            if (oldestKey) recallCache.delete(oldestKey);
          }
          if (context) memory.event(projectId, "MEMORY_CONTEXT_INJECTED", {
            queryHash, queryLength: query.length, resultCharacters: context.length, mode: recallConfig.mode,
          }, event.sessionID, undefined, `recall:${event.sessionID}:${queryHash}`);
        }
        if (context) event.system.push({ type: "text", text: `\n<memory_intelligence_context>\n${context}\n</memory_intelligence_context>` });
      } catch (error) {
        // Recall is non-blocking; a model request must still proceed if memory is unavailable.
        try {
          const fallback = memory.buildContextPack(projectId, event.sessionID);
          if (fallback) event.system.push({ type: "text", text: `\n<memory_intelligence_context>\n${fallback}\n</memory_intelligence_context>` });
        } catch { /* Keep the host request independent of memory health. */ }
        console.error("[memory-intelligence] relevant context assembly failed:", error);
      }
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const value = event as any;
          const type = value.type || "UNKNOWN";
          // V2 events carry payload in `data`; helper keeps a V1 `properties` fallback.
          const payload = value.data || value.properties || {};
          const sessionID = getSessionIdFromEvent(value);
          memory.event(projectId, `OPENCODE_${String(type).toUpperCase().replaceAll(".", "_")}`, payload,
            sessionID, undefined, `${type}:${sessionID || "global"}:${JSON.stringify(payload).slice(0, 500)}`);
          // Check only after an execution ends; session.idle remains a compatibility trigger.
          if (isSessionCompletionEvent(type) && sessionID && autoSaveConfig.enabled && autoSaveConfig.checkOnSessionIdle) {
            void autoSaveSession(sessionID);
          }
        } catch (error) {
          console.error("[memory-intelligence] event persistence failed:", error);
        }
      }
    })().catch((error) => console.error("[memory-intelligence] event stream stopped:", error));

    await ctx.command.transform((editor) => {
      editor.add({ name: "memory-search", description: "Hybrid semantic search in shared project memory", execute: async ({ sessionID, prompt }) => {
        const query = prompt.text?.trim() || "recent project decisions and current state";
        const result = await memory.semanticSearch({ projectId, query, limit: 12 });
        await ctx.session.synthetic({ sessionID, text: `MEMORY SEARCH: ${query}\n${JSON.stringify(result, null, 2)}` });
      }});
      editor.add({ name: "memory-list", description: "List the latest active project memories", execute: async ({ sessionID, prompt }) => {
        const query = prompt.text?.trim();
        const result = memory.listMemories(projectId, { query: query || undefined, limit: 30 });
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(result, null, 2) });
      }});
      editor.add({ name: "memory-forget", description: "Soft-delete a memory by its memory ID. Record remains recoverable in SQLite.", execute: async ({ sessionID, prompt }) => {
        const memoryId = prompt.text?.trim() || "";
        const result = memory.forgetMemory(projectId, memoryId, "forgotten_via_slash_command");
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(result, null, 2) });
      }});
      editor.add({ name: "memory-restore", description: "Restore a forgotten memory by ID", execute: async ({ sessionID, prompt }) => {
        const memoryId = prompt.text?.trim() || "";
        const result = memory.restoreMemory(projectId, memoryId);
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(result, null, 2) });
      }});
      editor.add({ name: "memory-status", description: "Show Memory Intelligence and embedding status", execute: async ({ sessionID }) => {
        await ctx.session.synthetic({ sessionID, text: JSON.stringify({
          intelligence: memory.intelligenceStatus(),
          embedding: await memory.embeddingStatus(projectId),
          autoSave: { config: autoSaveConfig, status: memory.sessionAutoSaveStatus(projectId) },
          recall: recallConfig,
          deduplication: { enabled: memory.deduplicationEnabled, similarityThreshold: memory.deduplicationSimilarityThreshold },
        }, null, 2) });
      }});
      editor.add({ name: "memory-checkpoint", description: "Create a durable checkpoint of the current session context", execute: async ({ sessionID }) => {
        const messages = await ctx.session.context({ sessionID });
        const result = memory.checkpoint({ projectId, sessionId: sessionID, transcript: messages, summary: "Manual checkpoint", type: "manual" });
        await ctx.session.synthetic({ sessionID, text: `Memory checkpoint saved: ${JSON.stringify(result)}` });
      }});
      editor.add({ name: "memory-consolidate", description: "Run non-destructive memory and knowledge consolidation", execute: async ({ sessionID }) => {
        await ctx.session.synthetic({ sessionID, text: JSON.stringify({ memory: memory.consolidate(projectId), intelligence: memory.intelligenceConsolidate(projectId) }, null, 2) });
      }});
      editor.add({ name: "memory-intelligence", description: "Show Memory Intelligence knowledge report", execute: async ({ sessionID }) => {
        await ctx.session.synthetic({ sessionID, text: JSON.stringify({ status: memory.intelligenceStatus(), report: memory.intelligenceReport(projectId) }, null, 2) });
      }});
      editor.add({ name: "memory-conflicts", description: "List unresolved knowledge conflicts", execute: async ({ sessionID }) => {
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(memory.conflicts(projectId, "open", 50), null, 2) });
      }});
      editor.add({ name: "memory-state", description: "Reconstruct knowledge at a historical timestamp", execute: async ({ sessionID, prompt }) => {
        const asOf = prompt.text?.trim() || undefined;
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(memory.projectStateAt({ projectId, asOf }), null, 2) });
      }});
      editor.add({ name: "memory-reindex", description: "Index pending memory chunks with the configured embedding model", execute: async ({ sessionID }) => {
        const result = await memory.reindexPending({ projectId, limit: 500 });
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(result, null, 2) });
      }});
      editor.add({ name: "memory-autosave-status", description: "Show token-threshold automatic session-save settings and recent save runs", execute: async ({ sessionID }) => {
        await ctx.session.synthetic({ sessionID, text: JSON.stringify({ config: autoSaveConfig, status: memory.sessionAutoSaveStatus(projectId) }, null, 2) });
      }});
    });

    console.log(`[memory-intelligence] plugin ready for ${projectRoot}; shared database ${memory.databasePath}`);
    return () => { controller.abort(); lease.release(); };
  }
});
