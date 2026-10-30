param(
  [string]$RootDirectory = $PSScriptRoot,
  [int]$TargetPhrases = 100
)

$ErrorActionPreference = 'Stop'
if ($TargetPhrases -lt 1) { throw 'TargetPhrases doit être supérieur à zéro.' }

$resolvedRoot = (Resolve-Path -LiteralPath $RootDirectory -ErrorAction Stop).Path
$sidecars = @(Get-ChildItem -LiteralPath $resolvedRoot -Filter '*.wav.sample.json' -File -Recurse)
if ($sidecars.Count -eq 0) {
  Write-Host "Aucun échantillon trouvé sous $resolvedRoot."
  return
}

$records = [Collections.Generic.List[object]]::new()
$issues = [Collections.Generic.List[string]]::new()

foreach ($sidecar in $sidecars) {
  try {
    $metadata = Get-Content -LiteralPath $sidecar.FullName -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $issues.Add("Sidecar illisible : $($sidecar.FullName)")
    continue
  }

  if ($metadata.schema_version -ne 1 -or [string]::IsNullOrWhiteSpace([string]$metadata.model_version) -or
      [string]::IsNullOrWhiteSpace([string]$metadata.displayed_text) -or
      [string]::IsNullOrWhiteSpace([string]$metadata.sample_file) -or
      [string]::IsNullOrWhiteSpace([string]$metadata.audio_sha256)) {
    $issues.Add("Sidecar incomplet : $($sidecar.FullName)")
    continue
  }
  if ([IO.Path]::GetFileName([string]$metadata.sample_file) -cne [string]$metadata.sample_file) {
    $issues.Add("Nom audio non sûr dans le sidecar : $($sidecar.FullName)")
    continue
  }

  $audioPath = Join-Path $sidecar.DirectoryName ([string]$metadata.sample_file)
  if (-not (Test-Path -LiteralPath $audioPath -PathType Leaf)) {
    $issues.Add("WAV absent : $audioPath")
    continue
  }
  $actualHash = (Get-FileHash -LiteralPath $audioPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -cne ([string]$metadata.audio_sha256).ToLowerInvariant()) {
    $issues.Add("Empreinte WAV incorrecte : $audioPath")
    continue
  }

  $phraseKey = ([string]$metadata.displayed_text).Normalize([Text.NormalizationForm]::FormKD).ToLowerInvariant()
  $phraseKey = [regex]::Replace($phraseKey, '\p{Mn}', '')
  $phraseKey = [regex]::Replace($phraseKey, '[\p{P}\p{S}]', ' ')
  $phraseKey = [regex]::Replace($phraseKey, '\s+', ' ').Trim()
  if (-not $phraseKey) {
    $issues.Add("Texte affiché vide après normalisation : $($sidecar.FullName)")
    continue
  }

  $records.Add([pscustomobject]@{
    Version = [string]$metadata.model_version
    PhraseKey = $phraseKey
    SampleFile = [string]$metadata.sample_file
  })
}

$summary = @($records | Group-Object Version | Sort-Object Name | ForEach-Object {
  $phraseCount = @($_.Group | Select-Object -ExpandProperty PhraseKey -Unique).Count
  [pscustomobject]@{
    Version = $_.Name
    AudioValides = $_.Count
    PhrasesDistinctes = $phraseCount
    Objectif = $TargetPhrases
    Restantes = [Math]::Max(0, $TargetPhrases - $phraseCount)
  }
})

$summary | Format-Table -AutoSize
if ($issues.Count -gt 0) {
  Write-Error ("Échantillons invalides ({0}) :`n- {1}" -f $issues.Count, ($issues -join "`n- "))
}
Write-Host 'Le compteur porte sur les phrases distinctes par version ; il ne remplace pas les écoutes ni les évaluations humaines.'
