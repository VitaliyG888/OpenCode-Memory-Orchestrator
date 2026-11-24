param(
  [string]$InstallerPath = (Join-Path $PSScriptRoot "Install-Orchestrator.ps1")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "Installer not found: $InstallerPath"
}

$testRoot = Join-Path $env:TEMP ("orch-v6-rollback-test-" + [guid]::NewGuid().ToString("N"))
$projectRoot = Join-Path $testRoot "project"
$binRoot = Join-Path $testRoot "mock-bin"
$targetRoot = Join-Path $projectRoot ".opencode"
New-Item -ItemType Directory -Path $targetRoot, $binRoot -Force | Out-Null

$originalPath = $env:PATH
$expected = @{}

function Write-TestFile([string]$RelativePath, [string]$Content) {
  $path = Join-Path $targetRoot $RelativePath
  $parent = Split-Path -Parent $path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  [System.IO.File]::WriteAllText($path, $Content, (New-Object System.Text.UTF8Encoding($false)))
  $script:expected[$RelativePath] = $Content
}

try {
  # Seed every installer transaction target with recognizable original content.
  Write-TestFile "packages/memory-intelligence-core/rollback-marker.txt" "ORIGINAL_CORE_DIRECTORY"
  Write-TestFile "plugins/memory-intelligence/rollback-marker.txt" "ORIGINAL_MEMORY_PLUGIN"
  Write-TestFile "plugins/ai-development-orchestrator/rollback-marker.txt" "ORIGINAL_ORCHESTRATOR_PLUGIN"
  Write-TestFile "agents/ai-development-orchestrator.md" "ORIGINAL_AGENT_FILE"
  Write-TestFile "memory.config.json" '{"providers":{"openrouter":{"apiKey":"TEST-ROLLBACK-KEY"}}}'
  Write-TestFile "orchestrator.config.json" '{"memory":{"autoSave":{"enabled":false,"tokenThreshold":12345}},"rollbackMarker":"ORIGINAL_ORCHESTRATOR_CONFIG"}'
  Write-TestFile "package.json" '{"name":"rollback-test-project","workspaces":["original-workspace"]}'
  Write-TestFile "bun.lock" "ORIGINAL_BUN_LOCK"
  Write-TestFile "bun.lockb" "ORIGINAL_BUN_LOCKB"

  # A mock bun executable deliberately fails after the installer has replaced files.
  $mockBun = Join-Path $binRoot "bun.cmd"
  [System.IO.File]::WriteAllText($mockBun, "@echo off`r`nexit /b 73`r`n", [System.Text.Encoding]::ASCII)
  $env:PATH = "$binRoot;$originalPath"

  $installerFailedAsExpected = $false
  try {
    & $InstallerPath -ProjectRoot $projectRoot
  } catch {
    $message = $_.Exception.Message
    if ($message -match "73|исходные файлы восстановлены|Установка отменена") {
      $installerFailedAsExpected = $true
      Write-Host "[PASS] Installer detected the simulated Bun failure"
    } else {
      throw
    }
  }

  if (-not $installerFailedAsExpected) {
    throw "Installer did not fail as expected. Check whether the mock bun.cmd was found."
  }

  foreach ($relativePath in $expected.Keys) {
    $actualPath = Join-Path $targetRoot $relativePath
    if (-not (Test-Path -LiteralPath $actualPath -PathType Leaf)) {
      throw "Rollback did not restore file: $relativePath"
    }
    $actual = [System.IO.File]::ReadAllText($actualPath)
    if ($actual -cne $expected[$relativePath]) {
      throw "Rollback content mismatch: $relativePath"
    }
    Write-Host "[PASS] Restored $relativePath"
  }

  foreach ($lockName in @("bun.lock", "bun.lockb")) {
    $actual = [System.IO.File]::ReadAllText((Join-Path $targetRoot $lockName))
    if ($actual -cne $expected[$lockName]) {
      throw "Rollback did not restore lockfile: $lockName"
    }
    Write-Host "[PASS] Restored $lockName"
  }

  Write-Host ""
  Write-Host "ROLLBACK TEST PASSED"
  Write-Host "Temporary test project: $projectRoot"
  Write-Host "No real OpenCode project was modified."
}
finally {
  $env:PATH = $originalPath
  # Keep the isolated test folder for inspection; it contains only synthetic test data.
}
