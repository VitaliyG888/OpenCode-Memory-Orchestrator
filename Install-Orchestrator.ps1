$ErrorActionPreference = "Stop"
$ProjectRoot = (Get-Location).Path
$SourceRoot = Join-Path $PSScriptRoot ".opencode"
$TargetRoot = Join-Path $ProjectRoot ".opencode"

if (-not (Test-Path $SourceRoot)) {
  throw "Не найдена папка .opencode рядом с Install-Orchestrator.ps1. Распакуйте архив полностью."
}

function Merge-JsonDefaults {
  param([object]$Target, [object]$Defaults)
  foreach ($property in $Defaults.PSObject.Properties) {
    $currentProperty = $Target.PSObject.Properties[$property.Name]
    if (-not $currentProperty) {
      $Target | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
      continue
    }
    $current = $currentProperty.Value
    $default = $property.Value
    if ($current -is [pscustomobject] -and $default -is [pscustomobject]) {
      Merge-JsonDefaults -Target $current -Defaults $default
    }
  }
  return $Target
}

function Write-JsonNoBom {
  param([string]$Path, [object]$Value)
  $json = $Value | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Install-WorkspaceDirectory {
  param([string]$RelativePath, [string]$Name)
  $source = Join-Path $SourceRoot $RelativePath
  $target = Join-Path $TargetRoot $RelativePath
  if (-not (Test-Path $source)) { throw "Workspace source folder missing: $source" }
  $parent = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if (Test-Path $target) {
    $backupRoot = Join-Path $ProjectRoot (".orchestrator-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $backupTarget = Join-Path $backupRoot $RelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupTarget) | Out-Null
    Copy-Item -Recurse -Force $target $backupTarget
    Write-Host "[BACKUP] $Name saved to $backupTarget"
    Remove-Item -Recurse -Force $target
  }
  Copy-Item -Recurse -Force $source $target
  Write-Host "[OK] Installed: $Name"
}

New-Item -ItemType Directory -Force -Path (Join-Path $TargetRoot "agents") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TargetRoot "plugins") | Out-Null
$AgentSource = Join-Path $SourceRoot "agents\ai-development-orchestrator.md"
$AgentTarget = Join-Path $TargetRoot "agents\ai-development-orchestrator.md"
if (Test-Path $AgentTarget) {
  $AgentBackup = Join-Path $ProjectRoot (".orchestrator-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "\agents\ai-development-orchestrator.md")
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AgentBackup) | Out-Null
  Copy-Item -Force $AgentTarget $AgentBackup
  Write-Host "[BACKUP] Existing agent profile saved to $AgentBackup"
}
Copy-Item -Force $AgentSource $AgentTarget

# Migrate legacy provider/model/key config into the standalone Memory Intelligence config.
$DefaultConfigPath = Join-Path $SourceRoot "memory.config.example.json"
$CanonicalConfigPath = Join-Path $TargetRoot "memory.config.json"
$LegacyConfigPath = Join-Path $TargetRoot "orchestrator.config.json"
$Defaults = Get-Content -Path $DefaultConfigPath -Raw | ConvertFrom-Json
if (Test-Path $CanonicalConfigPath) {
  $Config = Get-Content -Path $CanonicalConfigPath -Raw | ConvertFrom-Json
  Merge-JsonDefaults -Target $Config -Defaults $Defaults | Out-Null
  Write-Host "[KEEP] Existing memory.config.json values and API keys preserved; missing defaults merged"
} elseif (Test-Path $LegacyConfigPath) {
  $Config = Get-Content -Path $LegacyConfigPath -Raw | ConvertFrom-Json
  Merge-JsonDefaults -Target $Config -Defaults $Defaults | Out-Null
  Write-Host "[MIGRATE] Existing orchestrator.config.json copied into memory.config.json; legacy file left untouched"
} else {
  $Config = $Defaults
  Write-Host "[OK] Default Memory Intelligence config created"
}
Write-JsonNoBom -Path $CanonicalConfigPath -Value $Config

# Keep token-threshold auto-save settings in the user-requested orchestrator.config.json.
$AutoSaveDefaultsPath = Join-Path $SourceRoot "orchestrator.config.example.json"
$OrchestratorConfigPath = Join-Path $TargetRoot "orchestrator.config.json"
$AutoSaveDefaults = Get-Content -Path $AutoSaveDefaultsPath -Raw | ConvertFrom-Json
if (Test-Path $OrchestratorConfigPath) {
  $OrchestratorConfig = Get-Content -Path $OrchestratorConfigPath -Raw | ConvertFrom-Json
  Merge-JsonDefaults -Target $OrchestratorConfig -Defaults $AutoSaveDefaults | Out-Null
  Write-Host "[KEEP] Existing orchestrator.config.json values preserved; missing auto-save defaults merged"
} else {
  $OrchestratorConfig = $AutoSaveDefaults
  Write-Host "[OK] Default orchestrator.config.json created (auto-save threshold: 50000 tokens)"
}
Write-JsonNoBom -Path $OrchestratorConfigPath -Value $OrchestratorConfig

# The core and two plugin packages are linked as one Bun workspace. Both plugin packages remain independently loadable.
$WorkspaceFile = Join-Path $TargetRoot "package.json"
$WorkspaceDefaults = Get-Content -Path (Join-Path $SourceRoot "package.json") -Raw | ConvertFrom-Json
if (Test-Path $WorkspaceFile) {
  $Workspace = Get-Content -Path $WorkspaceFile -Raw | ConvertFrom-Json
} else {
  $Workspace = $WorkspaceDefaults
}
if (-not $Workspace.PSObject.Properties["workspaces"]) {
  $Workspace | Add-Member -NotePropertyName "workspaces" -NotePropertyValue @()
}
$WorkspacePaths = @($Workspace.workspaces)
foreach ($workspacePath in @("packages/memory-intelligence-core", "plugins/memory-intelligence", "plugins/ai-development-orchestrator")) {
  if ($WorkspacePaths -notcontains $workspacePath) { $WorkspacePaths += $workspacePath }
}
$Workspace.workspaces = $WorkspacePaths
if (-not $Workspace.PSObject.Properties["type"]) { $Workspace | Add-Member -NotePropertyName "type" -NotePropertyValue "module" }
Write-JsonNoBom -Path $WorkspaceFile -Value $Workspace

# Install the shared service package first, then the Memory plugin and its Orchestrator consumer.
Install-WorkspaceDirectory -RelativePath "packages\memory-intelligence-core" -Name "Memory Intelligence Core"
Install-WorkspaceDirectory -RelativePath "plugins\memory-intelligence" -Name "Memory Intelligence plugin"
Install-WorkspaceDirectory -RelativePath "plugins\ai-development-orchestrator" -Name "AI Development Orchestrator plugin"

if (Get-Command bun -ErrorAction SilentlyContinue) {
  Push-Location $TargetRoot
  try { bun install } finally { Pop-Location }
} else {
  Write-Warning "Bun не найден. Установите Bun, затем выполните: cd .opencode; bun install"
}

Write-Host ""
Write-Host "[OK] Memory Intelligence and AI Development Orchestrator installed into $TargetRoot"
Write-Host "Memory Intelligence is the single owner of .orchestrator\orchestrator.sqlite."
Write-Host "Restart OpenCode; memory_* tools are available to all agents, orchestrator_* tools to the orchestrator."
Write-Host "Token-threshold auto-save settings are in .opencode\orchestrator.config.json; provider/model settings remain in .opencode\memory.config.json."
