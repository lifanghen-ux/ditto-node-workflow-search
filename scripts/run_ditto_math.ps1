param(
  [Parameter(Mandatory = $true)][string]$SessionDirectory
)

$ErrorActionPreference = "Stop"
$AFlowRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$DittoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SessionDirectory = [System.IO.Path]::GetFullPath($SessionDirectory)
$DittoSnapshot = Join-Path $SessionDirectory "ditto-experiment"
$AFlowSnapshot = Join-Path $SessionDirectory "aflow-reference"
$StatusPath = Join-Path $SessionDirectory "status.json"
$LatestStatusPath = Join-Path (Split-Path $SessionDirectory -Parent) "latest-status.json"

Add-Type @"
using System.Runtime.InteropServices;
public static class DittoAwake {
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint flags);
}
"@

function Write-State([string]$Phase, [hashtable]$More = @{}) {
  $state = [ordered]@{
    session = Split-Path $SessionDirectory -Leaf
    phase = $Phase
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    sessionDirectory = $SessionDirectory
    aflow = "paused-after-round-10"
  }
  foreach ($entry in $More.GetEnumerator()) { $state[$entry.Key] = $entry.Value }
  $json = $state | ConvertTo-Json -Depth 8
  $json | Set-Content -LiteralPath $StatusPath -Encoding utf8
  $json | Set-Content -LiteralPath $LatestStatusPath -Encoding utf8
}

function Import-DotEnv([string]$Path) {
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $name, $value = $line -split '=', 2
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), "Process")
  }
}

function Invoke-DittoStage([string]$Name, [string[]]$Arguments) {
  $stdout = Join-Path $SessionDirectory "$Name.out.log"
  $stderr = Join-Path $SessionDirectory "$Name.err.log"
  $node = (Get-Command node).Source
  $quotedArguments = $Arguments | ForEach-Object { '"' + $_ + '"' }
  $process = Start-Process -FilePath $node -ArgumentList $quotedArguments -WorkingDirectory $DittoSnapshot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  Write-State $Name @{ pid = $process.Id; stdout = $stdout; stderr = $stderr; startedAt = (Get-Date).ToUniversalTime().ToString("o") }
  while (-not $process.HasExited) {
    [void][DittoAwake]::SetThreadExecutionState([uint32]2147483651)
    Start-Sleep -Seconds 15
    $process.Refresh()
  }
  $process.WaitForExit()
  [void][DittoAwake]::SetThreadExecutionState([uint32]2147483648)
  if ($process.ExitCode -ne 0) { throw "$Name exited with code $($process.ExitCode). See $stderr" }
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $SessionDirectory "audit.json"))) {
    throw "Prepare a fresh frozen session with prepare_math_session.mjs first"
  }
  if (Test-Path -LiteralPath (Join-Path $SessionDirectory "ditto-runs")) {
    throw "This session already has formal results. Use a fresh session to avoid overwriting logs"
  }
  Import-DotEnv (Join-Path $DittoRoot ".env")
  if (-not $env:CODE_SOUL_API_KEY) { throw "CODE_SOUL_API_KEY is required" }
  $env:AFLOW_REFERENCE_ROOT = $AFlowSnapshot
  $env:AFLOW_SCORER_PYTHON = Join-Path $AFlowRoot ".venv/Scripts/python.exe"
  $env:CODE_SOUL_CONCURRENCY = "3"
  $env:DITTO_PROVIDER_LOG = Join-Path $SessionDirectory "smoke-provider.jsonl"

  $cli = Join-Path $DittoSnapshot "dist/cli.js"
  $data = Join-Path $AFlowSnapshot "data/datasets"
  $output = Join-Path $SessionDirectory "ditto-runs"
  $smokeData = Join-Path $SessionDirectory "smoke-data"
  $smokeOutput = Join-Path $SessionDirectory "smoke-runs"
  Invoke-DittoStage "smoke-search" @($cli, "search", "--dataset", "math", "--data-dir", $smokeData, "--output-root", $smokeOutput, "--rounds", "1", "--repeats", "1", "--test-repeats", "1", "--evaluation-concurrency", "3", "--top-k", "4", "--patience", "5", "--seed", "42", "--maximum-depth", "10")
  $smokeRun = Get-ChildItem -LiteralPath (Join-Path $smokeOutput "math") -Directory | Select-Object -First 1
  if (-not $smokeRun) { throw "Smoke search returned no run directory" }
  $events = @(Get-Content -LiteralPath (Join-Path $smokeRun.FullName "search-events.jsonl") | ForEach-Object { $_ | ConvertFrom-Json })
  if (-not ($events | Where-Object { $_.type -eq "path-evaluated" })) { throw "Smoke did not evaluate an optimizer-proposed path" }
  $summaries = @(Get-ChildItem -LiteralPath (Join-Path $smokeRun.FullName "evaluations") -Filter summary.json -Recurse -File)
  foreach ($file in $summaries) {
    $summary = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    if ($summary.failedRuns -ne 0 -or $summary.examples -ne 2) { throw "Smoke search has execution failures or an unexpected sample count" }
  }
  Invoke-DittoStage "smoke-test" @($cli, "test", "--dataset", "math", "--data-dir", $smokeData, "--run-dir", $smokeRun.FullName, "--test-repeats", "1", "--evaluation-concurrency", "3")
  $smokeTest = Get-Content -LiteralPath (Join-Path $smokeRun.FullName "test/summary.json") -Raw | ConvertFrom-Json
  if ($smokeTest.failedRuns -ne 0 -or $smokeTest.examples -ne 2) { throw "Smoke frozen test has execution failures" }
  Write-State "smoke-passed" @{ smokeRun = $smokeRun.FullName; smokeTestScore = $smokeTest.score }
  $env:DITTO_PROVIDER_LOG = Join-Path $SessionDirectory "ditto-provider.jsonl"
  Invoke-DittoStage "ditto-search" @($cli, "search", "--dataset", "math", "--data-dir", $data, "--output-root", $output, "--rounds", "20", "--repeats", "5", "--test-repeats", "3", "--evaluation-concurrency", "3", "--top-k", "4", "--patience", "5", "--seed", "42", "--maximum-depth", "10")
  $run = Get-ChildItem -LiteralPath (Join-Path $output "math") -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $run) { throw "Ditto search returned no run directory" }
  Invoke-DittoStage "ditto-test" @($cli, "test", "--dataset", "math", "--data-dir", $data, "--run-dir", $run.FullName, "--test-repeats", "3", "--evaluation-concurrency", "3")
  Write-State "complete" @{ completedAt = (Get-Date).ToUniversalTime().ToString("o"); dittoRun = $run.FullName }
} catch {
  Write-State "failed" @{ failedAt = (Get-Date).ToUniversalTime().ToString("o"); error = $_.Exception.Message }
  throw
} finally {
  [void][DittoAwake]::SetThreadExecutionState([uint32]2147483648)
}
