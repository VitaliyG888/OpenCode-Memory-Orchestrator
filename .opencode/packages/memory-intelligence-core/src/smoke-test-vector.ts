import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorStore } from "./store";

const root = mkdtempSync(join(tmpdir(), "orch-vector-test-"));
const store = new OrchestratorStore(root);
try {
  const { projectId } = store.registerProject({
    name: "Vector retrieval smoke test",
    goal: "Verify Russian semantic retrieval through configured embedding provider and sqlite-vec",
    rootPath: root
  });

  const write = await store.writeMemory({
    projectId,
    kind: "decision",
    title: "JWT refresh-token rotation",
    content: "При истечении срока действия access token клиент отправляет refresh token на сервер. Сервер проверяет refresh token, отзывает предыдущую пару и выпускает новый access token вместе с новым refresh token.",
    importance: 5,
    concepts: ["authentication", "JWT", "refresh token", "token rotation"]
  });

  if (!store.vectorAvailable) {
    throw new Error(`sqlite-vec is not loaded: ${store.vectorError || "unknown error"}`);
  }

  const result = await store.semanticSearch({
    projectId,
    query: "Как приложение продлевает пользовательскую авторизацию, когда токен доступа больше недействителен?",
    limit: 5
  });

  const found = result.results.some((item: any) => item.id === write.memoryId && item.channels.includes("vector"));
  if (!found) {
    throw new Error(`Expected memory ${write.memoryId} in vector results. Search response: ${JSON.stringify(result, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    model: store.embeddingModel,
    vectorMode: result.mode,
    resultCount: result.resultCount,
    matchedMemoryId: write.memoryId
  }, null, 2));
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
