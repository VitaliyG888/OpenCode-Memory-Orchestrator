$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Assert-Equal {
  param([string]$Name, [object]$Actual, [object]$Expected)
  if ($Actual -cne $Expected) {
    throw "ASSERT FAILED: $Name. Expected=[$Expected], Actual=[$Actual]"
  }
  Write-Host "[PASS] $Name"
}

$repoRoot = $PSScriptRoot
$installer = Join-Path $repoRoot 'Install-Orchestrator.ps1'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Install-Orchestrator.ps1 not found beside this test: $installer"
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("orch-config-migration-test-" + [guid]::NewGuid().ToString('N'))
$projectRoot = Join-Path $testRoot 'project'
$mockBin = Join-Path $testRoot 'mock-bin'
$oldPath = $env:PATH

try {
  New-Item -ItemType Directory -Path (Join-Path $projectRoot '.opencode') -Force | Out-Null
  New-Item -ItemType Directory -Path $mockBin -Force | Out-Null

  # Mock Bun so this isolated test never downloads or changes dependencies.
  Set-Content -LiteralPath (Join-Path $mockBin 'bun.cmd') -Value '@echo off' -Encoding ASCII
  Add-Content -LiteralPath (Join-Path $mockBin 'bun.cmd') -Value 'exit /b 0' -Encoding ASCII
  $env:PATH = "$mockBin;$oldPath"

  $legacy = @'
{
  "providers": { "openrouter": { "apiKey": "legacy-secret-value" } },
  "embedding": { "model": "legacy-embedding-model" },
  "intelligence": { "model": "legacy-intelligence-model" },
  "memory": {
    "autoSave": { "enabled": false, "tokenThreshold": 12345, "legacyAutoSaveMarker": "keep-autosave" },
    "customMemoryMarker": "keep-memory"
  },
  "customRootMarker": "keep-root"
}
'@
  $canonical = @'
{
  "providers": { "openrouter": { "apiKey": "" } },
  "intelligence": { "enabled": true, "canonicalMarker": "keep-canonical" }
}
'@

  Set-Content -LiteralPath (Join-Path $projectRoot '.opencode\orchestrator.config.json') -Value $legacy -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $projectRoot '.opencode\memory.config.json') -Value $canonical -Encoding UTF8

  & $installer -ProjectRoot $projectRoot

  $memory = Get-Content -LiteralPath (Join-Path $projectRoot '.opencode\memory.config.json') -Raw | ConvertFrom-Json
  $orchestrator = Get-Content -LiteralPath (Join-Path $projectRoot '.opencode\orchestrator.config.json') -Raw | ConvertFrom-Json

  Assert-Equal 'blank canonical API key is filled from legacy config' $memory.providers.openrouter.apiKey 'legacy-secret-value'
  Assert-Equal 'existing canonical intelligence setting wins' $memory.intelligence.enabled $true
  Assert-Equal 'existing canonical custom marker survives' $memory.intelligence.canonicalMarker 'keep-canonical'
  Assert-Equal 'missing intelligence model migrates from legacy config' $memory.intelligence.model 'legacy-intelligence-model'
  Assert-Equal 'missing embedding model migrates from legacy config' $memory.embedding.model 'legacy-embedding-model'

  Assert-Equal 'legacy autoSave enabled=false survives' $orchestrator.memory.autoSave.enabled $false
  Assert-Equal 'legacy autoSave threshold survives' $orchestrator.memory.autoSave.tokenThreshold 12345
  Assert-Equal 'custom autoSave field survives' $orchestrator.memory.autoSave.legacyAutoSaveMarker 'keep-autosave'
  Assert-Equal 'custom memory field survives' $orchestrator.memory.customMemoryMarker 'keep-memory'
  Assert-Equal 'custom root orchestrator field survives' $orchestrator.customRootMarker 'keep-root'

  if ($orchestrator.PSObject.Properties['providers'] -or
      $orchestrator.PSObject.Properties['embedding'] -or
      $orchestrator.PSObject.Properties['intelligence']) {
    throw 'ASSERT FAILED: Memory Intelligence root sections leaked into orchestrator.config.json.'
  }
  Write-Host '[PASS] Memory Intelligence sections are not duplicated in orchestrator.config.json'

  $orchestratorJson = Get-Content -LiteralPath (Join-Path $projectRoot '.opencode\orchestrator.config.json') -Raw
  if ($orchestratorJson.Contains('legacy-secret-value')) {
    throw 'ASSERT FAILED: API key leaked into orchestrator.config.json.'
  }
  Write-Host '[PASS] legacy API key is not copied into orchestrator.config.json'
  Write-Host ''
  Write-Host 'CONFIG MIGRATION TEST PASSED'
}
finally {
  $env:PATH = $oldPath
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
