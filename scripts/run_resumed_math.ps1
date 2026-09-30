param(
  [Parameter(Mandatory = $true)][string]$SessionDirectory,
  [Parameter(Mandatory = $true)][string]$ResumeDirectory,
  [int]$ResumeRound = 2,
  [int]$SearchConcurrency = 128,
  [int]$ProviderConcurrency = 256
)

$ErrorActionPreference = "Stop"
$AFlowRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$DittoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SessionDirectory = (Resolve-Path -LiteralPath $SessionDirectory).Path
$ResumeDirectory = (Resolve-Path -LiteralPath $ResumeDirectory).Path
$Snapshot = Join-Path $SessionDirectory "ditto-experiment"
$StatusPath = Join-Path $SessionDirectory "status.json"
$LatestStatusPath = Join-Path (Split-Path $SessionDirectory -Parent) "latest-status.json"

Add-Type @"
using System.Runtime.InteropServices;
public static class DittoResumeAwake {
  [DllImport("kernel32.dll", SetLastError = true)]
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
    resumedFrom = $ResumeDirectory
    resumedAfterRound = $ResumeRound
    searchConcurrency = $SearchConcurrency
    providerConcurrency = $ProviderConcurrency
    finalTest = "independent-round-test-runner; validation-selected best only"
  }
  foreach ($entry in $More.GetEnumerator()) { $state[$entry.Key] = $entry.Value }
  $json = $state | ConvertTo-Json -Depth 8
  $json | Set-Content -LiteralPath $StatusPath -Encoding utf8
  $json | Set-Content -LiteralPath $LatestStatusPath -Encoding utf8
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $SessionDirectory "audit.json"))) { throw "Prepare a frozen session first" }
  if (Test-Path -LiteralPath (Join-Path $SessionDirectory "ditto-runs")) { throw "Use a fresh session; existing evidence must not be overwritten" }
  foreach ($line in Get-Content -LiteralPath (Join-Path $DittoRoot ".env")) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $name, $value = $line -split '=', 2
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), "Process")
  }
  if (-not $env:CODE_SOUL_API_KEY) { throw "CODE_SOUL_API_KEY is required" }
  $env:AFLOW_REFERENCE_ROOT = Join-Path $SessionDirectory "aflow-reference"
  $env:AFLOW_SCORER_PYTHON = Join-Path $AFlowRoot ".venv/Scripts/python.exe"
  $env:DITTO_PROVIDER_LOG = Join-Path $SessionDirectory "ditto-provider.jsonl"
  $arguments = @(
    (Join-Path $Snapshot "dist/cli.js"), "search", "--dataset", "math",
    "--data-dir", (Join-Path $SessionDirectory "aflow-reference/data/datasets"),
    "--output-root", (Join-Path $SessionDirectory "ditto-runs"),
    "--resume-dir", $ResumeDirectory, "--resume-round", [string]$ResumeRound,
    "--rounds", "20", "--repeats", "5", "--test-repeats", "3",
    "--search-concurrency", [string]$SearchConcurrency,
    "--search-provider-concurrency", [string]$ProviderConcurrency,
    "--top-k", "4", "--patience", "5", "--seed", "42", "--maximum-depth", "10"
  )
  $quotedArguments = $arguments | ForEach-Object { '"' + $_ + '"' }
  $stdout = Join-Path $SessionDirectory "ditto-search.out.log"
  $stderr = Join-Path $SessionDirectory "ditto-search.err.log"
  $process = Start-Process -FilePath (Get-Command node).Source -ArgumentList $quotedArguments -WorkingDirectory $Snapshot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  Write-State "ditto-search" @{ pid = $process.Id; stdout = $stdout; stderr = $stderr; startedAt = (Get-Date).ToUniversalTime().ToString("o") }
  while (-not $process.HasExited) {
    [void][DittoResumeAwake]::SetThreadExecutionState([uint32]2147483651)
    Start-Sleep -Seconds 15
    $process.Refresh()
  }
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "Resumed search exited with code $($process.ExitCode). See $stderr" }
  $run = Get-ChildItem -LiteralPath (Join-Path $SessionDirectory "ditto-runs/math") -Directory | Select-Object -First 1
  # No second test launch: the independent runner already evaluates every
  # checkpoint. The final score is that of the validation-selected frozen best,
  # not whichever workflow happened to score highest on held-out test data.
  Write-State "search-frozen-tests-independent" @{ dittoRun = $run.FullName; frozenAt = (Get-Date).ToUniversalTime().ToString("o") }
} catch {
  Write-State "failed" @{ error = $_.Exception.Message }
  throw
} finally {
  [void][DittoResumeAwake]::SetThreadExecutionState([uint32]2147483648)
}
