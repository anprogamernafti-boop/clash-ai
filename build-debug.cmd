@echo off
setlocal
set "ROOT=%~dp0"

call "%ROOT%setup-java.cmd"
if errorlevel 1 exit /b 1

call "%ROOT%setup-android.cmd"
if errorlevel 1 exit /b 1

if not exist "%ROOT%android\gradlew.bat" (
  echo [CLASH AI] Gradle wrapper not found: "%ROOT%android\gradlew.bat"
  exit /b 1
)

@rem Paquet Play Store : facturation Google Play, bloc D17/WhatsApp masque dans l'app.
(
  echo /* Mode de paiement — genere par les scripts de build. Ne pas editer a la main. */
  echo window.CLASH_PAY_MODE = 'play';
) > "%ROOT%www\pay-mode.js"

cd /d "%ROOT%"
call npx cap sync android
if errorlevel 1 exit /b 1

cd /d "%ROOT%android"
call gradlew.bat assembleDebug --console=plain --stacktrace
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [CLASH AI] Build failed. Full output is available in the terminal above.
  echo [CLASH AI] Check the first block beginning with "What went wrong:".
) else (
  echo.
  echo [CLASH AI] Debug APK:
  echo "%ROOT%android\app\build\outputs\apk\debug\app-debug.apk"
)

exit /b %EXIT_CODE%
