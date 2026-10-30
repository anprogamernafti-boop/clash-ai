@echo off
setlocal
cd /d "%~dp0"
set "LOG=%~dp0tunisia-tts-checkpoint-800\training-progress-balanced-blasa-v1.log"
echo Entrainement suspendu apres l'update 190, suite au test d'ecoute.
echo Dernier checkpoint sauvegarde et reutilisable : update 100.
if not exist "%LOG%" (
  echo Le journal n'est pas encore cree. Patiente quelques secondes, puis relance ce fichier.
  pause
  exit /b 1
)
"%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath '%LOG%' -Tail 40"
pause
