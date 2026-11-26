# Changelog

## Unreleased

- Fixed: plugins no longer fail with `Cannot find package 'sqlite-vec'` when loaded by OpenCode. The core package resolves the native extension by filesystem path (`src/vector.ts`) instead of a bare `import`.
- Verified clean install: `bun pack` → `bun add ./tarballs/*.tgz` in an empty project loads both plugins with `sqliteVecAvailable: true` and working `searchMemory`.
- Added `.opencode/opencode.jsonc` declaring both local plugins, plus documented local-path and published-package variants in `README_RU.md`.

## 0.4.0

- Two independent OpenCode V2 plugins.
- Shared Memory Intelligence Core and project-scoped client.
- SQLite persistence, FTS5/vector retrieval and Knowledge Graph.
- Session autosave, checkpoints and transcript ingestion.
- Privacy redaction, relevant recall and conservative deduplication.

This changelog reflects the uploaded source package metadata; verify release contents and tests before publishing a tagged release.
