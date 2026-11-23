$ErrorActionPreference = "Stop"
$ProjectRoot = (Get-Location).Path
$ConfigPath = Join-Path $ProjectRoot ".opencode\memory.config.json"
$LegacyConfigPath = Join-Path $ProjectRoot ".opencode\orchestrator.config.json"
if (Test-Path $ConfigPath) {
  $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
} elseif (Test-Path $LegacyConfigPath) {
  $Config = Get-Content $LegacyConfigPath -Raw | ConvertFrom-Json
} else {
  throw "Memory config not found. Run Install-Orchestrator.ps1 first."
}
$Embedding = $Config.embedding
Write-Host "Embedding provider: $($Embedding.provider)"
Write-Host "Embedding model:    $($Embedding.model)"
$Intelligence = $Config.intelligence
if ($Intelligence) {
  Write-Host "Intelligence model: $($Intelligence.model)"
  Write-Host "Auto extraction:    $($Intelligence.autoExtractOnCompaction)"
}
$ProviderConfig = $null
if ($Config.providers) {
  $ProviderProperty = $Config.providers.PSObject.Properties | Where-Object { $_.Name -eq $Embedding.provider } | Select-Object -First 1
  if ($ProviderProperty) { $ProviderConfig = $ProviderProperty.Value }
}
$ConfiguredApiKey = [bool]($Embedding.apiKey -or $ProviderConfig.apiKey)
$ApiKeyEnvName = if ($Embedding.apiKeyEnv) { [string]$Embedding.apiKeyEnv } elseif ($Embedding.provider -eq "openrouter") { "OPENROUTER_API_KEY" } else { "OPENAI_API_KEY" }
$EnvironmentApiKey = [Environment]::GetEnvironmentVariable($ApiKeyEnvName)
$EnvironmentApiKey = $EnvironmentApiKey -or $env:ORCH_EMBEDDING_API_KEY

if ($Embedding.provider -eq "openrouter") {
  if (-not $ConfiguredApiKey -and -not $EnvironmentApiKey) {
    Write-Host "No OpenRouter key found. Add it to .opencode/memory.config.json:"
    Write-Host '  "providers": { "openrouter": { "apiKey": "sk-or-v1-..." } }'
    Write-Host "Or configure environment variable $ApiKeyEnvName."
    exit 1
  }
  if ($ConfiguredApiKey) { Write-Host "OpenRouter API key is configured in memory.config.json (value hidden)." }
  else { Write-Host "OpenRouter API key is available from environment variable $ApiKeyEnvName." }
  Write-Host "Restart OpenCode and run memory_embedding_status."
} elseif ($Embedding.provider -eq "ollama") {
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { throw "Ollama CLI not found. Install Ollama or change embedding.provider in memory.config.json." }
  ollama pull $Embedding.model
} else {
  if ($ConfiguredApiKey -or $EnvironmentApiKey) { Write-Host "API key is configured (value hidden)." }
  else { Write-Warning "No API key found. Set embedding.apiKey, providers.$($Embedding.provider).apiKey, or $ApiKeyEnvName." }
}
