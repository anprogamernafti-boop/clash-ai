param(
  [string]$Directory = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$resolvedDirectory = (Resolve-Path -LiteralPath $Directory -ErrorAction Stop).Path
$metadataFiles = @(Get-ChildItem -LiteralPath $resolvedDirectory -Filter '*.wav.sample.json' -File)
if ($metadataFiles.Count -eq 0) {
  throw 'Aucun sidecar *.wav.sample.json trouvé. Génère les échantillons avec test-voxcpm-pilot.ps1.'
}

$records = @()
$seenPhraseIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$seenDisplayedTexts = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$seenAudioHashes = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

foreach ($metadataFile in $metadataFiles) {
  $metadata = Get-Content -LiteralPath $metadataFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  if ($metadata.schema_version -ne 1 -or -not $metadata.phrase_id -or -not $metadata.sample_file -or -not $metadata.model_version -or -not $metadata.displayed_text -or -not $metadata.tts_text) {
    throw "Sidecar incomplet : $($metadataFile.Name)"
  }
  if ([IO.Path]::GetFileName([string]$metadata.sample_file) -cne [string]$metadata.sample_file) {
    throw "Nom audio non sûr dans le sidecar : $($metadataFile.Name)"
  }
  if (-not $seenPhraseIds.Add([string]$metadata.phrase_id)) {
    throw "Identifiant de phrase dupliqué : $($metadata.phrase_id)"
  }
  $displayedTextKey = ([string]$metadata.displayed_text).Normalize([Text.NormalizationForm]::FormKD).ToLowerInvariant()
  $displayedTextKey = [regex]::Replace($displayedTextKey, '\p{Mn}', '')
  $displayedTextKey = [regex]::Replace($displayedTextKey, '[\p{P}\p{S}]', ' ')
  $displayedTextKey = [regex]::Replace($displayedTextKey, '\s+', ' ').Trim()
  if (-not $seenDisplayedTexts.Add($displayedTextKey)) {
    throw "Texte de clash dupliqué après normalisation (ponctuation/diacritiques ignorés) : $($metadata.displayed_text)"
  }

  $audioPath = Join-Path $resolvedDirectory ([string]$metadata.sample_file)
  if (-not (Test-Path -LiteralPath $audioPath -PathType Leaf)) {
    throw "WAV absent pour $($metadataFile.Name) : $($metadata.sample_file)"
  }
  $actualHash = (Get-FileHash -LiteralPath $audioPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -cne ([string]$metadata.audio_sha256).ToLowerInvariant()) {
    throw "L’empreinte du WAV ne correspond pas au sidecar : $($metadata.sample_file)"
  }
  if (-not $seenAudioHashes.Add($actualHash)) {
    throw "Audio binaire dupliqué, non comptable comme phrase distincte : $($metadata.sample_file)"
  }

  $expectedText = "Clash affiché : $($metadata.displayed_text) | Texte envoyé à VoxCPM : $($metadata.tts_text)"
  $expectedText = $expectedText -replace '[\t\r\n]+', ' '
  $records += [pscustomobject]@{
    phrase_id = [string]$metadata.phrase_id
    sample_file = [string]$metadata.sample_file
    model_version = [string]$metadata.model_version
    expected_text = $expectedText
  }
}

$modelVersions = @($records | Select-Object -ExpandProperty model_version -Unique)
if ($modelVersions.Count -ne 1) {
  throw 'Les sidecars mélangent plusieurs versions de modèle. Crée un manifeste séparé par version.'
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$manifestPath = Join-Path $resolvedDirectory "voice-corpus-manifest-$timestamp.tsv"
if (Test-Path -LiteralPath $manifestPath) { throw "Le manifeste existe déjà ; aucun fichier n’a été remplacé : $manifestPath" }
$lines = @("phrase_id`tsample_file`tmodel_version`texpected_text")
foreach ($record in $records) {
  $lines += "$($record.phrase_id)`t$($record.sample_file)`t$($record.model_version)`t$($record.expected_text)"
}
[IO.File]::WriteAllLines($manifestPath, $lines, [Text.UTF8Encoding]::new($false))
Write-Host "Manifeste créé : $manifestPath"
Write-Host "Phrases distinctes : $($records.Count) | Version : $($modelVersions[0])"
Write-Host 'Le manifeste et les WAV sont dans le même dossier ; ne modifie pas les fichiers audio après création.'
