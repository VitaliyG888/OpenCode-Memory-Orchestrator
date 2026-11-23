import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorStore } from "./store";
import { MemoryIntelligence } from "./intelligence";

const root = mkdtempSync(join(tmpdir(), "orch-intelligence-test-"));
const store = new OrchestratorStore(root);
try {
  const { projectId } = store.registerProject({ name: "Temporal test", goal: "Verify historical project reconstruction", rootPath: root });
  const { taskId } = store.createTask({ projectId, title: "Test task", description: "Validate versioned task state" });
  const { orchestratorSessionId } = store.createSessionRecord({ projectId, opencodeSessionId: "smoke-test-session", taskId, title: "Versioned session" });
  const now = Date.now();
  const beforeUpdate = new Date(now + 1000).toISOString();
  const afterUpdate = new Date(now + 3000).toISOString();
  const knownAt = new Date(now + 5000).toISOString();
  store.updateTask({ projectId, taskId, status: "completed", result: "Smoke test passed", validFrom: afterUpdate, reason: "test transition" });
  store.updateSession({ projectId, sessionId: orchestratorSessionId, status: "completed", validFrom: afterUpdate, reason: "test session transition" });

  const intelligence = new MemoryIntelligence(root, store);
  const before = intelligence.projectStateAt({ projectId, asOf: beforeUpdate, knownAt });
  const after = intelligence.projectStateAt({ projectId, asOf: new Date(now + 4000).toISOString(), knownAt });
  const beforeTask = (before.tasks as any[]).find(task => task.id === taskId);
  const afterTask = (after.tasks as any[]).find(task => task.id === taskId);
  const beforeSession = (before.sessions as any[]).find(session => session.id === orchestratorSessionId);
  const afterSession = (after.sessions as any[]).find(session => session.id === orchestratorSessionId);
  if (beforeTask?.status !== "planned") throw new Error(`Expected historical task status planned, received ${beforeTask?.status}`);
  if (afterTask?.status !== "completed") throw new Error(`Expected current task status completed, received ${afterTask?.status}`);
  if (beforeSession?.status !== "created") throw new Error(`Expected historical session status created, received ${beforeSession?.status}`);
  if (afterSession?.status !== "completed") throw new Error(`Expected current session status completed, received ${afterSession?.status}`);
  if (!store.vectorAvailable) console.warn(`[test] sqlite-vec unavailable: ${store.vectorError || "unknown"}`);
  console.log(JSON.stringify({ ok: true, beforeTaskStatus: beforeTask.status, afterTaskStatus: afterTask.status,
    beforeSessionStatus: beforeSession.status, afterSessionStatus: afterSession.status,
    beforeAsOf: before.asOf, afterAsOf: after.asOf,
    taskVersions: store.db.query("SELECT COUNT(*) AS count FROM task_versions WHERE task_id=?").get(taskId),
    sessionVersions: store.db.query("SELECT COUNT(*) AS count FROM session_versions WHERE session_id=?").get(orchestratorSessionId) }, null, 2));
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
