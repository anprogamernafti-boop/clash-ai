@echo off
setlocal

set "SDK_DIR=%ANDROID_SDK_ROOT%"
if not defined SDK_DIR set "SDK_DIR=%ANDROID_HOME%"
if not defined SDK_DIR set "SDK_DIR=%LOCALAPPDATA%\Android\Sdk"
if not exist "%SDK_DIR%\platforms\android-36\android.jar" (
  echo [CLASH AI] Android SDK Platform 36 is missing:
  echo   %SDK_DIR%\platforms\android-36
  goto missing
)

if not exist "%SDK_DIR%\build-tools\36.0.0\aapt2.exe" (
  echo [CLASH AI] Android Build Tools 36.0.0 are missing.
  goto missing
)

if not exist "%SDK_DIR%\platform-tools\adb.exe" (
  echo [CLASH AI] Android Platform Tools are missing.
  goto missing
)

set "SDK_PROP=%SDK_DIR:\=\\%"
> "%~dp0android\local.properties" echo sdk.dir=%SDK_PROP%
echo [CLASH AI] Android SDK is ready.
echo [CLASH AI] SDK=%SDK_DIR%
echo [CLASH AI] Wrote android\local.properties
exit /b 0

:missing
echo.
echo Install these packages in Android Studio:
echo   Android SDK Platform 36
echo   Android SDK Build-Tools 36.0.0
echo   Android SDK Platform-Tools
echo.
echo Then run:
echo   cd /d "%~dp0android"
echo   gradlew.bat assembleDebug
exit /b 1
