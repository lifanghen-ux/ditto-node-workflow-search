param(
  [Parameter(Mandatory = $true)][string]$SessionDirectory,
  [string]$RuntimeDirectory,
  [int]$TestConcurrency = 200,
  [int]$ProviderConcurrency = 200,
  [int]$WorkflowConcurrency = 2,
  [int]$TestRepeats = 3,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$DittoRepository = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$AFlowRepository = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$SessionDirectory = (Resolve-Path -LiteralPath $SessionDirectory).Path
if (-not $RuntimeDirectory) { $RuntimeDirectory = $DittoRepository }
$RuntimeDirectory = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$runs = @(Get-ChildItem -LiteralPath (Join-Path $SessionDirectory "ditto-runs/math") -Directory)
if ($runs.Count -ne 1) { throw "Expected exactly one search run in this session" }
$output = Join-Path $SessionDirectory "round-tests"

Push-Location $RuntimeDirectory
try {
  foreach ($line in Get-Content -LiteralPath (Join-Path $DittoRepository ".env")) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $name, $value = $line -split '=', 2
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), "Process")
  }
  $env:AFLOW_REFERENCE_ROOT = Join-Path $SessionDirectory "aflow-reference"
  $env:AFLOW_SCORER_PYTHON = Join-Path $AFlowRepository ".venv/Scripts/python.exe"
  $env:DITTO_PROVIDER_LOG = Join-Path $output "provider.jsonl"
  $arguments = @(
    (Join-Path $RuntimeDirectory "dist/round-test-runner.js"),
    "--run-dir", $runs[0].FullName,
    "--data-dir", (Join-Path $SessionDirectory "aflow-reference/data/datasets"),
    "--output-dir", $output,
    "--test-concurrency", [string]$TestConcurrency,
    "--provider-concurrency", [string]$ProviderConcurrency,
    "--workflow-concurrency", [string]$WorkflowConcurrency,
    "--test-repeats", [string]$TestRepeats,
    "--dry-run", $(if ($DryRun) { "true" } else { "false" })
  )
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw "Independent Test Runner exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}
