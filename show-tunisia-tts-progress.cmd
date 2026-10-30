@echo off
setlocal
cd /d "%~dp0"
set "LOG=%~dp0training-progress.log"
if not exist "%LOG%" (
  echo Le journal n'est pas encore cree. Patiente quelques secondes, puis relance ce fichier.
  pause
  exit /b 1
)
"%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath '%LOG%' -Tail 40 -Wait"
