# Installation

For Windows, run `Install-Orchestrator.ps1` from the root of the target OpenCode project after extracting this repository there.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-Orchestrator.ps1
```

The installer creates or merges runtime config, registers the three Bun workspace packages in `.opencode/package.json`, backs up existing plugin/package folders, and runs `bun install` if Bun is available.

Back up the project first. Verify the installer against a disposable OpenCode project before using it on important work.
