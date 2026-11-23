# Architecture

The repository contains two OpenCode V2 plugins and one shared workspace package.

- `plugins/memory-intelligence` registers the `memory_*` tools and lifecycle hooks. It is the single owner of persistent memory.
- `packages/memory-intelligence-core` owns the shared client, SQLite store, schema, embeddings, retrieval, extraction, privacy and session persistence.
- `plugins/ai-development-orchestrator` registers `orchestrator_*` tools and session/task workflows. It consumes the public Core API and must not open SQLite independently.

The existing database path is `.orchestrator/orchestrator.sqlite` for compatibility with the source package.
