$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$wrangler = Join-Path $projectRoot 'node_modules\.bin\wrangler.cmd'
$config = Join-Path $PSScriptRoot 'wrangler.pilot.toml'

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
        throw "Impossible de vérifier les secrets du Worker pilote : $secretInventory"
    }
    foreach ($requiredSecret in @('HF_VOXCPM_TOKEN', 'VOICE_PILOT_TOKEN')) {
        if ($secretInventory -notmatch [regex]::Escape($requiredSecret)) {
            throw "Secret $requiredSecret absent du Worker pilote ; aucun déploiement effectué."
        }
    }

    & $wrangler deploy --config $config --keep-vars `
        --message 'Add safe ZeroGPU failure diagnostics to authenticated voice pilot'
    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler deploy a échoué (code $LASTEXITCODE)."
    }

    $health = Invoke-RestMethod -Uri 'https://clash-voice-pilot.asser-dev.workers.dev/health' -Method Get
    if ($health.politiqueVoix -ne 'voxcpm_only' -or $health.rolloutPercent -ne 100 -or -not $health.voxcpmPret) {
        throw "Déploiement effectué, mais le pilote ne correspond pas à la configuration attendue : $($health | ConvertTo-Json -Depth 6)"
    }
    $health | ConvertTo-Json -Depth 6
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    $secureToken.Dispose()
    Remove-Item Env:CLOUDFLARE_API_TOKEN, Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
}
