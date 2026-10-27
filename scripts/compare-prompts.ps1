param([int]$Rounds = 2)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$previousProfile = $env:DITTO_OPTIMIZER_PROFILE
Push-Location $projectRoot
try {
    $env:DITTO_PROVIDER_PYTHON = Join-Path $projectRoot '.venv/Scripts/python.exe'
    $env:AFLOW_SCORER_PYTHON = $env:DITTO_PROVIDER_PYTHON
    $env:AFLOW_REFERENCE_ROOT = Join-Path $projectRoot 'work/aflow-reference'
    $env:PYTHONIOENCODING = 'utf-8'
    foreach ($profile in @('baseline', 'prompt-v2')) {
        $env:DITTO_OPTIMIZER_PROFILE = $profile
        Write-Output "Starting DROP profile: $profile"
        & node --env-file-if-exists=.env dist/cli.js search --dataset drop --rounds $Rounds --repeats 5 --search-concurrency 3 --output-root runs/prompt-comparison
        if ($LASTEXITCODE -ne 0) { throw "Search failed for $profile; see saved run diagnostics." }
    }
} finally {
    $env:DITTO_OPTIMIZER_PROFILE = $previousProfile
    Pop-Location
}
