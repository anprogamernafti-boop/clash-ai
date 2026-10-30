param(
  [string]$InputJsonPath,
  [string]$SpokenText = 'ya 7yati',
  [string]$ArabicText = 'يَا حْيَاتِي'
)

$ErrorActionPreference = 'Stop'

if (-not $InputJsonPath) {
  $downloadsDirectory = Join-Path $env:USERPROFILE 'Downloads'
  if (Test-Path -LiteralPath $downloadsDirectory -PathType Container) {
    $latestExport = Get-ChildItem -LiteralPath $downloadsDirectory -Filter 'clash-ai-voice-pilot*.json' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($latestExport) { $InputJsonPath = $latestExport.FullName }
  }
}

if ($InputJsonPath) {
  $inputFile = Get-Item -LiteralPath $InputJsonPath -ErrorAction Stop
  $pair = Get-Content -LiteralPath $inputFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  if ($pair.version -ne 1 -or [string]::IsNullOrWhiteSpace([string]$pair.punchline) -or [string]::IsNullOrWhiteSpace([string]$pair.punchline_ar)) {
    throw 'Le fichier doit être un export Clash AI version 1 contenant punchline et punchline_ar.'
  }
  $SpokenText = [string]$pair.punchline
  $ArabicText = [string]$pair.punchline_ar
}

$spokenText = $SpokenText.Trim()
$arabicText = $ArabicText.Trim()
if (-not $spokenText -or -not $arabicText) {
  throw 'Les deux textes, latin et arabe vocalisé, sont obligatoires.'
}
if ($InputJsonPath) {
  Write-Host "Paire Clash AI importée depuis : $($inputFile.Name)"
}
Write-Host "Phrase envoyée à VoxCPM : $spokenText"
$secureToken = Read-Host 'VOICE_PILOT_TOKEN (saisie masquée)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)

try {
  $bearerToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $payload = @{ text = $spokenText; ar = $arabicText; lang = 'fr' } | ConvertTo-Json -Compress
  $httpResponse = Invoke-WebRequest -SkipHttpErrorCheck `
    -Uri 'https://clash-voice-pilot.asser-dev.workers.dev/voix' `
    -Method Post `
    -TimeoutSec 240 `
    -Headers @{ Authorization = "Bearer $bearerToken" } `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($payload))

  if ($httpResponse.StatusCode -lt 200 -or $httpResponse.StatusCode -ge 300) {
    $detail = [string]$httpResponse.Content
    if ($detail.Length -gt 1200) { $detail = $detail.Substring(0, 1200) }
    throw "Échec du test HTTP $($httpResponse.StatusCode) : $detail"
  }

  $response = $httpResponse.Content | ConvertFrom-Json
  if (-not $response.ok -or -not $response.audio -or $response.mime -ne 'audio/wav') {
    throw 'Le pilote a renvoyé une réponse audio invalide.'
  }

  $audioBytes = [Convert]::FromBase64String($response.audio)
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $outputPath = Join-Path $PSScriptRoot "voxcpm-pilot-test-$timestamp.wav"
  [IO.File]::WriteAllBytes($outputPath, $audioBytes)
  $sampleMetadata = [ordered]@{
    schema_version = 1
    phrase_id = $timestamp
    sample_file = [IO.Path]::GetFileName($outputPath)
    model_version = [string]$response.version
    moteur = [string]$response.moteur
    displayed_text = $spokenText
    tts_text = $arabicText
    audio_sha256 = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $metadataPath = "$outputPath.sample.json"
  $sampleMetadata | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $metadataPath -Encoding utf8
  Write-Host "Audio VoxCPM reçu : $outputPath"
  Write-Host "Métadonnées locales : $metadataPath"
  Write-Host "Moteur : $($response.moteur) | Version : $($response.version) | Taille : $($audioBytes.Length) octets"
  Start-Process -FilePath $outputPath
} catch {
  $response = $_.Exception.Response
  if ($response) {
    $statusCode = 0
    try { $statusCode = [int]$response.StatusCode } catch {}
    $responseBody = ''
    try {
      if ($response.Content) {
        $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      } elseif ($response.GetResponseStream()) {
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $responseBody = $reader.ReadToEnd() } finally { $reader.Dispose() }
      }
    } catch {}
    if ($responseBody) {
      Write-Error "Échec du test HTTP $statusCode : $responseBody"
    }
    Write-Error "Échec du test HTTP $statusCode."
  }
  Write-Error $_.Exception.Message
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $secureToken.Dispose()
  Remove-Variable bearerToken, payload, response, audioBytes -ErrorAction SilentlyContinue
}
