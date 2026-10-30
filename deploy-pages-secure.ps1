$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$siteDirectory = Join-Path $projectRoot 'www'
$wrangler = Join-Path $projectRoot 'node_modules\.bin\wrangler.cmd'

if (-not (Test-Path -LiteralPath $siteDirectory -PathType Container)) {
    throw "Répertoire Pages introuvable : $siteDirectory"
}

if (-not (Test-Path -LiteralPath $wrangler -PathType Leaf)) {
    throw "Wrangler introuvable : $wrangler"
}

$previousApiToken = $env:CLOUDFLARE_API_TOKEN
$previousAccountId = $env:CLOUDFLARE_ACCOUNT_ID

try {
    Remove-Item Env:CLOUDFLARE_API_TOKEN, Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue

    & $wrangler whoami
    if ($LASTEXITCODE -ne 0) {
        throw 'Wrangler n''est pas connecté. Lance .\node_modules\.bin\wrangler.cmd login puis réessaie.'
    }

    & $wrangler pages deploy $siteDirectory --project-name clash-ai --branch main
    if ($LASTEXITCODE -ne 0) {
        throw "Le déploiement Pages a échoué (code $LASTEXITCODE)."
    }
}
finally {
    if ($null -ne $previousApiToken) { $env:CLOUDFLARE_API_TOKEN = $previousApiToken }
    else { Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue }
    if ($null -ne $previousAccountId) { $env:CLOUDFLARE_ACCOUNT_ID = $previousAccountId }
    else { Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue }
}
