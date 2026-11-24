# Installation

Keep this repository separate from the target OpenCode project. Open PowerShell in the extracted repository directory and run the installer with the full path to the target project.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-Orchestrator.ps1 -ProjectRoot "C:\Path\To\Your\OpenCodeProject"
```

The installer creates or merges runtime config, registers the three Bun workspace packages in `.opencode/package.json`, backs up existing plugin/package folders, and runs `bun install` if Bun is available.

Back up the project first. Verify the installer against a disposable OpenCode project before using it on important work.
