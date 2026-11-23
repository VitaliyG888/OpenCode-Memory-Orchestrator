import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMemoryIntelligence } from "opencode-memory-intelligence-core";
import { readOpenCodeSessionHistory } from "./session-history";

const root = mkdtempSync(join(tmpdir(), "orch-ingest-test-"));
const previousOpenCodeDb = process.env.OPENCODE_DB;
const lease = acquireMemoryIntelligence(root);
let openCodeDb: Database | undefined;
try {
  // Verify read-only import from the OpenCode V2 message schema.
  const openCodeDbPath = join(root, "opencode-test.db");
  openCodeDb = new Database(openCodeDbPath, { create: true });
  openCodeDb.exec(`
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    );
    CREATE TABLE session_part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, type TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    );
  `);
  const sessionID = "ses_ingest_smoke_001";
  const createdAt = Date.now();
  openCodeDb.query(`INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES(?,?,?,?,?,?)`).run(
    "msg_user_1", sessionID, "user", 1, createdAt,
    JSON.stringify({ id: "msg_user_1", role: "user", time: { created: createdAt }, content: [{ type: "text", text: "Build a durable session ingestion pipeline." }] })
  );
  openCodeDb.query(`INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES(?,?,?,?,?,?)`).run(
    "msg_assistant_1", sessionID, "assistant", 2, createdAt + 1000,
    JSON.stringify({ id: "msg_assistant_1", role: "assistant", time: { created: createdAt + 1000 }, content: [{ type: "text", text: "Parse the complete session history and create task dependencies." }] })
  );
  openCodeDb.close(); openCodeDb = undefined;
  process.env.OPENCODE_DB = openCodeDbPath;
  const history = readOpenCodeSessionHistory(sessionID);
  if (!history.complete || history.messages.length !== 2 || history.source !== "opencode_sqlite") {
    throw new Error(`OpenCode transcript import failed: ${JSON.stringify({ source: history.source, complete: history.complete, count: history.messages.length, warning: history.warning })}`);
  }

  const memory = lease.client;
  const projectId = memory.ensureProject("Session ingest smoke test", root, "Test full session ingest via the shared memory provider");
  const { orchestratorSessionId } = memory.createSessionRecord({ projectId, opencodeSessionId: sessionID, title: "Existing long-running session" });
  const checkpoint = memory.checkpoint({ projectId, sessionId: sessionID, transcript: history.messages, summary: "Raw full transcript", type: "session_ingest_full_transcript" });
  const first = memory.beginSessionIngestion({ projectId, opencodeSessionId: sessionID, orchestratorSessionId,
    transcriptHash: "sha256-smoke-001", checkpointId: checkpoint.checkpointId, historySource: history.source,
    historyComplete: true, messageCount: history.messages.length });
  const plan = {
    main_task: { title: "Ingest existing OpenCode session", description: "Preserve history and organize work into durable tasks.", priority: 1, status: "in_progress" },
    subtasks: [
      { key: "S1", title: "Read and normalize history", description: "Read persisted OpenCode messages.", acceptance_criteria: ["Two messages imported"], priority: 1, status: "completed", depends_on: [] },
      { key: "S2", title: "Extract durable knowledge", description: "Extract facts and decisions.", acceptance_criteria: ["Extraction linked to session"], priority: 2, status: "planned", depends_on: ["S1"] },
      { key: "S3", title: "Create linked task graph", description: "Create task records and dependencies.", acceptance_criteria: ["Dependency edges created"], priority: 2, status: "planned", depends_on: ["S2"] }
    ]
  };
  const taskTree = memory.createIngestTaskPlan({ projectId, opencodeSessionId: sessionID, ingestionId: first.ingestionId, plan });
  memory.completeSessionIngestion({ ingestionId: first.ingestionId, projectId, mainTaskId: taskTree.mainTaskId,
    taskIds: taskTree.taskIds, extractionIds: [], report: { ok: true, taskTree } });

  const s1 = taskTree.subtasks.find((task: any) => task.key === "S1")!;
  const s2 = taskTree.subtasks.find((task: any) => task.key === "S2")!;
  const s3 = taskTree.subtasks.find((task: any) => task.key === "S3")!;
  const s2Deps = JSON.parse(memory.getTask(projectId, s2.taskId).dependencies);
  const s3Deps = JSON.parse(memory.getTask(projectId, s3.taskId).dependencies);
  if (s2Deps[0] !== s1.taskId || s3Deps[0] !== s2.taskId) throw new Error("Task dependency IDs were not persisted correctly");
  if (memory.countTasks(projectId) !== 4) throw new Error("Expected one main task and three subtasks");
  if (memory.findSession(projectId, sessionID)?.task_id !== taskTree.mainTaskId) throw new Error("Existing session was not linked to the main task");
  if (memory.countGraphEdges(projectId, "depends_on") !== 2) throw new Error("Dependency graph edges are missing");

  const second = memory.beginSessionIngestion({ projectId, opencodeSessionId: sessionID, orchestratorSessionId,
    transcriptHash: "sha256-smoke-002", checkpointId: checkpoint.checkpointId, historySource: history.source,
    historyComplete: true, messageCount: history.messages.length + 1 });
  const revisedPlan = { ...plan, subtasks: plan.subtasks.map((task: any) => task.key === "S2"
    ? { ...task, title: "Extract durable knowledge (revised)" } : task) };
  const repeatedTree = memory.createIngestTaskPlan({ projectId, opencodeSessionId: sessionID, ingestionId: second.ingestionId, plan: revisedPlan });
  if (memory.countTasks(projectId) !== 4) throw new Error("Repeated ingestion duplicated tasks");
  if (repeatedTree.subtasks.find((task: any) => task.key === "S2")?.taskId !== s2.taskId) throw new Error("Stable task key did not reuse its previous task ID");
  if (memory.getTask(projectId, s2.taskId)?.title !== "Extract durable knowledge (revised)") throw new Error("Re-ingestion did not update the existing task title");
  const repeat = memory.beginSessionIngestion({ projectId, opencodeSessionId: sessionID, orchestratorSessionId,
    transcriptHash: "sha256-smoke-001", checkpointId: checkpoint.checkpointId, historySource: history.source,
    historyComplete: true, messageCount: history.messages.length });
  if (!repeat.alreadyCompleted) throw new Error("Completed ingestion was not recognized as idempotent");

  console.log(JSON.stringify({ ok: true, historySource: history.source, importedMessages: history.messages.length,
    mainTaskId: taskTree.mainTaskId, subtaskCount: taskTree.subtasks.length, dependencyEdges: 2,
    repeatedIngestionTaskCount: memory.countTasks(projectId), idempotentCompletedRun: repeat.alreadyCompleted }, null, 2));
} finally {
  try { openCodeDb?.close(); } catch { /* no-op */ }
  lease.release();
  if (previousOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = previousOpenCodeDb;
  rmSync(root, { recursive: true, force: true });
}
