param(
    [ValidateSet('drop','math','humaneval','mbpp','bfcl','automationbench')][string]$Dataset = 'mbpp',
    [ValidateRange(1,1000)][int]$Rounds = 1,
    [ValidateRange(1,4096)][int]$Concurrency = 2,
    [ValidateRange(1,100000)][int]$MaxCalls = 1250,
    [ValidateRange(1,100000000)][int]$MaxTokens = 1500000,
    [string]$OutputDirectory = '',
    [string]$ResumeRun = '',
    [string]$ResumeCandidate = '',
    [string]$FeedbackRun = '',
    [switch]$Fresh,
    [switch]$EvaluateOnly,
    [switch]$FullSinglePass,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$previousPython = $env:DITTO_PROVIDER_PYTHON
$previousReportPython = $env:DITTO_REPORT_PYTHON
Push-Location $projectRoot
try {
    if (-not $env:DITTO_PROVIDER_PYTHON) {
        $env:DITTO_PROVIDER_PYTHON = Join-Path $projectRoot '.venv/Scripts/python.exe'
    }
    if (-not (Test-Path -LiteralPath $env:DITTO_PROVIDER_PYTHON)) { throw 'Provider Python is missing.' }
    if (-not $env:DITTO_REPORT_PYTHON) { $env:DITTO_REPORT_PYTHON = $env:DITTO_PROVIDER_PYTHON }
    & $env:DITTO_REPORT_PYTHON -c 'from PIL import Image'
    if ($LASTEXITCODE -ne 0) { throw 'Report Python requires Pillow before starting API calls.' }
    if (-not $env:AFLOW_REFERENCE_ROOT) { $env:AFLOW_REFERENCE_ROOT = Join-Path $projectRoot 'work/aflow-reference' }
    if (-not $env:AFLOW_SCORER_PYTHON) { $env:AFLOW_SCORER_PYTHON = Join-Path $projectRoot '.venv/Scripts/python.exe' }
    if (-not $SkipBuild) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    }
    if (-not $OutputDirectory) {
        $OutputDirectory = 'runs/a-evolution/' + (Get-Date -Format 'yyyy-MM-dd-HHmmss-fff') + '-' + $Dataset
    }
    & node scripts/prepare-user-prompt-run.mjs "$OutputDirectory/inputs"
    if ($LASTEXITCODE -ne 0) { throw 'Prompt preparation failed.' }
    $options = @('--representation','A','--dataset',$Dataset,'--rounds',"$Rounds",'--concurrency',"$Concurrency",
        '--repeats','1','--max-calls',"$MaxCalls",'--max-tokens',"$MaxTokens",
        '--prompt-bundle',"$OutputDirectory/inputs/prompt-bundle.json",'--output',$OutputDirectory)
    if ($FullSinglePass) { $options += @('--full-single-pass','true') }
    if ($EvaluateOnly) { $options += @('--evaluate-only','true') }
    if ($FeedbackRun) { $options += @('--feedback-run',$FeedbackRun) }
    # Resume only when explicitly requested; fresh runs generate their own candidate.
    $prior = ''
    if ($Fresh -and $ResumeRun) { throw 'Fresh and ResumeRun cannot be combined.' }
    if ($ResumeRun) {
        if (-not $ResumeCandidate) { throw 'ResumeCandidate is required with ResumeRun.' }
        $prior = Join-Path $ResumeRun "candidates/$ResumeCandidate.json"
        if (-not (Test-Path -LiteralPath $prior)) { throw "Missing resume candidate: $prior" }
        $options += @('--seed-partial-run',$ResumeRun,'--seed-partial-candidate',$ResumeCandidate)
    }
    if ($prior -and (Test-Path -LiteralPath $prior)) {
        $saved = Get-Content -Raw -Encoding UTF8 -LiteralPath $prior | ConvertFrom-Json
        $proposal = if ($saved.PSObject.Properties.Name -contains 'proposal') { $saved.proposal } else { $saved }
        $seed = @{representation='A'; proposal=$proposal; origin=@{kind='previous-llm-generated'; path=$prior}}
        $seedPath = Join-Path $OutputDirectory 'inputs/previous-a.json'
        $absoluteSeed = if ([IO.Path]::IsPathRooted($seedPath)) { $seedPath } else { Join-Path $projectRoot $seedPath }
        [IO.File]::WriteAllText($absoluteSeed,($seed | ConvertTo-Json -Depth 60),[Text.UTF8Encoding]::new($false))
        $options += @('--seed-proposal',$seedPath)
    }
    & node --env-file-if-exists=.env scripts/generated-small-batch-search.mjs @options
    if ($LASTEXITCODE -ne 0) { throw "Search stopped; inspect $OutputDirectory/manifest.json" }
} finally {
    $env:DITTO_PROVIDER_PYTHON = $previousPython
    $env:DITTO_REPORT_PYTHON = $previousReportPython
    Pop-Location
}
