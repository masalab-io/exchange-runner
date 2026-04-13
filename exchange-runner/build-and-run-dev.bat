@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM Read publisher and version from package.json via PowerShell
for /f "delims=" %%A in ('powershell -NoProfile -Command "(Get-Content package.json -Raw | ConvertFrom-Json).publisher"') do set "PUBLISHER=%%A"
for /f "delims=" %%A in ('powershell -NoProfile -Command "(Get-Content package.json -Raw | ConvertFrom-Json).version"') do set "VERSION=%%A"
set "EXT_ID=!PUBLISHER!.exchange-runner"
set "VSIX=exchange-runner-!VERSION!.vsix"

echo Publisher : !PUBLISHER!
echo Version   : !VERSION!
echo VSIX      : !VSIX!
echo.

echo [1/3] Uninstalling existing extension (if installed)...
call cursor --uninstall-extension "!EXT_ID!" 2>nul
echo Uninstall step done.
echo.

echo [2/3] Packaging extension...
call npx @vscode/vsce package
if errorlevel 1 (
  echo Packaging failed.
  exit /b 1
)
echo Packaging done.
echo.

echo [3/3] Installing extension into Cursor...
call cursor --install-extension "!VSIX!" --force
if errorlevel 1 (
  echo Install failed.
  exit /b 1
)
echo Install step done.
echo.

echo Done. Reload Cursor (Ctrl+Shift+P -^> Reload Window) to activate the updated extension.
endlocal
