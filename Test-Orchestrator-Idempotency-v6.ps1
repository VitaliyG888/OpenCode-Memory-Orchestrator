param(
  [string]$InstallerPath = (Join-Path $PSScriptRoot "Install-Orchestrator.ps1")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "Installer not found: $InstallerPath"
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("orch-v6-idempotency-test-" + [guid]::NewGuid().ToString("N"))
$projectRoot = Join-Path $testRoot "project"
$mockBin = Join-Path $testRoot "mock-bin"
$oldPath = $env:PATH

function Assert-Equal {
  param([string]$Name, [object]$Actual, [object]$Expected)
  if ($Actual -cne $Expected) {
    throw "ASSERT FAILED: $Name. Expected=[$Expected], Actual=[$Actual]"
  }
  Write-Host "[PASS] $Name"
}

function Read-Json {
  param([string]$Path)
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

try {
  New-Item -ItemType Directory -Path $projectRoot, $mockBin -Force | Out-Null

  # Mock Bun: both installs succeed without downloading or changing dependencies.
  $mockBun = Join-Path $mockBin "bun.cmd"
  [System.IO.File]::WriteAllText(
    $mockBun,
    "@echo off`r`nexit /b 0`r`n",
    [System.Text.Encoding]::ASCII
  )
  $env:PATH = "$mockBin;$oldPath"

  Write-Host "`n[RUN] First installation"
  & $InstallerPath -ProjectRoot $projectRoot
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "First installer invocation returned exit code $LASTEXITCODE"
  }

  $targetRoot = Join-Path $projectRoot ".opencode"
  $memoryPath = Join-Path $targetRoot "memory.config.json"
  $orchestratorPath = Join-Path $targetRoot "orchestrator.config.json"
  $workspacePath = Join-Path $targetRoot "package.json"

  foreach ($path in @($memoryPath, $orchestratorPath, $workspacePath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "First installation did not create expected file: $path"
    }
  }

  # Add user-owned settings between installs. The second install must preserve them.
  $memory = Read-Json $memoryPath
  if (-not $memory.PSObject.Properties["providers"]) {
    $memory | Add-Member -NotePropertyName providers -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $memory.providers.PSObject.Properties["openrouter"]) {
    $memory.providers | Add-Member -NotePropertyName openrouter -NotePropertyValue ([pscustomobject]@{})
  }
  $memory.providers.openrouter | Add-Member -NotePropertyName apiKey -NotePropertyValue "IDEMPOTENCY-TEST-KEY" -Force
  $memory.intelligence | Add-Member -NotePropertyName customUserMarker -NotePropertyValue "KEEP-MEMORY-MARKER" -Force
  $memory | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $memoryPath -Encoding UTF8

  $orchestrator = Read-Json $orchestratorPath
  if (-not $orchestrator.PSObject.Properties["memory"]) {
    $orchestrator | Add-Member -NotePropertyName memory -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $orchestrator.memory.PSObject.Properties["autoSave"]) {
    $orchestrator.memory | Add-Member -NotePropertyName autoSave -NotePropertyValue ([pscustomobject]@{})
  }
  $orchestrator.memory.autoSave | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
  $orchestrator.memory.autoSave | Add-Member -NotePropertyName tokenThreshold -NotePropertyValue 23456 -Force
  $orchestrator | Add-Member -NotePropertyName customUserMarker -NotePropertyValue "KEEP-ORCHESTRATOR-MARKER" -Force
  $orchestrator | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $orchestratorPath -Encoding UTF8

  # Add a user workspace entry; installer must retain it and avoid duplicate plugin entries.
  $workspace = Read-Json $workspacePath
  $workspacePaths = @($workspace.workspaces)
  if ($workspacePaths -notcontains "custom/user-workspace") {
    $workspacePaths += "custom/user-workspace"
  }
  $workspace.workspaces = $workspacePaths
  $workspace | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $workspacePath -Encoding UTF8

  Write-Host "`n[RUN] Second installation"
  & $InstallerPath -ProjectRoot $projectRoot
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "Second installer invocation returned exit code $LASTEXITCODE"
  }

  # Verify user config and credentials survived the second installation.
  $memoryAfter = Read-Json $memoryPath
  $orchestratorAfter = Read-Json $orchestratorPath
  $workspaceAfter = Read-Json $workspacePath

  Assert-Equal "API key preserved after reinstall" $memoryAfter.providers.openrouter.apiKey "IDEMPOTENCY-TEST-KEY"
  Assert-Equal "Memory custom field preserved after reinstall" $memoryAfter.intelligence.customUserMarker "KEEP-MEMORY-MARKER"
  Assert-Equal "autoSave enabled=false preserved" $orchestratorAfter.memory.autoSave.enabled $false
  Assert-Equal "autoSave token threshold preserved" $orchestratorAfter.memory.autoSave.tokenThreshold 23456
  Assert-Equal "Orchestrator custom field preserved" $orchestratorAfter.customUserMarker "KEEP-ORCHESTRATOR-MARKER"

  $requiredWorkspaces = @(
    "packages/memory-intelligence-core",
    "plugins/memory-intelligence",
    "plugins/ai-development-orchestrator"
  )
  foreach ($workspaceName in $requiredWorkspaces) {
    $count = @($workspaceAfter.workspaces | Where-Object { $_ -ceq $workspaceName }).Count
    Assert-Equal "Workspace entry occurs exactly once: $workspaceName" $count 1
  }
  Assert-Equal "User workspace entry preserved" (@($workspaceAfter.workspaces | Where-Object { $_ -ceq "custom/user-workspace" }).Count) 1

  # Each install must have its own backup directory; the second contains the prior configs.
  $backupDirs = @(Get-ChildItem -LiteralPath $projectRoot -Directory -Filter ".orchestrator-backup-*" -ErrorAction SilentlyContinue)
  if ($backupDirs.Count -lt 2) {
    throw "Expected distinct backup directories from both installs; found $($backupDirs.Count)."
  }
  Write-Host "[PASS] Separate backup directories created for both installations"

  $secondBackupWithMemory = $false
  foreach ($backupDir in $backupDirs) {
    $candidate = Join-Path $backupDir.FullName "memory.config.json"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $secondBackupWithMemory = $true
      break
    }
  }
  if (-not $secondBackupWithMemory) {
    throw "No installer backup contains the pre-existing memory.config.json."
  }
  Write-Host "[PASS] Existing config captured in an installer backup"

  Write-Host "`nIDEMPOTENCY TEST PASSED"
  Write-Host "Temporary test project: $projectRoot"
}
finally {
  $env:PATH = $oldPath
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
