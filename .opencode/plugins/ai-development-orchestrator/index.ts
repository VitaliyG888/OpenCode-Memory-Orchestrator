import { Plugin } from "@opencode/plugin";
import { createHash } from "node:crypto";
import { acquireMemoryIntelligence } from "opencode-memory-intelligence-core";
import { readOpenCodeSessionHistory } from "./session-history";

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function parseJsonSafe(value: unknown, fallback: any = []) {
  try { return typeof value === "string" ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
}

function messageId(message: any): string | null {
  const value = message?.info?.id || message?.id || message?.data?.id;
  return value ? String(value) : null;
}

const INGEST_REPORT_MARKER = "<!-- ORCH_SESSION_INGEST_REPORT -->";

function ingestReport(text: string): string {
  return `${INGEST_REPORT_MARKER}\n${text}`;
}

function messageTimestamp(message: any): number {
  const value = message?.time_created ?? message?.info?.time?.created ?? message?.info?.createdAt ?? message?.data?.time?.created;
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function transcriptPartText(part: any): string {
  if (part == null) return "";
  if (typeof part === "string") return part;
  if (Array.isArray(part)) return part.map(transcriptPartText).filter(Boolean).join("\n");
  if (typeof part !== "object") return String(part);
  if (part.type === "reasoning" || part.type === "redacted-reasoning") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (Array.isArray(part.content)) return part.content.map(transcriptPartText).filter(Boolean).join("\n");
  const state = part.state && typeof part.state === "object" ? part.state : {};
  const fragments: string[] = [];
  const toolName = String(part.tool || part.name || "tool");
  const input = part.input ?? state.input;
  const output = part.output ?? state.output;
  if (input !== undefined) fragments.push(`[tool ${toolName} input]\n${typeof input === "string" ? input : JSON.stringify(input)}`);
  if (output !== undefined) fragments.push(`[tool ${toolName} output]\n${typeof output === "string" ? output : JSON.stringify(output)}`);
  if (Array.isArray(state.content) && state.content.length) {
    fragments.push(`[tool ${toolName} result]\n${state.content.map(transcriptPartText).filter(Boolean).join("\n")}`);
  }
  if (state.error !== undefined || part.error !== undefined) {
    const error = state.error ?? part.error;
    fragments.push(`[tool ${toolName} error]\n${typeof error === "string" ? error : JSON.stringify(error)}`);
  }
  if (fragments.length) return fragments.join("\n");
  const compact: Record<string, unknown> = {};
  for (const key of ["type", "name", "tool", "status", "error", "input", "output", "command", "title", "path", "url", "callID", "patch", "filename", "fileName", "mime", "mimeType", "size", "hash"]) {
    if (part[key] !== undefined && typeof part[key] !== "object") compact[key] = part[key];
  }
  if (state.status) compact.status = state.status;
  return Object.keys(compact).length ? JSON.stringify(compact) : "";
}

function transcriptMessageText(message: any, index: number): string {
  const info = message?.info || message?.data || message || {};
  const role = String(info.role || message?.role || info.type || message?.type || "message");
  const parts = asArray(message?.parts).length ? asArray(message.parts) :
    asArray(info.content).length ? asArray(info.content) : asArray(message?.content);
  let body = parts.map(transcriptPartText).filter(Boolean).join("\n");
  if (!body && typeof message?.text === "string") body = message.text;
  if (!body && typeof info.text === "string") body = info.text;
  if (!body && typeof info.summary === "string") body = info.summary;
  if (!body && typeof info.content === "string") body = info.content;
  if (!body) {
    const structured = { type: role, name: info.name, tool: info.tool, status: info.status, error: info.error };
    body = Object.values(structured).some(Boolean) ? JSON.stringify(structured) : "";
  }
  const timestamp = messageTimestamp(message);
  const timeLabel = timestamp ? new Date(timestamp).toISOString() : `message ${index + 1}`;
  return body.trim() ? `[${role} · ${timeLabel}]\n${body.trim()}` : "";
}

function splitTranscriptText(messages: any[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length) chunks.push(current.join("\n\n"));
    current = []; currentChars = 0;
  };
  messages.forEach((message, index) => {
    const rendered = transcriptMessageText(message, index);
    if (!rendered) return;
    if (rendered.length > maxChars) {
      flush();
      let remaining = rendered;
      while (remaining.length > maxChars) {
        let cut = remaining.lastIndexOf("\n", maxChars);
        if (cut < Math.floor(maxChars * 0.55)) cut = maxChars;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      }
      if (remaining.trim()) chunks.push(remaining);
      return;
    }
    if (currentChars + rendered.length + 2 > maxChars) flush();
    current.push(rendered); currentChars += rendered.length + 2;
  });
  flush();
  return chunks;
}

function mergeSessionMessages(primary: any[], checkpoints: any[][], activeContext: any[]): any[] {
  const byId = new Map<string, any>();
  const anonymous = new Set<string>();
  const add = (message: any) => {
    if (!message || typeof message !== "object") return;
    const stableId = messageId(message);
    if (stableId) {
      if (!byId.has(stableId)) byId.set(stableId, message);
      return;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(message)).digest("hex");
    if (!anonymous.has(fingerprint)) { anonymous.add(fingerprint); byId.set(`anon:${fingerprint}`, message); }
  };
  // Persisted OpenCode DB is canonical and already sequence ordered.
  primary.forEach(add);
  // Checkpoints and active context can recover missing entries when a DB projection is incomplete.
  checkpoints.flat().forEach(add);
  activeContext.forEach(add);
  return [...byId.values()].filter((message) => {
    const rendered = transcriptMessageText(message, 0);
    return !rendered.includes(INGEST_REPORT_MARKER) &&
      !/SESSION INGESTION (?:ALREADY COMPLETED|COMPLETED|FAILED)/i.test(rendered);
  }).sort((a, b) => {
    const ta = messageTimestamp(a), tb = messageTimestamp(b);
    return ta && tb ? ta - tb : 0;
  });
}

export default Plugin.define({
  id: "ai-development-orchestrator",
  async setup(ctx) {
    const projectRoot = ctx.location.project.canonical || ctx.location.directory;
    const projectName = projectRoot.split(/[\\/]/).filter(Boolean).pop() || "OpenCode Project";
    // The Orchestrator is a consumer. The shared package owns storage, embeddings and graph retrieval.
    const lease = acquireMemoryIntelligence(projectRoot);
    const memory = lease.client;
    const projectId = memory.ensureProject(projectName, projectRoot, "Project registered by AI Development Orchestrator");
    const ensureProject = () => memory.ensureProject(projectName, projectRoot, "Project registered by AI Development Orchestrator");

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "orchestrator", description: "Project/task/session planning and orchestration. Shared memory and semantic retrieval are provided by the independent memory plugin." });

      editor.add({ name: "project_register", description: "Register or update this project in the shared project knowledge database.",
        input: { type: "object", properties: { name: { type: "string" }, goal: { type: "string" } }, required: ["name", "goal"], additionalProperties: false },
        options: { namespace: "orchestrator", codemode: true },
        execute: async (input: any) => ({ content: JSON.stringify(memory.registerProject({ name: input.name, goal: input.goal, rootPath: projectRoot })) }) });

      editor.add({ name: "task_create", description: "Create a durable task or subtask with acceptance criteria and dependencies.",
        input: { type: "object", properties: { projectId: { type: "string" }, parentTaskId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, acceptanceCriteria: { type: "array", items: { type: "string" } }, priority: { type: "number" }, dependencies: { type: "array", items: { type: "string" } } }, required: ["projectId", "title", "description"], additionalProperties: false },
        options: { namespace: "orchestrator", codemode: true }, execute: async (input: any) => ({ content: JSON.stringify(memory.createTask(input)) }) });

      editor.add({ name: "task_update", description: "Update task status or metadata and append a temporal task version.",
        input: { type: "object", properties: { projectId: { type: "string" }, taskId: { type: "string" }, status: { type: "string", enum: ["planned", "ready", "in_progress", "blocked", "completed", "cancelled", "failed"] }, result: { type: "string" }, priority: { type: "number" }, title: { type: "string" }, description: { type: "string" }, validFrom: { type: "string" }, reason: { type: "string" } }, required: ["projectId", "taskId"], additionalProperties: false },
        options: { namespace: "orchestrator", codemode: true }, execute: async (input: any) => ({ content: JSON.stringify(memory.updateTask(input)) }) });

      editor.add({ name: "session_update", description: "Update a registered OpenCode session and append a temporal session version.",
        input: { type: "object", properties: { projectId: { type: "string" }, sessionId: { type: "string" }, status: { type: "string", enum: ["created", "in_progress", "completed", "partial", "blocked", "failed", "cancelled"] }, summary: { type: "string" }, validFrom: { type: "string" }, reason: { type: "string" } }, required: ["projectId", "sessionId", "status"], additionalProperties: false },
        options: { namespace: "orchestrator", codemode: true }, execute: async (input: any) => ({ content: JSON.stringify(memory.updateSession(input)) }) });

      editor.add({ name: "session_spawn", description: "Create a linked OpenCode child session, register it, and send it a scoped task with relevant shared memory.",
        input: { type: "object", properties: { projectId: { type: "string" }, parentOpenCodeSessionId: { type: "string" }, parentOrchestratorSessionId: { type: "string" }, taskId: { type: "string" }, title: { type: "string" }, taskPrompt: { type: "string" }, contextPack: { type: "string" }, agent: { type: "string" } }, required: ["projectId", "title", "taskPrompt"], additionalProperties: false },
        options: { namespace: "orchestrator", codemode: true },
        execute: async (input: any, toolContext: any) => {
          const parentOpenCodeSessionId = input.parentOpenCodeSessionId || toolContext.sessionID;
          const child = await ctx.session.create({ title: input.title, ...(parentOpenCodeSessionId ? { parentID: parentOpenCodeSessionId } : {}) });
          const record = memory.createSessionRecord({ projectId: input.projectId, opencodeSessionId: child.id, parentSessionId: input.parentOrchestratorSessionId, taskId: input.taskId, title: input.title });
          if (input.agent) await ctx.session.switchAgent({ sessionID: child.id, agent: input.agent });
          const generatedContext = input.contextPack || memory.buildContextPack(input.projectId, parentOpenCodeSessionId || "");
          const prompt = [
            "You are executing one scoped subtask for AI Development Orchestrator.",
            `Task ID: ${input.taskId || "not assigned"}`,
            `Orchestrator session ID: ${record.orchestratorSessionId}`,
            "Do not expand scope. Report files, decisions, tests, blockers and next steps.",
            "Use memory_write / memory_semantic_search tools from Memory Intelligence for durable findings.",
            generatedContext ? `\nSHARED MEMORY CONTEXT:\n${generatedContext}` : "",
            `\nTASK:\n${input.taskPrompt}`
          ].join("\n");
          await ctx.session.prompt({ sessionID: child.id, text: prompt });
          return { content: JSON.stringify({ ...record, title: input.title, status: "created_and_prompted" }) };
        } });
    });

    await ctx.command.transform((editor) => {
      editor.add({ name: "orch-status", description: "Show project and task status from the shared database", execute: async ({ sessionID }) => {
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(memory.report(ensureProject()), null, 2) });
      }});
      editor.add({ name: "orch-memory", description: "Search shared project memory using hybrid semantic retrieval", execute: async ({ sessionID, prompt }) => {
        const query = prompt.text?.trim() || "recent project decisions and current state";
        const result = await memory.semanticSearch({ projectId: ensureProject(), query, limit: 12 });
        await ctx.session.synthetic({ sessionID, text: `HYBRID MEMORY SEARCH: ${query}\n${JSON.stringify(result, null, 2)}` });
      }});
      editor.add({ name: "orch-checkpoint", description: "Create a manual checkpoint for the current OpenCode session", execute: async ({ sessionID }) => {
        const messages = await ctx.session.context({ sessionID });
        const result = memory.checkpoint({ projectId: ensureProject(), sessionId: sessionID, transcript: messages, summary: "Manual checkpoint requested by Orchestrator", type: "manual" });
        await ctx.session.synthetic({ sessionID, text: `Checkpoint saved: ${JSON.stringify(result)}` });
      }});

      editor.add({ name: "orch-ingest-session", description: "Read the existing current session history, preserve it in shared memory, extract knowledge and create an idempotent task tree", execute: async ({ sessionID }) => {
        const projectId = ensureProject();
        let ingestionId: string | undefined;
        let checkpointId: string | undefined;
        let activeContextWarning: string | undefined;
        try {
          let sessionInfo: any = null;
          try { sessionInfo = await ctx.session.get({ sessionID }) as any; } catch { /* persisted session history remains the fallback */ }
          const sessionTitle = String(sessionInfo?.title || "Current OpenCode session");
          let currentContext: any[] = [];
          try { currentContext = asArray(await ctx.session.context({ sessionID })); }
          catch (error) { activeContextWarning = `Could not read active context through the OpenCode plugin API: ${error instanceof Error ? error.message : String(error)}`; }
          const persisted = readOpenCodeSessionHistory(sessionID);
          const savedCheckpoints = memory.listSessionCheckpoints(sessionID);
          const checkpointMessages = savedCheckpoints.map((row: any) => asArray(parseJsonSafe(row.transcript_json, [])));
          const messages = mergeSessionMessages(persisted.messages, checkpointMessages, currentContext);
          if (!messages.length) throw new Error("Could not obtain messages for the current session. Check the session ID and OpenCode history access.");

          let orchestratorSession = memory.findSession(projectId, sessionID);
          if (!orchestratorSession) {
            memory.createSessionRecord({ projectId, opencodeSessionId: sessionID, title: sessionTitle });
            orchestratorSession = memory.findSession(projectId, sessionID);
          }
          if (!orchestratorSession) throw new Error("Failed to register the already-running OpenCode session in project storage.");

          const historyComplete = Boolean(persisted.complete);
          const historySource = persisted.complete ? persisted.source : checkpointMessages.length && currentContext.length
            ? "memory_checkpoints_plus_active_context" : checkpointMessages.length ? "memory_checkpoints_only" : "active_context_only";
          const transcriptHash = createHash("sha256").update(JSON.stringify({ historySource, historyComplete, messages })).digest("hex");
          const previous = memory.findSessionIngestion(projectId, sessionID, transcriptHash);
          if (previous?.status === "completed") {
            const priorReport = parseJsonSafe(previous.report_json, {});
            await ctx.session.synthetic({ sessionID, text: ingestReport(`SESSION INGESTION ALREADY COMPLETED\n\n${JSON.stringify(priorReport, null, 2)}`) });
            return;
          }

          // Save the original message objects before any remote model processing.
          const checkpoint = memory.checkpoint({ projectId, sessionId: sessionID, taskId: orchestratorSession.task_id || undefined,
            transcript: messages, summary: `Full-session ingestion snapshot (${messages.length} messages, source: ${historySource}).`, type: "session_ingest_full_transcript" });
          checkpointId = checkpoint.checkpointId;
          const begun = memory.beginSessionIngestion({ projectId, opencodeSessionId: sessionID, orchestratorSessionId: orchestratorSession.id,
            transcriptHash, checkpointId, historySource, historyComplete, messageCount: messages.length });
          ingestionId = begun.ingestionId;
          if (begun.alreadyCompleted) {
            const priorReport = parseJsonSafe(begun.existing?.report_json, {});
            await ctx.session.synthetic({ sessionID, text: ingestReport(`SESSION INGESTION ALREADY COMPLETED\n\n${JSON.stringify(priorReport, null, 2)}`) });
            return;
          }

          const chunkLimit = Math.max(1000, Math.min(36000, memory.maxTranscriptChars - 500));
          const transcriptChunks = splitTranscriptText(messages, chunkLimit);
          if (!transcriptChunks.length) throw new Error("The session history contains no textual messages; the raw checkpoint has still been saved.");
          const extractionResults: any[] = [];
          for (let index = 0; index < transcriptChunks.length; index++) {
            const result: any = await memory.extract({ projectId, sessionId: sessionID, title: sessionTitle,
              transcript: transcriptChunks[index], sourceRef: `${checkpointId}:chunk-${index + 1}-of-${transcriptChunks.length}` });
            if (result?.error) throw new Error(`Memory Intelligence chunk ${index + 1} failed: ${result.error}`);
            const normalizedResult = result?.reason === "already_extracted" && result?.result
              ? { ...result.result, extractionId: result.extractionId || result.result.extractionId, skipped: true, reused: true }
              : result;
            extractionResults.push(normalizedResult);
          }

          const existingTasks = memory.listTasksForSession(projectId, sessionID);
          if (!extractionResults.some((result) => result?.summary)) {
            throw new Error("Memory Intelligence returned no extraction summary. Check intelligence.enabled, allowRemoteProcessing and the configured API key. The transcript is already saved.");
          }
          const knowledgeSummary = {
            transcriptMessageCount: messages.length,
            extractionChunkCount: extractionResults.length,
            chunkSummaries: extractionResults.map((result, index) => ({ chunk: index + 1, summary: result.summary || "",
              milestones: result.milestones || [], decisions: result.decisions || [], facts: result.facts || [],
              risks: result.risks || [], openQuestions: result.openQuestions || [], entityCount: result.entityCount,
              decisionCount: result.decisionCount, conflictCount: result.conflictCount })),
            existingTasks
          };
          const taskPlan = await memory.planTasks({ projectId, sessionId: sessionID, title: sessionTitle, knowledgeSummary, existingTasks });
          const taskTree = memory.createIngestTaskPlan({ projectId, opencodeSessionId: sessionID, ingestionId, plan: taskPlan });
          const report = { ingestionId, sessionID, sessionTitle, checkpointId, historySource, historyComplete, messageCount: messages.length,
            transcriptChunks: transcriptChunks.length, extractionResults: extractionResults.map((result) => ({ extractionId: result.extractionId,
              entityCount: result.entityCount || 0, factCount: result.factCount || 0, decisionCount: result.decisionCount || 0,
              conflictCount: result.conflictCount || 0, skipped: result.skipped || false })), taskTree,
            planningNotes: taskPlan.planning_notes, risks: taskPlan.risks,
            historyWarning: persisted.warning || activeContextWarning || (!historyComplete ? "The complete source history was unavailable; only available checkpoints and active context were analyzed." : null) };
          memory.completeSessionIngestion({ ingestionId, projectId, mainTaskId: taskTree.mainTaskId, taskIds: taskTree.taskIds,
            extractionIds: extractionResults.map((result) => result.extractionId).filter(Boolean), report });

          const taskLines = [
            `MAIN: ${taskTree.mainTaskTitle} [${taskTree.mainTaskId}]`,
            ...taskTree.subtasks.map((task: any) => {
              const dependencies = task.dependsOn.map((id: string) => {
                const match = taskTree.subtasks.find((candidate: any) => candidate.taskId === id);
                return match ? `${match.key}: ${match.title}` : id;
              });
              return `  - ${task.key} ${task.title} [${task.taskId}] · priority ${task.priority} · ${task.status}${dependencies.length ? ` · depends on ${dependencies.join(", ")}` : ""}`;
            })
          ];
          const coverage = historySource === "opencode_sqlite" ? "Complete transcript read from OpenCode's local SQLite database (read-only)."
            : historySource === "opencode_cli_export" ? "Complete transcript read from OpenCode CLI export." : `WARNING: partial history source (${historySource}).`;
          const counts = extractionResults.reduce((sum, result) => ({ entities: sum.entities + (result.entityCount || 0), facts: sum.facts + (result.factCount || 0),
            decisions: sum.decisions + (result.decisionCount || 0), conflicts: sum.conflicts + (result.conflictCount || 0) }),
            { entities: 0, facts: 0, decisions: 0, conflicts: 0 });
          const output = ["# SESSION INGESTION COMPLETED", "", `Session: ${sessionTitle} (${sessionID})`,
            `Messages: ${messages.length} · transcript chunks: ${transcriptChunks.length}`, `Checkpoint: ${checkpointId}`, `History: ${coverage}`,
            `Memory Intelligence: ${counts.entities} entities, ${counts.facts} facts, ${counts.decisions} decisions, ${counts.conflicts} conflicts`,
            "", "## Created / updated task tree", ...taskLines,
            taskPlan.planning_notes?.length ? `\n## Planning notes\n${taskPlan.planning_notes.map((x: string) => `- ${x}`).join("\n")}` : "",
            taskPlan.risks?.length ? `\n## Risks\n${taskPlan.risks.map((x: string) => `- ${x}`).join("\n")}` : "",
            !historyComplete ? `\n## History coverage warning\n${persisted.warning || activeContextWarning || "Some messages may not be present before the first checkpoint."}` : activeContextWarning ? `\n## Active context warning\n${activeContextWarning}` : "",
            "\nThe original transcript remains in the shared local Memory Intelligence database. Existing OpenCode session continued; no new session was created."].filter(Boolean).join("\n");
          await ctx.session.synthetic({ sessionID, text: ingestReport(output) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ingestionId) memory.failSessionIngestion(ingestionId, projectId, message);
          await ctx.session.synthetic({ sessionID, text: ingestReport(["# SESSION INGESTION FAILED", "", message,
            checkpointId ? `Raw transcript checkpoint saved: ${checkpointId}` : "No transcript checkpoint was confirmed.",
            "Correct the issue and rerun /orch-ingest-session; successful extraction chunks are idempotent."].join("\n")) });
        }
      }});

      editor.add({ name: "orch-report", description: "Generate a combined project/task/memory status report", execute: async ({ sessionID }) => {
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(memory.report(ensureProject()), null, 2) });
      }});
      editor.add({ name: "orch-consolidate", description: "Run non-destructive memory and knowledge consolidation", execute: async ({ sessionID }) => {
        const id = ensureProject();
        await ctx.session.synthetic({ sessionID, text: JSON.stringify({ memory: memory.consolidate(id), intelligence: memory.intelligenceConsolidate(id) }, null, 2) });
      }});
      editor.add({ name: "orch-intelligence", description: "Show shared Memory Intelligence report", execute: async ({ sessionID }) => {
        const id = ensureProject();
        await ctx.session.synthetic({ sessionID, text: JSON.stringify({ status: memory.intelligenceStatus(), report: memory.intelligenceReport(id) }, null, 2) });
      }});
      editor.add({ name: "orch-state", description: "Reconstruct the recorded project state at a historical time", execute: async ({ sessionID, prompt }) => {
        const asOf = prompt.text?.trim() || undefined;
        await ctx.session.synthetic({ sessionID, text: JSON.stringify(memory.projectStateAt({ projectId: ensureProject(), asOf }), null, 2) });
      }});
    });

    console.log(`[ai-development-orchestrator] ready for ${projectRoot}; consuming ${memory.databasePath}`);
    return () => lease.release();
  }
});
