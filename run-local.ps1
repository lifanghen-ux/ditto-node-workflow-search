param(
    [ValidateSet('check', 'search', 'test')]
    [string]$Command = 'check',
    [ValidateSet('gsm8k', 'drop', 'math', 'humaneval', 'mbpp')]
    [string]$Dataset = 'gsm8k',
    [ValidateRange(1, 1000)]
    [int]$Rounds = 1,
    [ValidateRange(1, 20)]
    [int]$Repeats = 1,
    [string]$RunDir
)

$ErrorActionPreference = 'Stop'
$python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    throw 'Missing .venv. See LOCAL_SETUP.md for installation commands.'
}

$savedEnvironment = @{}
foreach ($name in @('DITTO_PROVIDER_PYTHON', 'AFLOW_SCORER_PYTHON', 'AFLOW_REFERENCE_ROOT', 'PYTHONIOENCODING')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location $PSScriptRoot
try {
    $env:DITTO_PROVIDER_PYTHON = $python
    $env:AFLOW_SCORER_PYTHON = $python
    $env:AFLOW_REFERENCE_ROOT = Join-Path $PSScriptRoot 'work/aflow-reference'
    $env:PYTHONIOENCODING = 'utf-8'

    if ($Command -eq 'check') {
        & npm.cmd run check
        if ($LASTEXITCODE -ne 0) { throw "npm run check failed ($LASTEXITCODE)" }
        & $python scripts/provider_bridge_test.py
        if ($LASTEXITCODE -ne 0) { throw "Python bridge tests failed ($LASTEXITCODE)" }
        return
    }

    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed ($LASTEXITCODE)" }
    & node --env-file-if-exists=.env --input-type=module -e 'import { loadProviderSettings } from "./dist/config.js"; loadProviderSettings(); console.log("Provider settings loaded.");'
    if ($LASTEXITCODE -ne 0) { throw 'Set CODE_SOUL_API_KEY in the local .env file before running an experiment.' }

    if ($Command -eq 'test' -and -not $RunDir) { throw 'test requires -RunDir runs/<dataset>/<completed-search-run>.' }
    $split = if ($Command -eq 'search') { 'validate' } else { 'test' }
    $dataFile = Join-Path $PSScriptRoot "data/datasets/${Dataset}_${split}.jsonl"
    if (-not (Test-Path -LiteralPath $dataFile)) { throw "Missing dataset: $dataFile. See LOCAL_SETUP.md." }

    if ($Dataset -in @('humaneval', 'mbpp')) {
        if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'This dataset requires Docker; install and start Docker first.' }
        & docker info --format '{{.ServerVersion}}'
        if ($LASTEXITCODE -ne 0) { throw 'Docker daemon is unavailable.' }
    }

    if ($Command -eq 'search') {
        & node --env-file-if-exists=.env dist/cli.js search --dataset $Dataset --data-dir data/datasets --search-limit 0 --rounds $Rounds --repeats $Repeats --search-concurrency 3
    } else {
        & node --env-file-if-exists=.env dist/cli.js test --dataset $Dataset --data-dir data/datasets --run-dir $RunDir --test-limit 0 --test-repeats $Repeats --test-concurrency 3
    }
    if ($LASTEXITCODE -ne 0) { throw "Experiment failed ($LASTEXITCODE)." }
} finally {
    Pop-Location
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}
