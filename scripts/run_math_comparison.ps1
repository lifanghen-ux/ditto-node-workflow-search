param(
  [Parameter(Mandatory = $true)][string]$SessionDirectory
)

$ErrorActionPreference = "Stop"
$AFlowRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$DittoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Python = Join-Path $AFlowRoot ".venv/Scripts/python.exe"
$SessionDirectory = [System.IO.Path]::GetFullPath($SessionDirectory)
$AFlowSnapshot = Join-Path $SessionDirectory "aflow-reference"
$DittoSnapshot = Join-Path $SessionDirectory "ditto-experiment"
$StatusPath = Join-Path $SessionDirectory "status.json"
$LatestStatusPath = Join-Path (Split-Path $SessionDirectory -Parent) "latest-status.json"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Awake {
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

function Copy-Tree([string]$Source, [string]$Destination) {
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
  Get-ChildItem -LiteralPath $Destination -Directory -Recurse -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-Stage(
  [string]$Name,
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$WorkingDirectory
) {
  $stdout = Join-Path $SessionDirectory "$Name.out.log"
  $stderr = Join-Path $SessionDirectory "$Name.err.log"
  Write-State $Name @{ command = [System.IO.Path]::GetFileName($FilePath); stdout = $stdout; stderr = $stderr }
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  Write-State $Name @{ pid = $process.Id; stdout = $stdout; stderr = $stderr; startedAt = (Get-Date).ToUniversalTime().ToString("o") }
  while (-not $process.HasExited) {
    [void][Awake]::SetThreadExecutionState([uint32]2147483651)
    Start-Sleep -Seconds 15
    $process.Refresh()
  }
  [void][Awake]::SetThreadExecutionState([uint32]2147483648)
  if ($process.ExitCode -ne 0) {
    throw "$Name exited with code $($process.ExitCode). See $stderr"
  }
  Write-State "$Name-complete" @{ exitCode = $process.ExitCode; stdout = $stdout; stderr = $stderr }
}

try {
  New-Item -ItemType Directory -Path $SessionDirectory -Force | Out-Null
  Write-State "snapshotting"
  Import-DotEnv (Join-Path $DittoRoot ".env")
  if (-not $env:CODE_SOUL_API_KEY -or -not $env:AFLOW_API_KEY) { throw "Both local API key variables are required" }

  New-Item -ItemType Directory -Path $AFlowSnapshot, $DittoSnapshot -Force | Out-Null
  foreach ($name in @("benchmarks", "scripts", "config", "data")) {
    Copy-Tree (Join-Path $AFlowRoot $name) (Join-Path $AFlowSnapshot $name)
  }
  foreach ($name in @("run.py", "requirements.txt")) {
    Copy-Item -LiteralPath (Join-Path $AFlowRoot $name) -Destination (Join-Path $AFlowSnapshot $name) -Force
  }
  $workflowTarget = Join-Path $AFlowSnapshot "workspace/MATH/workflows"
  New-Item -ItemType Directory -Path (Join-Path $workflowTarget "round_1"), (Join-Path $workflowTarget "template") -Force | Out-Null
  foreach ($name in @("__init__.py", "graph.py", "prompt.py")) {
    Copy-Item -LiteralPath (Join-Path $AFlowRoot "workspace/MATH/workflows/round_1/$name") -Destination (Join-Path $workflowTarget "round_1/$name") -Force
  }
  Get-ChildItem -LiteralPath (Join-Path $AFlowRoot "workspace/MATH/workflows/template") -File |
    Copy-Item -Destination (Join-Path $workflowTarget "template") -Force
  "" | Set-Content -LiteralPath (Join-Path $workflowTarget "results.json") -Encoding utf8
  "" | Set-Content -LiteralPath (Join-Path $workflowTarget "processed_experience.json") -Encoding utf8

  foreach ($name in @("dist", "scripts")) {
    Copy-Tree (Join-Path $DittoRoot $name) (Join-Path $DittoSnapshot $name)
  }
  foreach ($name in @("package.json", "package-lock.json")) {
    Copy-Item -LiteralPath (Join-Path $DittoRoot $name) -Destination (Join-Path $DittoSnapshot $name) -Force
  }
  New-Item -ItemType Junction -Path (Join-Path $DittoSnapshot "node_modules") -Target (Join-Path $DittoRoot "node_modules") | Out-Null

  $env:AFLOW_REFERENCE_ROOT = $AFlowSnapshot
  $env:AFLOW_NODE_EVENT_LOG = Join-Path $SessionDirectory "aflow-node-events.jsonl"
  $env:AFLOW_USAGE_LOG = Join-Path $SessionDirectory "aflow-usage.jsonl"
  $env:DITTO_PROVIDER_LOG = Join-Path $SessionDirectory "ditto-provider.jsonl"
  $env:AFLOW_SCORER_PYTHON = $Python

  $audit = [ordered]@{
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    protocol = "deepseek-flash; concurrency=3; validation=119x5; search<=20; test=486x3"
    dataset = @{
      validate = (Get-FileHash (Join-Path $AFlowSnapshot "data/datasets/math_validate.jsonl") -Algorithm SHA256).Hash.ToLower()
      test = (Get-FileHash (Join-Path $AFlowSnapshot "data/datasets/math_test.jsonl") -Algorithm SHA256).Hash.ToLower()
    }
    aflowSource = (Get-FileHash (Join-Path $AFlowSnapshot "scripts/optimizer.py") -Algorithm SHA256).Hash.ToLower()
    dittoLock = (Get-FileHash (Join-Path $DittoSnapshot "package-lock.json") -Algorithm SHA256).Hash.ToLower()
  }
  $audit | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $SessionDirectory "audit.json") -Encoding utf8

  $commonAFlow = @("run.py", "--dataset", "MATH", "--optimized_path", "workspace", "--opt_model_name", "deepseek-flash", "--exec_model_name", "deepseek-flash", "--validation_rounds", "5", "--test_repeats", "3")
  Invoke-Stage "aflow-search" $Python ($commonAFlow + @("--mode", "Graph", "--initial_round", "1", "--max_rounds", "20", "--check_convergence")) $AFlowSnapshot
  Invoke-Stage "aflow-test" $Python ($commonAFlow + @("--mode", "Test")) $AFlowSnapshot

  $dittoOutput = Join-Path $SessionDirectory "ditto-runs"
  $node = (Get-Command node).Source
  $cli = Join-Path $DittoSnapshot "dist/cli.js"
  $data = Join-Path $AFlowSnapshot "data/datasets"
  Invoke-Stage "ditto-search" $node @($cli, "search", "--dataset", "math", "--data-dir", $data, "--output-root", $dittoOutput, "--rounds", "20", "--repeats", "5", "--test-repeats", "3", "--evaluation-concurrency", "3", "--top-k", "4", "--patience", "5", "--seed", "42", "--maximum-depth", "10") $DittoSnapshot
  $run = Get-ChildItem -LiteralPath (Join-Path $dittoOutput "math") -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $run) { throw "Ditto search returned no run directory" }
  Invoke-Stage "ditto-test" $node @($cli, "test", "--dataset", "math", "--data-dir", $data, "--run-dir", $run.FullName, "--test-repeats", "3", "--evaluation-concurrency", "3") $DittoSnapshot
  Write-State "complete" @{ completedAt = (Get-Date).ToUniversalTime().ToString("o"); dittoRun = $run.FullName }
} catch {
  Write-State "failed" @{ failedAt = (Get-Date).ToUniversalTime().ToString("o"); error = $_.Exception.Message }
  throw
} finally {
  [void][Awake]::SetThreadExecutionState([uint32]2147483648)
}
