# opencode-memory-intelligence-core

Shared persistence and service API used by the OpenCode Memory Intelligence plugin and other OpenCode plugins. This package owns the single project database, FTS5/vector indexes, embeddings, hybrid retrieval, Knowledge Graph, Memory Intelligence extraction, conflicts, temporal state, and session/task records.

## Public API

```ts
import { acquireMemoryIntelligence } from "opencode-memory-intelligence-core"

const lease = acquireMemoryIntelligence(projectRoot)
try {
  const memory = lease.client
  const projectId = memory.ensureProject(projectName, projectRoot)
  const result = await memory.semanticSearch({ projectId, query: "current architecture", limit: 10 })
} finally {
  lease.release()
}
```

`acquireMemoryIntelligence()` returns a project-scoped, reference-counted shared client. The database is stored at `.orchestrator/orchestrator.sqlite` for compatibility with earlier releases. Consumers must always call `release()` during plugin cleanup.

This package is a service dependency, not an OpenCode plugin entrypoint. Install `opencode-memory-intelligence` to register the `memory_*` tools and lifecycle hooks.

## Runtime

The implementation targets OpenCode's Bun-based server runtime and uses `bun:sqlite` plus `sqlite-vec`. It is not a generic Node.js SQLite package. The embedding and Memory Intelligence providers are configured in `.opencode/memory.config.json`.
