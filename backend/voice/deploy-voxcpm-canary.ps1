param(
    [ValidateRange(0, 100)]
    [int]$RolloutPercent = 100
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$wrangler = Join-Path $projectRoot 'node_modules\.bin\wrangler.cmd'
$config = Join-Path $PSScriptRoot 'wrangler.toml'

if (-not (Test-Path -LiteralPath $wrangler)) {
    throw "Wrangler introuvable : $wrangler"
}

$secureToken = Read-Host 'Jeton Cloudflare temporaire (Workers Scripts Write)' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)

try {
    $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    $env:CLOUDFLARE_ACCOUNT_ID = 'f43760eaa8391ee979a4de7348a977c4'

    $secretInventory = (& $wrangler secret list --config $config 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "Impossible de vérifier les secrets du Worker : $secretInventory"
    }
    if ($secretInventory -notmatch 'HF_VOXCPM_TOKEN') {
        throw 'Secret HF_VOXCPM_TOKEN absent du Worker clash-voice ; aucun déploiement effectué.'
    }

    & $wrangler deploy --config $config --keep-vars `
        --var 'HF_VOXCPM_TTS_ENABLED:true' `
        --var 'VOICE_POLICY:voxcpm_canary' `
        --var 'VOXCPM_CACHE_VERSION:voxcpm-tn-canary-v1' `
        --var "VOXCPM_ROLLOUT_PERCENT:$RolloutPercent" `
        --message "Set VoxCPM Tunisian voice rollout to $RolloutPercent%"

    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler deploy a échoué (code $LASTEXITCODE)."
    }

    $health = Invoke-RestMethod -Uri 'https://clash-voice.asser-dev.workers.dev/health' -Method Get
    if ($health.politiqueVoix -ne 'voxcpm_canary' -or $health.rolloutPercent -ne $RolloutPercent -or -not $health.voxcpmPret) {
        throw "Déploiement effectué, mais la vérification santé ne correspond pas au canari attendu : $($health | ConvertTo-Json -Depth 6)"
    }
    $health | ConvertTo-Json -Depth 6
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    $secureToken.Dispose()
    Remove-Item Env:CLOUDFLARE_API_TOKEN, Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
}
