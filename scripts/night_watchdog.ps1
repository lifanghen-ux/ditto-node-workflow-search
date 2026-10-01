param(
  [Parameter(Mandatory = $true)][string]$SessionDirectory,
  [int]$PollSeconds = 30,
  [int]$StallMinutes = 45,
  [int]$MaximumRecoveries = 6,
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$DittoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$AFlowRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$SessionDirectory = (Resolve-Path -LiteralPath $SessionDirectory).Path
$Snapshot = Join-Path $SessionDirectory "ditto-experiment"
$GuardPath = Join-Path $SessionDirectory "night-guard.json"
$LockPath = Join-Path $SessionDirectory "night-guard.lock"
$StopPath = Join-Path $SessionDirectory "night-guard.stop"
$Node = (Get-Command node).Source
$GuardScript = $PSCommandPath

function Read-Json([string]$Path) {
  if (Test-Path -LiteralPath $Path) { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable }
  return $null
}
function Write-Json([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temporary -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}
function Process-Matches([int]$ProcessId, [string]$RequiredText) {
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  return ($candidate -and $candidate.CommandLine -and $candidate.CommandLine.Contains($RequiredText))
}
function Find-Node([string]$Entrypoint, [string]$RequiredText) {
  return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($Entrypoint) -and $_.CommandLine.Contains($RequiredText)
  })
}
function Stop-VerifiedTree([int]$ProcessId, [string]$RequiredText) {
  if (-not (Process-Matches $ProcessId $RequiredText)) { return }
  $all = @(Get-CimInstance Win32_Process)
  $children = [System.Collections.Generic.List[int]]::new()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($ProcessId)
  while ($queue.Count -gt 0) {
    $parentId = $queue.Dequeue()
    foreach ($child in ($all | Where-Object { $_.ParentProcessId -eq $parentId })) {
      $children.Add([int]$child.ProcessId); $queue.Enqueue([int]$child.ProcessId)
    }
  }
  # All exact PIDs are descendants of a verified experiment process, not
  # arbitrary Python or Node processes owned by the user.
  for ($index = $children.Count - 1; $index -ge 0; $index--) {
    Stop-Process -Id $children[$index] -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}
function Event([string]$Kind, [hashtable]$Details = @{}) {
  $entry = @{ at = (Get-Date).ToUniversalTime().ToString("o"); type = $Kind }
  foreach ($item in $Details.GetEnumerator()) { $entry[$item.Key] = $item.Value }
  $entry | ConvertTo-Json -Compress -Depth 10 | Add-Content -LiteralPath (Join-Path $SessionDirectory "night-guard-events.jsonl") -Encoding utf8
}
function Start-Node([string[]]$Arguments, [string]$LogStem) {
  $quoted = $Arguments | ForEach-Object { '"' + $_ + '"' }
  $process = Start-Process -FilePath $Node -ArgumentList $quoted -WorkingDirectory $Snapshot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$LogStem.out.log" -RedirectStandardError "$LogStem.err.log"
  return $process.Id
}
function Save-Guard {
  $script:guard.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  $script:guard.pid = $PID
  Write-Json $GuardPath $script:guard
}
function Last-Activity([string[]]$Paths) {
  $latest = [DateTime]::MinValue
  foreach ($path in $Paths) {
    $file = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    if ($file -and $file.LastWriteTimeUtc -gt $latest) { $latest = $file.LastWriteTimeUtc }
  }
  return $latest
}
function Successful-ProviderActivity([string]$LogPath) {
  $health = Read-Json "$LogPath.health.json"
  if ($health) {
    if ($health.lastSuccessAt) { return [DateTime]::Parse($health.lastSuccessAt).ToUniversalTime() }
    return [DateTime]::Parse($health.startedAt).ToUniversalTime()
  }
  # Compatibility for older frozen snapshots without a health sidecar.
  if (Test-Path -LiteralPath $LogPath) {
    $lastResponse = Get-Content -LiteralPath $LogPath | Where-Object { $_.Contains('"phase": "response"') } | Select-Object -Last 1
    if ($lastResponse) { return [DateTime]::Parse(($lastResponse | ConvertFrom-Json).at).ToUniversalTime() }
  }
  return Last-Activity @($LogPath)
}
function Remove-OwnScheduledTask {
  $registration = Read-Json (Join-Path $SessionDirectory "night-task.json")
  if (-not $registration -or -not $registration.registered) { return }
  try {
    $task = Get-ScheduledTask -TaskName $registration.taskName -ErrorAction Stop
    if ($task.Actions[0].Arguments.Contains($GuardScript) -and $task.Actions[0].Arguments.Contains($SessionDirectory)) {
      Unregister-ScheduledTask -TaskName $registration.taskName -Confirm:$false
      Event "scheduled-watchdog-cleaned-up" @{ taskName = $registration.taskName }
    }
  } catch { Event "scheduled-watchdog-cleanup-warning" @{ message = $_.Exception.Message } }
}

$prior = Read-Json $GuardPath
if ($prior -and (Process-Matches ([int]$prior.pid) $GuardScript)) {
  Write-Output "An experiment watchdog already owns this session."
  exit 0
}
if ($prior) {
  $guard = $prior
} else {
  $initial = Read-Json (Join-Path $SessionDirectory "status.json")
  $runs = @(Get-ChildItem -LiteralPath (Join-Path $SessionDirectory "ditto-runs/math") -Directory)
  if ($runs.Count -ne 1) { throw "Cannot unambiguously adopt the existing search" }
  $guard = @{ phase = "watching"; searchRun = $runs[0].FullName; searchPid = [int]$initial.pid;
    searchOutputRoot = Join-Path $SessionDirectory "ditto-runs";
    searchLog = Join-Path $SessionDirectory "ditto-search.out.log";
    searchProviderLog = Join-Path $SessionDirectory "ditto-provider.jsonl";
    testDirectory = Join-Path $SessionDirectory "round-tests"; testPid = 0;
    testLog = Join-Path $SessionDirectory "round-tests.out.log";
    searchRestarts = 0; testRestarts = 0; testJobRetries = 0; recoveryPending = $false;
    startedAt = (Get-Date).ToUniversalTime().ToString("o") }
}
$manifest = Read-Json (Join-Path $guard.searchRun "manifest.json")
$resume = Read-Json (Join-Path $guard.searchRun "resume-state.json")
if (-not $manifest -or -not $resume) { throw "Search manifest and completed recovery boundary are required" }
if ($VerifyOnly) {
  @{ phase = "watchdog-verified-read-only"; searchRun = $guard.searchRun;
    completedRounds = $resume.completedRounds; searchStatus = $manifest.status;
    snapshot = $Snapshot; testDirectory = $guard.testDirectory; maximumRecoveries = $MaximumRecoveries;
    stallMinutes = $StallMinutes; noModelCalls = $true } | ConvertTo-Json
  exit 0
}

# A lock plus command-line identity prevents duplicate guards or PID reuse.
if (Test-Path -LiteralPath $LockPath) {
  $owner = Read-Json $LockPath
  if ($owner -and (Process-Matches ([int]$owner.pid) $GuardScript)) { exit 0 }
  Remove-Item -LiteralPath $LockPath
}
$lock = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
$bytes = [System.Text.Encoding]::UTF8.GetBytes((@{ pid = $PID } | ConvertTo-Json -Compress))
$lock.Write($bytes, 0, $bytes.Length); $lock.Dispose()

Add-Type @"
using System.Runtime.InteropServices;
public static class DittoNightAwake {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint flags);
}
"@

try {
  foreach ($line in Get-Content -LiteralPath (Join-Path $DittoRoot ".env")) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $name, $value = $line -split '=', 2
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), "Process")
  }
  $env:AFLOW_REFERENCE_ROOT = Join-Path $SessionDirectory "aflow-reference"
  $env:AFLOW_SCORER_PYTHON = Join-Path $AFlowRoot ".venv/Scripts/python.exe"
  Event "watchdog-adopted" @{ searchPid = $guard.searchPid; searchRun = $guard.searchRun }
  while (-not (Test-Path -LiteralPath $StopPath)) {
    $guard.awakeRequestResult = [DittoNightAwake]::SetThreadExecutionState([uint32]2147483649)
    if ($guard.awakeRequestResult -eq 0) { Event "awake-request-failed" }
    try {
      # Handle a crash while a recovery run was being started. Persisting this
      # transition avoids accidentally creating an additional search on guard
      # restart or machine login.
      if ($guard.recoveryPending) {
        $newRuns = @(Get-ChildItem -LiteralPath (Join-Path $guard.searchOutputRoot "math") -Directory -ErrorAction SilentlyContinue)
        if ($newRuns.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $newRuns[0].FullName "resume-state.json"))) {
          $guard.searchRun = $newRuns[0].FullName; $guard.recoveryPending = $false
          Event "search-recovery-ready" @{ searchRun = $guard.searchRun }
        } elseif (-not (Process-Matches ([int]$guard.searchPid) (Join-Path $Snapshot "dist/cli.js"))) {
          $guard.recoveryPending = $false
          Event "search-recovery-startup-failed" @{ output = $guard.searchOutputRoot }
          Save-Guard; Start-Sleep -Seconds 60; continue
        } else { Save-Guard; Start-Sleep -Seconds $PollSeconds; continue }
      }
      $manifest = Read-Json (Join-Path $guard.searchRun "manifest.json")
      $resume = Read-Json (Join-Path $guard.searchRun "resume-state.json")
      $frozen = $manifest.status -in @("frozen", "complete")
      $searches = @(Find-Node (Join-Path $Snapshot "dist/cli.js") $guard.searchOutputRoot)
      if ($searches.Count -gt 1) { throw "More than one matching search process: refusing to guess" }
      if ($searches.Count -eq 1) { $guard.searchPid = [int]$searches[0].ProcessId }
      $searchAlive = $searches.Count -eq 1
      $searchProviderHealth = Read-Json "$($guard.searchProviderLog).health.json"
      $providerFailing = $searchProviderHealth -and $searchProviderHealth.lastFailureAt -and
        (-not $searchProviderHealth.lastSuccessAt -or
         [DateTime]::Parse($searchProviderHealth.lastFailureAt) -gt [DateTime]::Parse($searchProviderHealth.lastSuccessAt))
      $noSearchActivity = (([DateTime]::UtcNow - (Last-Activity @($guard.searchLog, $guard.searchProviderLog))).TotalMinutes -gt $StallMinutes)
      $noProviderSuccess = $providerFailing -and
        (([DateTime]::UtcNow - (Successful-ProviderActivity $guard.searchProviderLog)).TotalMinutes -gt 15)
      $searchStalled = $searchAlive -and -not $frozen -and ($noSearchActivity -or $noProviderSuccess)
      if (-not $frozen -and (-not $searchAlive -or $searchStalled)) {
        if ($guard.searchRestarts -ge $MaximumRecoveries) {
          $guard.phase = "needs-attention"; Save-Guard
          Event "search-recovery-limit" @{ restarts = $guard.searchRestarts }
          break
        }
        if (-not $resume -or $resume.completedRounds -lt 1) { throw "No complete boundary available; refusing to reset the experiment" }
        if ($searchStalled) { Stop-VerifiedTree ([int]$guard.searchPid) (Join-Path $Snapshot "dist/cli.js") }
        # Stop this session's old test process only after search has crashed or
        # stalled. Preserve all raw records; completed tests will be copied as
        # cache entries for identical prefix checkpoints only.
        $oldTests = @(Find-Node (Join-Path $Snapshot "dist/round-test-runner.js") $guard.testDirectory)
        foreach ($process in $oldTests) { Stop-VerifiedTree ([int]$process.ProcessId) $guard.testDirectory }
        $guard.searchRestarts = [int]$guard.searchRestarts + 1
        $recovery = Join-Path $SessionDirectory ("recoveries/restart-{0}" -f $guard.searchRestarts)
        [void](New-Item -ItemType Directory -Path $recovery -Force)
        $newTests = Join-Path $recovery "round-tests"
        [void](New-Item -ItemType Directory -Path $newTests -Force)
        foreach ($vertex in $resume.nodes) {
          if (-not $vertex.evaluation) { continue }
          $oldJob = Join-Path $guard.testDirectory $vertex.id
          $job = Read-Json (Join-Path $oldJob "job.json")
          if ($job -and $job.status -eq "complete") {
            Copy-Item -LiteralPath $oldJob -Destination (Join-Path $newTests $vertex.id) -Recurse
          }
        }
        $source = $guard.searchRun
        $guard.searchOutputRoot = Join-Path $recovery "ditto-runs"
        $guard.searchLog = Join-Path $recovery "ditto-search.out.log"
        $guard.searchProviderLog = Join-Path $recovery "ditto-provider.jsonl"
        $guard.testDirectory = $newTests; $guard.testLog = Join-Path $recovery "round-tests.out.log"
        $guard.testPid = 0; $guard.recoveryPending = $true
        $env:DITTO_PROVIDER_LOG = $guard.searchProviderLog
        $arguments = @((Join-Path $Snapshot "dist/cli.js"), "search", "--dataset", "math",
          "--data-dir", (Join-Path $SessionDirectory "aflow-reference/data/datasets"),
          "--output-root", $guard.searchOutputRoot, "--resume-dir", $source, "--resume-round", [string]$resume.completedRounds,
          "--rounds", "20", "--repeats", "5", "--test-repeats", "3", "--search-concurrency", "128",
          "--search-provider-concurrency", "256", "--top-k", "4", "--patience", "5", "--seed", "42", "--maximum-depth", "10")
        Save-Guard
        $guard.searchPid = Start-Node $arguments (Join-Path $recovery "ditto-search")
        Save-Guard
        Event "search-restarted" @{ pid = $guard.searchPid; from = $source; afterRound = $resume.completedRounds; stalled = $searchStalled }
        Start-Sleep -Seconds $PollSeconds
        continue
      }
      $testProcesses = @(Find-Node (Join-Path $Snapshot "dist/round-test-runner.js") $guard.testDirectory)
      if ($testProcesses.Count -gt 1) { throw "Multiple matching Test Runners: refusing duplicate work" }
      if ($testProcesses.Count -eq 1) { $guard.testPid = [int]$testProcesses[0].ProcessId }
      $testAlive = $testProcesses.Count -eq 1
      $testStatus = Read-Json (Join-Path $guard.testDirectory "status.json")
      $testProviderLog = Join-Path $guard.testDirectory "provider.jsonl"
      $testHealth = Read-Json "$testProviderLog.health.json"
      $testProviderFailing = $testHealth -and $testHealth.lastFailureAt -and
        (-not $testHealth.lastSuccessAt -or [DateTime]::Parse($testHealth.lastFailureAt) -gt [DateTime]::Parse($testHealth.lastSuccessAt))
      $testStalled = $testAlive -and $testStatus -and $testStatus.pending -gt 0 -and
        ((([DateTime]::UtcNow - (Last-Activity @($guard.testLog, $testProviderLog))).TotalMinutes -gt $StallMinutes) -or
         ($testProviderFailing -and ([DateTime]::UtcNow - (Successful-ProviderActivity $testProviderLog)).TotalMinutes -gt 15))
      Save-Guard
      $reportText = & $Node (Join-Path $DittoRoot "scripts/night_report.mjs") $SessionDirectory $guard.searchRun $guard.testDirectory $GuardPath
      if ($LASTEXITCODE -ne 0) { throw "Result aggregation failed" }
      $report = $reportText | ConvertFrom-Json -AsHashtable
      if ($report.complete) {
        $guard.phase = "complete"; $guard.completedAt = (Get-Date).ToUniversalTime().ToString("o"); Save-Guard
        Event "experiment-complete" @{ selectedByValidation = $report.bestId; testScore = $report.testScore }
        Remove-OwnScheduledTask
        break
      }
      if ($testStalled) { Stop-VerifiedTree ([int]$guard.testPid) $guard.testDirectory; $testAlive = $false }
      # The runner safely reuses complete job files and makes a new attempt
      # folder for interrupted jobs. Failed jobs can be retried by restarting
      # it after drain, with bounded retries and no edits to test answers.
      if (-not $testAlive) {
        if ($guard.testRestarts -ge $MaximumRecoveries) {
          $guard.phase = "needs-attention"; Save-Guard; Event "test-recovery-limit"; break
        }
        $guard.testRestarts = [int]$guard.testRestarts + 1
        $env:DITTO_PROVIDER_LOG = Join-Path $guard.testDirectory "provider.jsonl"
        $arguments = @((Join-Path $Snapshot "dist/round-test-runner.js"), "--run-dir", $guard.searchRun,
          "--data-dir", (Join-Path $SessionDirectory "aflow-reference/data/datasets"), "--output-dir", $guard.testDirectory,
          "--test-concurrency", "200", "--provider-concurrency", "200", "--workflow-concurrency", "2", "--test-repeats", "3")
        $logStem = Join-Path $guard.testDirectory ("runner-restart-{0}" -f $guard.testRestarts)
        $guard.testLog = "$logStem.out.log"
        $guard.testPid = Start-Node $arguments $logStem
        Event "test-runner-restarted" @{ pid = $guard.testPid; attempt = $guard.testRestarts; stalled = $testStalled }
      }
      $guard.phase = "watching"; Save-Guard
    } catch {
      # Transient file sharing, WMI, or reporting errors do not kill the guard
      # and never justify modifying search scores, protocols or dataset rows.
      $guard.lastError = $_.Exception.Message; Save-Guard
      Event "watchdog-check-error" @{ message = $_.Exception.Message }
    }
    Start-Sleep -Seconds $PollSeconds
  }
  if (Test-Path -LiteralPath $StopPath) { $guard.phase = "stopped-by-request"; Save-Guard; Remove-OwnScheduledTask }
} finally {
  [void][DittoNightAwake]::SetThreadExecutionState([uint32]2147483648)
  if (Test-Path -LiteralPath $LockPath) { Remove-Item -LiteralPath $LockPath }
}
