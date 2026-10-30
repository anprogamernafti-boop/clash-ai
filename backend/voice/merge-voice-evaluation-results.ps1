param(
  [Parameter(Mandatory = $true)]
  [string[]]$InputFiles
)

$ErrorActionPreference = 'Stop'
$fields = @('phrase_id', 'sample_file', 'model_version', 'listener_id', 'listener_tunisian_derja_fluent', 'accent_natural_1_to_5', 'understood', 'words_correct', 'complete', 'pace_ok', 'problem_note')
$resolvedFiles = @($InputFiles | ForEach-Object { (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path })
if ($resolvedFiles.Count -lt 3) {
  throw 'Fournis les TSV des trois auditeurs indépendants au minimum.'
}

$directories = @($resolvedFiles | ForEach-Object { [IO.Path]::GetDirectoryName($_) } | Select-Object -Unique)
if ($directories.Count -ne 1) {
  throw 'Place tous les TSV téléchargés dans le dossier commun des WAV avant leur fusion.'
}

$rows = @()
foreach ($file in $resolvedFiles) {
  $header = (Get-Content -LiteralPath $file -TotalCount 1 -Encoding UTF8).TrimStart([char]0xFEFF).Split("`t")
  if ($header.Count -ne $fields.Count -or @($fields | Where-Object { $_ -notin $header }).Count -gt 0) {
    throw "Colonnes TSV incorrectes : $file"
  }
  $fileRows = @(Import-Csv -LiteralPath $file -Delimiter "`t" -Encoding UTF8)
  if ($fileRows.Count -eq 0) { throw "Aucune évaluation dans $file" }
  $rows += $fileRows
}

$listeners = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$versions = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$reviews = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$phraseSamples = @{}
foreach ($row in $rows) {
  foreach ($field in $fields) {
    $value = [string]$row.$field
    if (($field -ne 'problem_note' -and [string]::IsNullOrWhiteSpace($value)) -or $value -match '[\t\r\n]') {
      throw "Valeur vide ou caractère TSV interdit dans '$field'."
    }
  }
  if ([string]$row.listener_tunisian_derja_fluent -cne 'yes') {
    throw "L’auditeur doit attester maîtriser la Derja tunisienne : $($row.listener_id)."
  }
  [void]$listeners.Add([string]$row.listener_id)
  [void]$versions.Add([string]$row.model_version)
  $reviewKey = "$($row.phrase_id)|$($row.listener_id)"
  if (-not $reviews.Add($reviewKey)) { throw "Évaluation en double : $reviewKey" }
  if ($phraseSamples.ContainsKey([string]$row.phrase_id) -and $phraseSamples[[string]$row.phrase_id] -cne [string]$row.sample_file) {
    throw "Plusieurs fichiers audio pour la phrase $($row.phrase_id)."
  }
  $phraseSamples[[string]$row.phrase_id] = [string]$row.sample_file
}

if ($listeners.Count -lt 3) { throw 'Au moins trois codes auditeur distincts sont requis.' }
if ($versions.Count -ne 1) { throw 'Les TSV mélangent plusieurs versions de modèle.' }

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$outputPath = Join-Path $directories[0] "voice-evaluation-results-$timestamp.tsv"
if (Test-Path -LiteralPath $outputPath) { throw "Le résultat existe déjà ; aucun fichier n’a été remplacé : $outputPath" }
$lines = @($fields -join "`t")
foreach ($row in $rows) {
  $lines += (($fields | ForEach-Object { [string]$row.$_ }) -join "`t")
}
[IO.File]::WriteAllLines($outputPath, $lines, [Text.UTF8Encoding]::new($false))
Write-Host "Évaluations fusionnées : $outputPath"
Write-Host "Phrases : $($phraseSamples.Count) | Évaluateurs : $($listeners.Count) | Version : $(@($versions)[0])"
Write-Host 'Étape suivante : node backend/voice/evaluate-voice-corpus.mjs <fichier fusionné.tsv>'
