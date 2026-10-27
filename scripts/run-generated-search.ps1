param(
    [ValidateSet('A', 'B')][string]$Representation = 'B',
    [ValidateRange(1, 1000)][int]$Rounds = 6,
    [ValidateRange(1, 4096)][int]$Concurrency = 3,
    [ValidateRange(1, 100000)][int]$MaxCalls = 500,
    [ValidateSet(64, 200)][int]$ValidationSize = 64,
    [ValidateRange(1, 100000000)][int]$MaxTokens = 1500000
)
$ErrorActionPreference = 'Stop'
$experimentRoot = Split-Path $PSScriptRoot -Parent
$previousPython = $env:DITTO_PROVIDER_PYTHON
Push-Location $experimentRoot
try {
    $env:DITTO_PROVIDER_PYTHON = Join-Path $experimentRoot '.venv/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $env:DITTO_PROVIDER_PYTHON)) { throw 'Missing project Python environment; see LOCAL_SETUP.md.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    & node --env-file-if-exists=.env scripts/generated-small-batch-search.mjs --representation $Representation --validation-size $ValidationSize --rounds $Rounds --repeats 1 --concurrency $Concurrency --max-calls $MaxCalls --max-tokens $MaxTokens
    if ($LASTEXITCODE -ne 0) { throw 'Generated workflow search failed; inspect its saved manifest and proposal diagnostics.' }
} finally {
    $env:DITTO_PROVIDER_PYTHON = $previousPython
    Pop-Location
}
