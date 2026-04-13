@echo off
setlocal enabledelayedexpansion

set "ARG1=%~1"
set "ARG2=%~2"
set "REPL_DIR=%~dp0"
set "ICM_EXE=C:\Program Files\Autodesk\InfoWorks ICM Ultimate 2026\ICMExchange.exe"

REM Two-arg mode (from extension): ARG1 = ruby file path, ARG2 = exe path
REM One-arg mode (manual): ARG1 = ruby file path, exe from icm-path.txt if present
if not "!ARG2!"=="" (
  set "RUBY_FILE=!ARG1!"
  set "ICM_EXE=!ARG2!"
) else (
  if "!ARG1!"=="" (
    echo Usage: run_ruby_repl.bat ^<path-to-ruby-file^> [exe-path]
    exit /b 1
  )
  set "RUBY_FILE=!ARG1!"
  if exist "%REPL_DIR%icm-path.txt" (
    set /p ICM_EXE=<"%REPL_DIR%icm-path.txt"
  )
)

if not exist "!ICM_EXE!" (
    echo ICMExchange.exe not found: !ICM_EXE!
    exit /b 1
)

for %%A in ("!ICM_EXE!") do set "EXE_BASENAME=%%~nxA"

REM Copy repl.rb to %TEMP%\icm_repl\ so ICMExchange.exe can load it from a short path.
REM Write ruby_path.txt alongside it so repl.rb can discover the target file.
set "TEMP_REPL_DIR=%TEMP%\icm_repl"
if not exist "!TEMP_REPL_DIR!" mkdir "!TEMP_REPL_DIR!"
copy /y "!REPL_DIR!repl.rb" "!TEMP_REPL_DIR!\repl.rb" >nul
echo !RUBY_FILE!> "!TEMP_REPL_DIR!\ruby_path.txt"

REM Use forward slashes so the exe's Ruby loader can find the script
set "REPL_RB=!TEMP_REPL_DIR!\repl.rb"
set "REPL_RB=!REPL_RB:\=/!"

if /i "!EXE_BASENAME!"=="IExchange.exe" (
    "!ICM_EXE!" "!REPL_RB!" ICM
) else (
    "!ICM_EXE!" "!REPL_RB!"
)
exit /b %ERRORLEVEL%
