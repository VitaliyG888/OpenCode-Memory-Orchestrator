import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMemoryIntelligence } from "./client";

const root = mkdtempSync(join(tmpdir(), "memory-shared-client-test-"));
const first = acquireMemoryIntelligence(root);
const second = acquireMemoryIntelligence(root);
try {
  if (first.client !== second.client) throw new Error("Expected both plugin consumers to receive the same Memory Intelligence client instance");
  const projectId = first.client.ensureProject("Shared client test", root, "Verify a single shared connection across plugins");
  const beforeRelease = first.client.report(projectId);
  first.release();
  // The first plugin lease must not close the database while the second consumer is alive.
  const afterRelease = second.client.report(projectId);
  if (!beforeRelease.project || !afterRelease.project) throw new Error("Shared database became unavailable after first lease release");
  second.release();
  console.log(JSON.stringify({ ok: true, sharedInstance: true, databasePath: first.client.databasePath, projectId }, null, 2));
} finally {
  first.release();
  second.release();
  rmSync(root, { recursive: true, force: true });
}
