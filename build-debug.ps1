$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-JavaHome {
    $candidates = @(
        $env:JAVA_HOME,
        "$env:ProgramFiles\Microsoft\jdk-*",
        "$env:ProgramFiles\Eclipse Adoptium\jdk-*",
        "$env:ProgramFiles\Java\jdk-*",
        "$env:LOCALAPPDATA\Programs\Microsoft\jdk-*",
        "$env:LOCALAPPDATA\Programs\Eclipse Adoptium\jdk-*",
        "$env:LOCALAPPDATA\Android\Sdk\jbr"
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        $items = Get-Item $candidate -ErrorAction SilentlyContinue
        foreach ($item in @($items)) {
            $java = Join-Path $item.FullName 'bin\java.exe'
            $javac = Join-Path $item.FullName 'bin\javac.exe'
            $version = (& $java -version 2>&1 | Select-Object -First 1)
            $major = if ($version -match 'version "(\d+)') { [int]$Matches[1] } else { $null }
            if ((Test-Path $java) -and (Test-Path $javac) -and ($major -eq 17 -or $major -eq 21)) {
                return $item.FullName
            }
        }
    }
    return $null
}

$javaHome = Find-JavaHome
if (-not $javaHome) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host '[CLASH AI] No JDK found. Installing Microsoft OpenJDK 17...'
        & $winget.Source install --id Microsoft.OpenJDK.17 --exact --silent --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -eq 0) {
            $javaHome = Find-JavaHome
        }
    }
}

if (-not $javaHome) {
    throw 'No usable JDK was found. Install JDK 17 or 21, then run this script again.'
}

$env:JAVA_HOME = $javaHome
$javaBin = Join-Path $javaHome 'bin'
if (($env:Path -split ';') -notcontains $javaBin) {
    $env:Path = "$javaBin;$env:Path"
}
Write-Host "[CLASH AI] JAVA_HOME=$env:JAVA_HOME"
& (Join-Path $javaBin 'java.exe') -version

$required = @(
    'platforms\android-36\android.jar',
    'build-tools\36.0.0\aapt2.exe',
    'platform-tools\adb.exe'
)
$sdkCandidates = @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME)
$localProperties = Join-Path $root 'android\local.properties'
if (Test-Path -LiteralPath $localProperties) {
    $sdkLine = Get-Content -LiteralPath $localProperties | Where-Object { $_ -match '^\s*sdk\.dir\s*=' } | Select-Object -First 1
    if ($sdkLine) {
        $sdkCandidates += (($sdkLine -split '=', 2)[1].Trim() -replace '\\\\', '\')
    }
}
$sdkCandidates += @(
    (Join-Path $env:USERPROFILE 'AppData\Local\Android\Sdk'),
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
)
$sdk = $null
foreach ($candidate in $sdkCandidates | Where-Object { $_ }) {
    $missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $candidate $_)) })
    if ($missing.Count -eq 0) {
        $sdk = $candidate
        break
    }
}
if (-not $sdk) {
    $expected = $required | ForEach-Object { Join-Path (Join-Path $env:USERPROFILE 'AppData\Local\Android\Sdk') $_ }
    throw "Android SDK components are missing:`n$($expected -join "`n")"
}
Write-Host "[CLASH AI] Android SDK=$sdk"

$android = Join-Path $root 'android'
Push-Location $android
try {
    $gradle = Join-Path $android 'gradlew.bat'
    & $gradle assembleDebug --console=plain --stacktrace
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host '[CLASH AI] Debug APK created:'
Write-Host (Join-Path $android 'app\build\outputs\apk\debug\app-debug.apk')
