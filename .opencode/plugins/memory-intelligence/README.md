# opencode-memory-intelligence

Independent OpenCode V2 server plugin for shared project memory.

- Registers `memory_*` tools for every agent.
- Provides FTS5 + vector + Knowledge Graph hybrid retrieval.
- Adds Memory Intelligence extraction, confidence/provenance, contradiction tracking, consolidation, and historical state reconstruction.
- Saves session checkpoints before compaction and injects relevant project context.
- Uses `opencode-memory-intelligence-core` as its single storage/service implementation.

Local development: see `README_RU.md` in this package and the workspace root README. Published packages are loaded from `opencode.json` via the `plugins` array.
