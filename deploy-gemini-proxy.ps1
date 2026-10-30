$ErrorActionPreference = 'Stop'

$wrangler = Join-Path $PSScriptRoot 'node_modules\.bin\wrangler.cmd'
if (-not (Test-Path -LiteralPath $wrangler -PathType Leaf)) {
    throw 'Wrangler est introuvable. Depuis la racine du projet, lance npm install puis réessaie.'
}

$previousApiToken = $env:CLOUDFLARE_API_TOKEN
$previousAccountId = $env:CLOUDFLARE_ACCOUNT_ID

try {
    Remove-Item Env:CLOUDFLARE_API_TOKEN, Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
    & $wrangler whoami
    if ($LASTEXITCODE -ne 0) {
        throw 'Wrangler n''est pas connecté. Lance .\node_modules\.bin\wrangler.cmd login puis réessaie.'
    }

    & $wrangler deploy --config (Join-Path $PSScriptRoot 'backend\gemini\wrangler.toml')
    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler a échoué (code $LASTEXITCODE)."
    }
    Write-Host 'Worker déployé. Après vérification de /clash et /vocaliser, supprimer l''ancien secret APP_TOKEN avec la commande indiquée dans README §6.5.'
}
finally {
    if ($null -ne $previousApiToken) { $env:CLOUDFLARE_API_TOKEN = $previousApiToken }
    else { Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue }
    if ($null -ne $previousAccountId) { $env:CLOUDFLARE_ACCOUNT_ID = $previousAccountId }
    else { Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue }
}
