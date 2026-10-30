$ErrorActionPreference = 'Stop'

$configuredJavaHome = if ($env:JAVA_HOME) { $env:JAVA_HOME.Trim('"') } else { $null }
$candidates = @(
    $configuredJavaHome,
    "$env:ProgramFiles\Microsoft\jdk-*",
    "$env:ProgramFiles\Eclipse Adoptium\jdk-*",
    "$env:ProgramFiles\Java\jdk-*",
    "$env:LOCALAPPDATA\Programs\Eclipse Adoptium\jdk-*",
    "$env:LOCALAPPDATA\Programs\Microsoft\jdk-*",
    "$env:LOCALAPPDATA\Android\Sdk\jbr"
) | Where-Object { $_ }

$javaHome = $null
function Get-JavaMajorVersion([string]$home) {
    $java = Join-Path $home 'bin\java.exe'
    if (-not (Test-Path $java)) { return $null }
    $line = (& $java -version 2>&1 | Select-Object -First 1)
    if ($line -match 'version "(\d+)') { return [int]$Matches[1] }
    return $null
}
foreach ($pattern in $candidates) {
    $matches = if (Test-Path $pattern -PathType Container) {
        @(Get-Item $pattern -ErrorAction SilentlyContinue)
    } else {
        @(Get-Item $pattern -ErrorAction SilentlyContinue)
    }
    $match = $matches |
        Where-Object {
            (Test-Path (Join-Path $_.FullName 'bin\java.exe')) -and
            (Test-Path (Join-Path $_.FullName 'bin\javac.exe')) -and
            ((Get-JavaMajorVersion $_.FullName) -eq 17 -or (Get-JavaMajorVersion $_.FullName) -eq 21)
        } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($match) {
        $javaHome = $match.FullName
        break
    }
}

if (-not $javaHome) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host '[CLASH AI] No JDK detected. Installing Microsoft OpenJDK 17 with winget...'
        & $winget.Source install --id Microsoft.OpenJDK.17 --exact --silent --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -eq 0) {
            $javaHome = Get-Item "$env:ProgramFiles\Microsoft\jdk-*", "$env:LOCALAPPDATA\Programs\Microsoft\jdk-*" -ErrorAction SilentlyContinue |
                Where-Object {
                    (Test-Path (Join-Path $_.FullName 'bin\java.exe')) -and
                    (Test-Path (Join-Path $_.FullName 'bin\javac.exe')) -and
                    ((Get-JavaMajorVersion $_.FullName) -eq 17 -or (Get-JavaMajorVersion $_.FullName) -eq 21)
                } |
                Sort-Object FullName -Descending |
                Select-Object -First 1 |
                Select-Object -ExpandProperty FullName
        }
    }
}

if (-not $javaHome) {
    Write-Error @'
JDK not found and automatic installation was unavailable or failed.
Install a 64-bit JDK 17 or 21, then run this script again.
Downloads: https://learn.microsoft.com/java/openjdk/download
'@
    exit 1
}

$env:JAVA_HOME = $javaHome
$javaBin = Join-Path $javaHome 'bin'
if (($env:Path -split ';') -notcontains $javaBin) {
    $env:Path = "$javaBin;$env:Path"
}

Write-Host "[CLASH AI] JAVA_HOME=$env:JAVA_HOME"
& (Join-Path $javaBin 'java.exe') -version
