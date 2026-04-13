@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM Read publisher and version from package.json via PowerShell
for /f "delims=" %%A in ('powershell -NoProfile -Command "(Get-Content package.json -Raw | ConvertFrom-Json).publisher"') do set "PUBLISHER=%%A"
for /f "delims=" %%A in ('powershell -NoProfile -Command "(Get-Content package.json -Raw | ConvertFrom-Json).version"') do set "VERSION=%%A"
set "EXT_ID=!PUBLISHER!.icm-exchange-repl"
set "VSIX=icm-exchange-repl-!VERSION!.vsix"

echo Publisher : !PUBLISHER!
echo Version   : !VERSION!
echo VSIX      : !VSIX!
echo.

echo [1/2] Packaging extension...
call npx @vscode/vsce package
if errorlevel 1 (
  echo Packaging failed.
  exit /b 1
)
echo Packaging done.
echo.

echo [2/2] Installing extension into VS Code...
call code --install-extension "!VSIX!" --force
if errorlevel 1 (
  echo Install failed.
  exit /b 1
)
echo Install step done.
echo.

echo Done. Reload VS Code (Ctrl+Shift+P -^> Reload Window) to activate the updated extension.
endlocal
