@echo off
@rem ============================================================================
@rem  Clash AI — APK « hors Play Store » : paiement D17 + redirection WhatsApp.
@rem
@rem  Produit android\app\build\outputs\apk\debug\app-debug.apk, puis en copie
@rem  clash-ai-partage.apk a la racine. Le projet est remis en mode Play Store a
@rem  la fin, pour que build-debug.cmd reste le bon point d'entree.
@rem
@rem  Ne pas publier cet APK sur le Play Store : la politique « Payments » de
@rem  Google interdit un lien de paiement externe pour du contenu numerique.
@rem ============================================================================
setlocal
set "ROOT=%~dp0"
set "PAYMODE=%ROOT%www\pay-mode.js"

call "%ROOT%setup-java.cmd"
if errorlevel 1 exit /b 1

call "%ROOT%setup-android.cmd"
if errorlevel 1 exit /b 1

if not exist "%ROOT%android\gradlew.bat" (
  echo [CLASH AI] Gradle wrapper introuvable : "%ROOT%android\gradlew.bat"
  exit /b 1
)

echo [CLASH AI] Construction de l'APK « hors Play Store » (D17 / WhatsApp)...
(
  echo /* Mode de paiement — genere par les scripts de build. Ne pas editer a la main. */
  echo window.CLASH_PAY_MODE = 'external';
) > "%PAYMODE%"

cd /d "%ROOT%"
call npx cap sync android
if errorlevel 1 goto :erreur

cd /d "%ROOT%android"
call gradlew.bat assembleDebug --console=plain --stacktrace
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :erreur

copy /Y "%ROOT%android\app\build\outputs\apk\debug\app-debug.apk" "%ROOT%clash-ai-partage.apk" >nul
echo.
echo [CLASH AI] APK a partager (virement D17 + WhatsApp) :
echo   "%ROOT%clash-ai-partage.apk"
echo [CLASH AI] Installation : adb install -r "%ROOT%clash-ai-partage.apk"
goto :restaurer

:erreur
echo.
echo [CLASH AI] Echec de la construction. Voir le premier bloc « What went wrong: » ci-dessus.
set "EXIT_CODE=1"

:restaurer
@rem Retour au mode Play Store : le depot reste coherent avec build-debug.cmd.
(
  echo /* Mode de paiement — genere par les scripts de build. Ne pas editer a la main. */
  echo window.CLASH_PAY_MODE = 'play';
) > "%PAYMODE%"
cd /d "%ROOT%"
call npx cap sync android >nul 2>&1

exit /b %EXIT_CODE%
