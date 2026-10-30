param(
  [string]$InputDirectory = (Join-Path $env:USERPROFILE 'Downloads'),
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'voxcpm-corpus-batch'),
  [int]$MaxRequests = 2,
  [switch]$LatestExportOnly,
  [switch]$AllowSamePhraseRetest,
  [int]$PauseSeconds = 31
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedLatinWords {
  param([string]$Value)

  foreach ($match in [regex]::Matches($Value, '[A-Za-zÀ-ÖØ-öø-ÿ]+')) {
    $word = $match.Value.Normalize([Text.NormalizationForm]::FormD).ToLowerInvariant()
    $word = [regex]::Replace($word, '\p{Mn}', '')
    if ($word -eq 'identity') { $word = 'identite' }
    $word
  }
}

function Get-NormalizedDisplayedTextKey {
  param([string]$Value)

  $normalized = $Value.Normalize([Text.NormalizationForm]::FormKD).ToLowerInvariant()
  $normalized = [regex]::Replace($normalized, '\p{Mn}', '')
  $normalized = [regex]::Replace($normalized, '[\p{P}\p{S}]', ' ')
  [regex]::Replace($normalized, '\s+', ' ').Trim()
}

if ($MaxRequests -lt 1 -or $MaxRequests -gt 10) {
  throw 'MaxRequests doit être compris entre 1 et 10.'
}
if ($PauseSeconds -lt 31) {
  throw 'PauseSeconds doit être au moins égal à 31 pour respecter le limiteur du pilote.'
}

$resolvedInputDirectory = (Resolve-Path -LiteralPath $InputDirectory -ErrorAction Stop).Path
$exportFiles = @(Get-ChildItem -LiteralPath $resolvedInputDirectory -Filter 'clash-ai-voice-pilot*.json' -File | Sort-Object LastWriteTime, Name)
if ($exportFiles.Count -eq 0) {
  throw "Aucun export clash-ai-voice-pilot*.json trouvé dans $resolvedInputDirectory."
}
if ($LatestExportOnly) {
  $exportFiles = @($exportFiles | Sort-Object LastWriteTime, Name -Descending | Select-Object -First 1)
}

if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}
$corpusRoot = (Resolve-Path -LiteralPath $OutputDirectory -ErrorAction Stop).Path
$dedupeRoot = if ($AllowSamePhraseRetest) { $corpusRoot } else { $PSScriptRoot }

$existingPhrases = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$sampleSidecars = @(Get-ChildItem -LiteralPath $dedupeRoot -Filter '*.wav.sample.json' -File -Recurse -ErrorAction SilentlyContinue)
foreach ($sidecar in $sampleSidecars) {
  try {
    $metadata = Get-Content -LiteralPath $sidecar.FullName -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    if ($metadata.displayed_text) {
      [void]$existingPhrases.Add((Get-NormalizedDisplayedTextKey ([string]$metadata.displayed_text)))
    }
  } catch {
    throw "Sidecar illisible dans le corpus ; aucune génération lancée : $($sidecar.FullName)"
  }
}

$seenPhrases = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$candidates = [Collections.Generic.List[object]]::new()
$bearerToken = $null
$requestCount = 0
$successCount = 0
$skippedCount = 0

foreach ($exportFile in $exportFiles) {
  try {
    $pair = Get-Content -LiteralPath $exportFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Write-Warning "Export JSON invalide, ignoré : $($exportFile.Name)"
    $skippedCount++
    continue
  }

  if ($pair.version -ne 1 -or [string]::IsNullOrWhiteSpace([string]$pair.punchline) -or [string]::IsNullOrWhiteSpace([string]$pair.punchline_ar)) {
    Write-Warning "Export sans paire Clash AI version 1 valide, ignoré : $($exportFile.Name)"
    $skippedCount++
    continue
  }

  $displayedText = ([string]$pair.punchline).Trim()
  $ttsText = ([string]$pair.punchline_ar).Trim()
  $preservedFrenchWords = @(
    'photo', 'identite', 'passeport', 'avatar', 'jeu', 'video', 'bug', 'pose', 'photomaton', 'vip',
    'le', 'fond', 'bleu', 'officielle', 'carte', 'secret', 'micro', 'automatique', 'serieux', 'style',
    'statue', 'telecommande', 'sourire', 'professionnel', 'loading', 'screen'
  )
  $sourceWords = @(Get-NormalizedLatinWords $displayedText | Select-Object -Unique)
  $spokenWords = @(Get-NormalizedLatinWords $ttsText | Select-Object -Unique)
  $missingFrenchWords = @($preservedFrenchWords | Where-Object {
    $_ -in $sourceWords -and $_ -notin $spokenWords
  })
  if ($missingFrenchWords.Count -gt 0) {
    Write-Warning "Export ignoré avant tout appel GPU : mots français/anglais translittérés ou omis ($($missingFrenchWords -join ', ')). Garde le français et les homographes en orthographe française ; conserve les mots exclusivement anglais en lettres latines."
    $skippedCount++
    continue
  }

  $phraseKey = Get-NormalizedDisplayedTextKey $displayedText
  if ($existingPhrases.Contains($phraseKey) -or -not $seenPhrases.Add($phraseKey)) {
    Write-Host "Phrase déjà présente dans le corpus, ignorée : $($exportFile.Name)"
    $skippedCount++
    continue
  }

  $candidates.Add([pscustomobject]@{
    File = $exportFile
    DisplayedText = $displayedText
    TtsText = $ttsText
    PhraseKey = $phraseKey
  })
}

if ($candidates.Count -eq 0) {
  Write-Host "Lot terminé : 0 audio(s) produit(s), $skippedCount ignoré(s), 0 tentative(s)."
  Write-Host 'Aucune nouvelle phrase valide : aucun jeton opérateur demandé et aucun appel GPU effectué.'
  if ($AllowSamePhraseRetest) { Write-Host "Dédoublonnage limité au dossier de sortie demandé : $corpusRoot" }
  else { Write-Host "Dédoublonnage global du corpus : $dedupeRoot" }
  Write-Host "Racine du corpus : $corpusRoot"
  return
}

$selectedCandidates = @($candidates | Select-Object -First $MaxRequests)
$secureToken = Read-Host 'VOICE_PILOT_TOKEN (saisie masquée)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)

try {
  $bearerToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  foreach ($candidate in $selectedCandidates) {
    $exportFile = $candidate.File
    $displayedText = $candidate.DisplayedText
    $ttsText = $candidate.TtsText
    $phraseKey = $candidate.PhraseKey

    if ($requestCount -gt 0) {
      Start-Sleep -Seconds $PauseSeconds
    }
    $requestCount++
    Write-Host "Test $requestCount/$($selectedCandidates.Count) : $($exportFile.Name)"

    $payload = @{ text = $displayedText; ar = $ttsText; lang = 'fr' } | ConvertTo-Json -Compress
    $httpResponse = Invoke-WebRequest -SkipHttpErrorCheck `
      -Uri 'https://clash-voice-pilot.asser-dev.workers.dev/voix' `
      -Method Post `
      -TimeoutSec 240 `
      -Headers @{ Authorization = "Bearer $bearerToken" } `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([Text.Encoding]::UTF8.GetBytes($payload))

    $responseBody = [string]$httpResponse.Content
    if ($httpResponse.StatusCode -lt 200 -or $httpResponse.StatusCode -ge 300) {
      $errorCode = ''
      try { $errorCode = [string](ConvertFrom-Json -InputObject $responseBody -ErrorAction Stop).code } catch {}
      if ($httpResponse.StatusCode -eq 429 -or $errorCode -eq 'quota_unavailable') {
        Write-Warning "Quota VoxCPM indisponible. Les WAV déjà produits sont conservés ; relance le script après renouvellement."
        break
      }
      if ($httpResponse.StatusCode -in 401, 403) {
        throw "Authentification opérateur refusée (HTTP $($httpResponse.StatusCode)). Vérifie le VOICE_PILOT_TOKEN sans le partager."
      }
      if ($httpResponse.StatusCode -ge 500) {
        Write-Warning "Échec temporaire du service (HTTP $($httpResponse.StatusCode)). Les WAV déjà produits sont conservés ; arrêt du lot."
        break
      }
      Write-Warning "Paire refusée avant synthèse (HTTP $($httpResponse.StatusCode)) : $($exportFile.Name)"
      continue
    }

    $voiceResponse = $responseBody | ConvertFrom-Json -ErrorAction Stop
    if (-not $voiceResponse.ok -or -not $voiceResponse.audio -or $voiceResponse.mime -ne 'audio/wav' -or -not $voiceResponse.version) {
      throw "Réponse audio invalide pour $($exportFile.Name)."
    }

    $audioBytes = [Convert]::FromBase64String([string]$voiceResponse.audio)
    $safeVersion = [regex]::Replace([string]$voiceResponse.version, '[^A-Za-z0-9._-]', '-')
    $versionDirectory = Join-Path $corpusRoot $safeVersion
    if (-not (Test-Path -LiteralPath $versionDirectory -PathType Container)) {
      New-Item -ItemType Directory -Path $versionDirectory | Out-Null
    }

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $outputPath = Join-Path $versionDirectory "voxcpm-pilot-test-$timestamp.wav"
    [IO.File]::WriteAllBytes($outputPath, $audioBytes)
    $metadata = [ordered]@{
      schema_version = 1
      phrase_id = $timestamp
      sample_file = [IO.Path]::GetFileName($outputPath)
      model_version = [string]$voiceResponse.version
      moteur = [string]$voiceResponse.moteur
      displayed_text = $displayedText
      tts_text = $ttsText
      audio_sha256 = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
      source_export = $exportFile.Name
    }
    $metadata | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath "$outputPath.sample.json" -Encoding utf8
    [void]$existingPhrases.Add($phraseKey)
    $successCount++
    Write-Host "Audio conservé : $outputPath ($($audioBytes.Length) octets)"
  }

  Write-Host "Lot terminé : $successCount audio(s) produit(s), $skippedCount ignoré(s), $requestCount tentative(s)."
  if ($AllowSamePhraseRetest) { Write-Host "Dédoublonnage limité au dossier de sortie demandé : $corpusRoot" }
  else { Write-Host "Dédoublonnage global du corpus : $dedupeRoot" }
  Write-Host "Racine du corpus : $corpusRoot"
  Write-Host 'Pour créer un manifeste, exécute build-voice-corpus-manifest.ps1 sur le sous-dossier de la version testée.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $secureToken.Dispose()
  Remove-Variable bearerToken, payload, httpResponse, voiceResponse, audioBytes -ErrorAction SilentlyContinue
}
