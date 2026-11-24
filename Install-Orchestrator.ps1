param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Write-JsonNoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )

  $json = $Value | ConvertTo-Json -Depth 100
  $tempPath = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  try {
    [System.IO.File]::WriteAllText($tempPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    $null = Get-Content -LiteralPath $tempPath -Raw | ConvertFrom-Json
    if (Test-Path -LiteralPath $Path) {
      [System.IO.File]::Replace($tempPath, $Path, $null)
    } else {
      [System.IO.File]::Move($tempPath, $Path)
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Merge-JsonDefaults {
  param([object]$Target, [object]$Defaults)

  foreach ($property in $Defaults.PSObject.Properties) {
    $currentProperty = $Target.PSObject.Properties[$property.Name]
    if (-not $currentProperty -or $null -eq $currentProperty.Value) {
      if ($currentProperty) {
        $Target.$($property.Name) = $property.Value
      } else {
        $Target | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
      }
      continue
    }

    $current = $currentProperty.Value
    $default = $property.Value
    if ($current -is [pscustomobject] -and $default -is [pscustomobject]) {
      Merge-JsonDefaults -Target $current -Defaults $default | Out-Null
    }
  }
  return $Target
}

function Merge-JsonMissingProperties {
  param([object]$Target, [object]$Source)

  foreach ($property in $Source.PSObject.Properties) {
    $targetProperty = $Target.PSObject.Properties[$property.Name]
    $targetValueIsBlank = $targetProperty -and
      ($null -eq $targetProperty.Value -or
       ($targetProperty.Value -is [string] -and [string]::IsNullOrWhiteSpace($targetProperty.Value)))
    if (-not $targetProperty -or $targetValueIsBlank) {
      if ($targetProperty) {
        $Target.$($property.Name) = $property.Value
      } else {
        $Target | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
      }
      continue
    }

    if ($targetProperty.Value -is [pscustomobject] -and $property.Value -is [pscustomobject]) {
      Merge-JsonMissingProperties -Target $targetProperty.Value -Source $property.Value | Out-Null
    }
  }
  return $Target
}

function Read-JsonFile {
  param([string]$Path, [string]$Description)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description not found: $Path"
  }
  try {
    return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    throw "$Description contains invalid JSON: $Path. $($_.Exception.Message)"
  }
}

function Assert-NoReparsePointInPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Description
  )

  # PowerShell 5.1/.NET Framework has no DirectoryInfo.ResolveLinkTarget.
  # Conservatively reject junctions/symlinks in every existing path component
  # so a lexical path cannot alias the source repository through a reparse point.
  $current = [System.IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Description contains a symbolic link or junction: $current. Use a normal physical directory path."
      }
    }

    $parent = [System.IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $parentPath = $parent.FullName
    if ([string]::Equals($parentPath, $current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $current = $parentPath
  }
}

# Resolve and validate roots before touching the target project.
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
  throw "Целевая папка проекта не существует: $ProjectRoot"
}

$SourceRepoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$SourceRoot = [System.IO.Path]::GetFullPath((Join-Path $SourceRepoRoot ".opencode"))
if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
  throw "Не найдена папка .opencode рядом с Install-Orchestrator.ps1. Распакуйте архив полностью."
}

$TargetRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ".opencode"))

# Reject reparse points in the source and target path chains. This closes the
# junction/symlink alias bypass left by lexical GetFullPath/prefix comparisons.
Assert-NoReparsePointInPath -Path $SourceRepoRoot -Description "Исходный путь репозитория"
Assert-NoReparsePointInPath -Path $SourceRoot -Description "Исходная папка .opencode"
Assert-NoReparsePointInPath -Path $ProjectRoot -Description "Целевой путь проекта"
Assert-NoReparsePointInPath -Path $TargetRoot -Description "Целевая папка .opencode"

$repoTrimmed = $SourceRepoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$projectTrimmed = $ProjectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)

# Reject the source repository itself and every project nested anywhere inside it.
# Comparing against the repository root (not its .opencode subfolder) closes
# the previous gap where a nested sibling directory could pass the guard.
if ([string]::Equals($repoTrimmed, $projectTrimmed, [System.StringComparison]::OrdinalIgnoreCase) -or
    $projectTrimmed.StartsWith($repoTrimmed + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Целевой проект совпадает с исходным репозиторием или находится внутри него. Выбери отдельную папку проекта."
}

$sourceTrimmed = $SourceRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$targetTrimmed = $TargetRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
if ([string]::Equals($sourceTrimmed, $targetTrimmed, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Исходная и целевая папки совпадают. Укажи отдельный OpenCode-проект через -ProjectRoot."
}

$requiredFiles = @(
  (Join-Path $SourceRoot "agents\ai-development-orchestrator.md"),
  (Join-Path $SourceRoot "memory.config.example.json"),
  (Join-Path $SourceRoot "orchestrator.config.example.json"),
  (Join-Path $SourceRoot "package.json")
)
$requiredDirectories = @(
  (Join-Path $SourceRoot "packages\memory-intelligence-core"),
  (Join-Path $SourceRoot "plugins\memory-intelligence"),
  (Join-Path $SourceRoot "plugins\ai-development-orchestrator")
)

foreach ($path in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Обязательный исходный файл отсутствует: $path"
  }
}
foreach ($path in $requiredDirectories) {
  if (-not (Test-Path -LiteralPath $path -PathType Container)) {
    throw "Обязательная исходная папка отсутствует: $path"
  }
}

# Parse all templates and existing configs before making any changes.
$MemoryDefaults = Read-JsonFile (Join-Path $SourceRoot "memory.config.example.json") "Memory config template"
$AutoSaveDefaults = Read-JsonFile (Join-Path $SourceRoot "orchestrator.config.example.json") "Orchestrator config template"
$WorkspaceDefaults = Read-JsonFile (Join-Path $SourceRoot "package.json") "Workspace package template"

if ($WorkspaceDefaults -isnot [pscustomobject]) {
  throw "Workspace package template must be a JSON object."
}

$CanonicalConfigPath = Join-Path $TargetRoot "memory.config.json"
$LegacyConfigPath = Join-Path $TargetRoot "orchestrator.config.json"
$OrchestratorConfigPath = Join-Path $TargetRoot "orchestrator.config.json"
$WorkspaceFile = Join-Path $TargetRoot "package.json"
$LegacyConfig = $null

# Read the legacy file once. It may contain both Memory Intelligence settings
# at the root and orchestrator settings under memory.autoSave.
if (Test-Path -LiteralPath $LegacyConfigPath -PathType Leaf) {
  $LegacyConfig = Read-JsonFile $LegacyConfigPath "Existing/legacy orchestrator.config.json"
  if ($LegacyConfig -isnot [pscustomobject]) {
    throw "Existing orchestrator.config.json must contain a JSON object."
  }
}

# Split legacy root-level settings using the current memory template as the
# schema boundary. Known Memory Intelligence sections go to memory.config.json;
# unknown root-level user settings remain in orchestrator.config.json.
$LegacyMemoryConfig = [pscustomobject]@{}
if ($null -ne $LegacyConfig) {
  foreach ($property in $LegacyConfig.PSObject.Properties) {
    if ($property.Name -ne "memory" -and $MemoryDefaults.PSObject.Properties[$property.Name]) {
      $LegacyMemoryConfig | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
    }
  }
}

if (Test-Path -LiteralPath $CanonicalConfigPath -PathType Leaf) {
  # Existing canonical values always win. Fill only missing sections/fields
  # from the legacy file so a partial new config cannot strand old credentials.
  $MemoryConfig = Read-JsonFile $CanonicalConfigPath "Existing memory.config.json"
  if ($MemoryConfig -isnot [pscustomobject]) {
    throw "Existing memory.config.json must contain a JSON object."
  }
  if ($null -ne $LegacyConfig) {
    Merge-JsonMissingProperties -Target $MemoryConfig -Source $LegacyMemoryConfig | Out-Null
  }
  Merge-JsonDefaults -Target $MemoryConfig -Defaults $MemoryDefaults | Out-Null
} elseif ($null -ne $LegacyConfig) {
  # Migrate only schema-known Memory Intelligence sections. Unknown legacy
  # root-level properties are preserved in orchestrator.config.json below.
  $MemoryConfig = $LegacyMemoryConfig
  Merge-JsonDefaults -Target $MemoryConfig -Defaults $MemoryDefaults | Out-Null
} else {
  $MemoryConfig = ($MemoryDefaults | ConvertTo-Json -Depth 100 | ConvertFrom-Json)
}

# Preserve user-defined orchestrator settings while excluding the known
# Memory Intelligence root sections, which belong exclusively in memory.config.
$OrchestratorConfig = ($AutoSaveDefaults | ConvertTo-Json -Depth 100 | ConvertFrom-Json)
if ($null -ne $LegacyConfig) {
  foreach ($property in $LegacyConfig.PSObject.Properties) {
    if ($property.Name -eq "memory" -or $MemoryDefaults.PSObject.Properties[$property.Name]) {
      continue
    }
    if (-not $OrchestratorConfig.PSObject.Properties[$property.Name]) {
      $OrchestratorConfig | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
    }
  }

  if ($LegacyConfig.PSObject.Properties["memory"] -and $null -ne $LegacyConfig.memory) {
    if ($LegacyConfig.memory -isnot [pscustomobject]) {
      throw "Legacy memory must be a JSON object."
    }

    # Preserve custom properties under memory, but migrate autoSave separately.
    foreach ($property in $LegacyConfig.memory.PSObject.Properties) {
      if ($property.Name -eq "autoSave") { continue }
      if (-not $OrchestratorConfig.memory.PSObject.Properties[$property.Name]) {
        $OrchestratorConfig.memory | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
      }
    }

    if ($LegacyConfig.memory.PSObject.Properties["autoSave"] -and $null -ne $LegacyConfig.memory.autoSave) {
      $legacyAutoSave = $LegacyConfig.memory.autoSave
      if ($legacyAutoSave -isnot [pscustomobject]) {
        throw "Legacy memory.autoSave must be a JSON object."
      }
      $OrchestratorConfig.memory.autoSave = $legacyAutoSave
    }
  }
  Merge-JsonDefaults -Target $OrchestratorConfig -Defaults $AutoSaveDefaults | Out-Null
}

if (Test-Path -LiteralPath $WorkspaceFile -PathType Leaf) {
  $Workspace = Read-JsonFile $WorkspaceFile "Existing .opencode/package.json"
} else {
  $Workspace = $WorkspaceDefaults
}
if ($Workspace -isnot [pscustomobject]) {
  throw "Existing .opencode/package.json must contain a JSON object."
}
if (-not $Workspace.PSObject.Properties["workspaces"]) {
  $Workspace | Add-Member -NotePropertyName "workspaces" -NotePropertyValue @()
}
$WorkspacePaths = @($Workspace.workspaces)
foreach ($workspacePath in @(
  "packages/memory-intelligence-core",
  "plugins/memory-intelligence",
  "plugins/ai-development-orchestrator"
)) {
  if ($WorkspacePaths -notcontains $workspacePath) {
    $WorkspacePaths += $workspacePath
  }
}
$Workspace.workspaces = $WorkspacePaths
if (-not $Workspace.PSObject.Properties["type"]) {
  $Workspace | Add-Member -NotePropertyName "type" -NotePropertyValue "module"
}

# Prepare all replacement content outside .opencode before the transaction starts.
$runId = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$BackupRoot = Join-Path $ProjectRoot (".orchestrator-backup-" + $runId)
$StageRoot = Join-Path $ProjectRoot (".orchestrator-stage-" + $runId)
$LogPath = Join-Path $BackupRoot "install.log"

$transaction = New-Object System.Collections.ArrayList
$applied = New-Object System.Collections.ArrayList
$lockfileSnapshots = New-Object System.Collections.ArrayList
$LockPath = Join-Path $ProjectRoot ".orchestrator-install.lock"
Assert-NoReparsePointInPath -Path $LockPath -Description "Файл блокировки установщика"
$LockStream = $null

function Add-TransactionItem {
  param([string]$RelativePath, [string]$Kind, [string]$StagedPath)
  $targetPath = Join-Path $TargetRoot $RelativePath
  Assert-NoReparsePointInPath -Path $targetPath -Description "Целевой элемент $RelativePath"
  $backupPath = Join-Path $BackupRoot $RelativePath
  $item = [pscustomobject]@{
    RelativePath = $RelativePath
    TargetPath = $targetPath
    BackupPath = $backupPath
    StagedPath = $StagedPath
    Kind = $Kind
    Existed = (Test-Path -LiteralPath $targetPath)
    BackupCompleted = $false
    InstallCompleted = $false
  }
  [void]$transaction.Add($item)
}

# Hold an exclusive OS file handle for the duration of the install. The lock
# file may remain on disk; exclusivity is provided by the open handle, so a
# stale file after a crash does not block the next run.
try {
  $LockStream = [System.IO.File]::Open(
    $LockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch {
  throw "Another Orchestrator installation is already running for this project, or the lock file cannot be opened: $LockPath. $($_.Exception.Message)"
}

try {
  New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
  # Stage directories and files.
  $directoryMappings = @(
    @{ Source = (Join-Path $SourceRoot "packages\memory-intelligence-core"); Relative = "packages\memory-intelligence-core" },
    @{ Source = (Join-Path $SourceRoot "plugins\memory-intelligence"); Relative = "plugins\memory-intelligence" },
    @{ Source = (Join-Path $SourceRoot "plugins\ai-development-orchestrator"); Relative = "plugins\ai-development-orchestrator" }
  )

  foreach ($mapping in $directoryMappings) {
    $stagePath = Join-Path $StageRoot $mapping.Relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $stagePath) -Force | Out-Null
    Copy-Item -LiteralPath $mapping.Source -Destination $stagePath -Recurse -Force
    Add-TransactionItem -RelativePath $mapping.Relative -Kind "Directory" -StagedPath $stagePath
  }

  $agentStage = Join-Path $StageRoot "agents\ai-development-orchestrator.md"
  New-Item -ItemType Directory -Path (Split-Path -Parent $agentStage) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $SourceRoot "agents\ai-development-orchestrator.md") -Destination $agentStage -Force
  Add-TransactionItem -RelativePath "agents\ai-development-orchestrator.md" -Kind "File" -StagedPath $agentStage

  $memoryStage = Join-Path $StageRoot "memory.config.json"
  $orchestratorStage = Join-Path $StageRoot "orchestrator.config.json"
  $workspaceStage = Join-Path $StageRoot "package.json"
  Write-JsonNoBom -Path $memoryStage -Value $MemoryConfig
  Write-JsonNoBom -Path $orchestratorStage -Value $OrchestratorConfig
  Write-JsonNoBom -Path $workspaceStage -Value $Workspace
  Add-TransactionItem -RelativePath "memory.config.json" -Kind "File" -StagedPath $memoryStage
  Add-TransactionItem -RelativePath "orchestrator.config.json" -Kind "File" -StagedPath $orchestratorStage
  Add-TransactionItem -RelativePath "package.json" -Kind "File" -StagedPath $workspaceStage

  New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null

  # Snapshot lockfiles before Bun runs. Keep them in place on success; restore on failure.
  foreach ($lockName in @("bun.lock", "bun.lockb")) {
    $lockPath = Join-Path $TargetRoot $lockName
    $lockBackupPath = Join-Path $BackupRoot $lockName
    $snapshot = [pscustomobject]@{
      Name = $lockName
      TargetPath = $lockPath
      BackupPath = $lockBackupPath
      Existed = (Test-Path -LiteralPath $lockPath -PathType Leaf)
    }
    if ($snapshot.Existed) {
      Copy-Item -LiteralPath $lockPath -Destination $lockBackupPath -Force
    }
    [void]$lockfileSnapshots.Add($snapshot)
  }
  "Install started: $(Get-Date -Format o)" | Set-Content -LiteralPath $LogPath -Encoding UTF8

  # Apply transaction: move original targets to backup, then move staged replacements into place.
  foreach ($item in $transaction) {
    $parent = Split-Path -Parent $item.TargetPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    [void]$applied.Add($item)

    if ($item.Existed) {
      $backupParent = Split-Path -Parent $item.BackupPath
      New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
      Move-Item -LiteralPath $item.TargetPath -Destination $item.BackupPath -Force
      $item.BackupCompleted = $true
      Add-Content -LiteralPath $LogPath -Value "Backed up: $($item.RelativePath)"
    }

    if ($null -ne $item.StagedPath) {
      Move-Item -LiteralPath $item.StagedPath -Destination $item.TargetPath -Force
      $item.InstallCompleted = $true
      Add-Content -LiteralPath $LogPath -Value "Installed: $($item.RelativePath)"
    }
  }

  if (Get-Command bun -ErrorAction SilentlyContinue) {
    Push-Location $TargetRoot
    try {
      & bun install
      $bunExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($bunExitCode -ne 0) {
      throw "bun install завершился с кодом $bunExitCode."
    }
    Add-Content -LiteralPath $LogPath -Value "bun install succeeded."
  } else {
    Write-Warning "Bun не найден. Установите Bun, затем выполните: cd .opencode; bun install"
    Add-Content -LiteralPath $LogPath -Value "Bun not found; dependency installation skipped."
  }

  Add-Content -LiteralPath $LogPath -Value "Install completed: $(Get-Date -Format o)"
  Write-Host ""
  Write-Host "[OK] Memory Intelligence and AI Development Orchestrator installed into $TargetRoot"
  Write-Host "[BACKUP] Previous files, configs and workspace folders: $BackupRoot"
  Write-Host "[SECURITY] Backup may contain API keys from previous configs. Keep it private and do not commit it."
  Write-Host "[LOG] $LogPath"
  Write-Host "Memory Intelligence is the single owner of .orchestrator\orchestrator.sqlite."
  Write-Host "Restart OpenCode; memory_* tools are available to all agents, orchestrator_* tools to the orchestrator."
  Write-Host "Token-threshold auto-save settings are in .opencode\orchestrator.config.json; provider/model settings remain in .opencode\memory.config.json."
}
catch {
  $installError = $_
  Write-Error "Установка завершилась ошибкой: $($installError.Exception.Message)" -ErrorAction Continue
  Write-Warning "Выполняется откат изменённых файлов и каталогов..."

  $rollbackErrors = New-Object System.Collections.ArrayList
  for ($i = $applied.Count - 1; $i -ge 0; $i--) {
    $item = $applied[$i]
    try {
      $backupExists = Test-Path -LiteralPath $item.BackupPath

      if ($item.Existed) {
        # Never delete the original target unless its backup is safely present.
        if ($backupExists) {
          if (Test-Path -LiteralPath $item.TargetPath) {
            Remove-Item -LiteralPath $item.TargetPath -Recurse -Force
          }
          $restoreParent = Split-Path -Parent $item.TargetPath
          New-Item -ItemType Directory -Path $restoreParent -Force | Out-Null
          Move-Item -LiteralPath $item.BackupPath -Destination $item.TargetPath -Force
        } elseif ($item.InstallCompleted -and (Test-Path -LiteralPath $item.TargetPath)) {
          throw "Backup missing for pre-existing target: $($item.RelativePath)"
        }
      } elseif (Test-Path -LiteralPath $item.TargetPath) {
        Remove-Item -LiteralPath $item.TargetPath -Recurse -Force
      }
      Add-Content -LiteralPath $LogPath -Value "Rolled back: $($item.RelativePath)" -ErrorAction SilentlyContinue
    } catch {
      [void]$rollbackErrors.Add("$($item.RelativePath): $($_.Exception.Message)")
    }
  }

  foreach ($snapshot in $lockfileSnapshots) {
    try {
      if ($snapshot.Existed) {
        Copy-Item -LiteralPath $snapshot.BackupPath -Destination $snapshot.TargetPath -Force
      } elseif (Test-Path -LiteralPath $snapshot.TargetPath) {
        Remove-Item -LiteralPath $snapshot.TargetPath -Force
      }
    } catch {
      [void]$rollbackErrors.Add("$($snapshot.Name): $($_.Exception.Message)")
    }
  }

  if ($rollbackErrors.Count -gt 0) {
    Write-Error "Откат завершился не полностью. Резервная копия сохранена: $BackupRoot" -ErrorAction Continue
    foreach ($rollbackError in $rollbackErrors) {
      Write-Error $rollbackError -ErrorAction Continue
    }
    throw "Установка не завершена; требуется ручное восстановление из $BackupRoot"
  }

  if (Test-Path -LiteralPath $LogPath) {
    Add-Content -LiteralPath $LogPath -Value "Rollback completed: $(Get-Date -Format o)"
  }
  throw "Установка отменена; исходные файлы восстановлены. Резервная копия: $BackupRoot"
}
finally {
  if ($null -ne $LockStream) {
    $LockStream.Dispose()
  }
  if (Test-Path -LiteralPath $StageRoot) {
    Remove-Item -LiteralPath $StageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
