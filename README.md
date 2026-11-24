# OpenCode Memory & Orchestrator

Persistent project memory and AI development orchestration for OpenCode.

**Repository layout**
- `Memory Intelligence` — project memory, SQLite persistence, FTS5/vector retrieval, Knowledge Graph and session intelligence.
- `AI Development Orchestrator` — project planning, task dependencies, child sessions and session ingestion.
- `Memory Intelligence Core` — shared persistence and service API used by both plugins.

## Requirements

- OpenCode with the V2 plugin API used by this source tree
- Bun
- A configured embedding provider and, when remote extraction is enabled, an LLM provider

## Quick installation (Windows)

Keep this repository separate from the OpenCode project where you want to install the orchestrator. Open PowerShell in the extracted repository directory and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-Orchestrator.ps1 -ProjectRoot "C:\Path\To\Your\OpenCodeProject"
```

The installer merges missing defaults into existing configuration and backs up plugin/package directories before replacing them. It does not intentionally copy or replace the `.orchestrator` database. Review the installer and back up your project before installation or upgrades.

## Documentation

- Russian guide: [`docs/USER_GUIDE_RU.md`](docs/USER_GUIDE_RU.md)
- Architecture and project overview: [`README_RU.md`](README_RU.md)
- Testing checklist: [`TESTING_CHECKLIST_RU.md`](TESTING_CHECKLIST_RU.md)
- Configuration templates: `.opencode/*.example.json`

## Security

Never commit API keys, personal session transcripts, or local SQLite databases. Copy the example configuration to the runtime configuration filename in your project and supply your own credentials locally.

Secret redaction is best-effort, not a guarantee. Review `docs/USER_GUIDE_RU.md` and `SECURITY.md` before enabling remote processing.

## License

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
