# opencode-ai-development-orchestrator

OpenCode V2 plugin for project/task/session orchestration. It consumes the public `opencode-memory-intelligence-core` API and does not implement or open a second memory database.

The plugin registers `orchestrator_*` tools and `/orch-*` commands, including `/orch-ingest-session` for importing the full transcript of an existing session, preserving it, extracting knowledge, and creating an idempotent task tree.

Install `opencode-memory-intelligence` alongside this package to expose `memory_*` tools and shared memory context to all agents.
