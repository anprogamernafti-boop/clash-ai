@echo off

@rem Keep a valid JAVA_HOME, otherwise find common JDK and Android Studio locations.
if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" if exist "%JAVA_HOME%\bin\javac.exe" goto found
set "JAVA_HOME="
for %%D in (
  "%ProgramFiles%\Microsoft\jdk-*"
  "%ProgramFiles%\Eclipse Adoptium\jdk-*"
  "%ProgramFiles%\Java\jdk-*"
  "%ProgramFiles%\Android\Android Studio\jbr"
  "%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-*"
  "%LOCALAPPDATA%\Programs\Microsoft\jdk-*"
  "%LOCALAPPDATA%\Android\Sdk\jbr"
) do (
  if exist "%%~D\bin\java.exe" if exist "%%~D\bin\javac.exe" (
    set "JAVA_HOME=%%~D"
    goto found
  )
)

for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\JavaSoft\JDK" /v CurrentVersion 2^>nul') do set "JAVA_VERSION=%%B"
if defined JAVA_VERSION for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\JavaSoft\JDK\%JAVA_VERSION%" /v JavaHome 2^>nul') do (
  if exist "%%B\bin\java.exe" if exist "%%B\bin\javac.exe" (
    set "JAVA_HOME=%%B"
    goto found
  )
)

where winget >NUL 2>&1
if not errorlevel 1 (
  echo [CLASH AI] No JDK detected. Installing Microsoft OpenJDK 17 with winget...
  winget install --id Microsoft.OpenJDK.17 --exact --silent --accept-source-agreements --accept-package-agreements
  if not errorlevel 1 (
    for %%D in (
      "%ProgramFiles%\Microsoft\jdk-*"
      "%LOCALAPPDATA%\Programs\Microsoft\jdk-*"
    ) do (
      if exist "%%~D\bin\java.exe" if exist "%%~D\bin\javac.exe" (
        set "JAVA_HOME=%%~D"
        goto found
      )
    )
  )
)

:missing
echo [CLASH AI] No usable JDK was found.
echo Install a 64-bit JDK 17 or 21, then open a new terminal and run:
echo   call setup-java.cmd
echo Example: https://learn.microsoft.com/java/openjdk/download
exit /b 1

:found
set "Path=%JAVA_HOME%\bin;%Path%"
echo [CLASH AI] JAVA_HOME=%JAVA_HOME%
java -version
