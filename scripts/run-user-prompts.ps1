param(
    [ValidateSet('A','B','Both')][string]$Representation = 'Both',
    [string]$PromptDirectory = 'prompts',
    [ValidateSet(64,200)][int]$ValidationSize = 200,
    [ValidateRange(1,1000)][int]$Rounds = 2,
    [ValidateRange(1,100000)][int]$MaxCalls = 1250,
    [ValidateRange(1,100000000)][int]$MaxTokens = 1500000
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$previousPython = $env:DITTO_PROVIDER_PYTHON
Push-Location $projectRoot
try {
    $env:DITTO_PROVIDER_PYTHON = Join-Path $projectRoot '.venv/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $env:DITTO_PROVIDER_PYTHON)) { throw 'Create .venv and install requirements-local.txt first.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    $runRoot = Join-Path 'runs/user-prompts' (Get-Date -Format 'yyyy-MM-dd-HHmmss-fff')
    & node scripts/prepare-user-prompt-run.mjs "$runRoot/inputs" $PromptDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Prompt preparation failed.' }
    $representations = if ($Representation -eq 'Both') { @('A','B') } else { @($Representation) }
    foreach ($variant in $representations) {
        & node --env-file-if-exists=.env scripts/generated-small-batch-search.mjs `
            --representation $variant --prompt-bundle "$runRoot/inputs/prompt-bundle.json" `
            --seed-proposal "$runRoot/inputs/seed-$variant.json" --output "$runRoot/$variant" `
            --validation-size $ValidationSize --repeats 1 --rounds $Rounds --concurrency 3 `
            --max-calls $MaxCalls --max-tokens $MaxTokens
        if ($LASTEXITCODE -ne 0) { throw "Search failed for $variant; inspect saved diagnostics in $runRoot/$variant." }
    }
    Write-Output "Results: $((Resolve-Path $runRoot).Path)"
} finally {
    $env:DITTO_PROVIDER_PYTHON = $previousPython
    Pop-Location
}
