param([Parameter(Mandatory = $true)][string]$SessionDirectory)
$ErrorActionPreference = "Stop"
$SessionDirectory = (Resolve-Path -LiteralPath $SessionDirectory).Path
$scriptPath = Join-Path $PSScriptRoot "night_watchdog.ps1"
$taskName = "Ditto-MATH-Night-" + (Split-Path $SessionDirectory -Leaf)
$shellPath = (Get-Process -Id $PID).Path
$metadata = @{ taskName = $taskName; registered = $false; updatedAt = (Get-Date).ToUniversalTime().ToString("o") }
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $arguments = '-NoProfile -File "' + $scriptPath + '" -SessionDirectory "' + $SessionDirectory + '"'
  $action = New-ScheduledTaskAction -Execute $shellPath -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
  $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Hours 12)
  $login = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -WakeToRun `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 12)
  # No credentials are stored in the task. Only the guardian script and its
  # session path are visible. Model keys stay in the repository's ignored .env.
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger, $login) `
    -Principal $principal -Settings $settings -Description "Temporary Ditto MATH experiment watchdog; self-removes on completion" | Out-Null
  $metadata.registered = $true
} catch {
  $metadata.error = $_.Exception.Message
  # A restricted Windows account may prohibit Task Scheduler registration.
  # The hidden independent guardian remains useful without this extra layer.
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $SessionDirectory "night-task.json") -Encoding utf8
$metadata | ConvertTo-Json
