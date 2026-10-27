@echo off
title TENSORA Launcher

rem Double-click this file to start the local server with the bundled Node.js.
rem Keep this batch file ASCII-only so cmd.exe handles every Windows code page.
cd /d "%~dp0"

set "LOG_FILE=%~dp0launcher.log"
set "BUNDLED_NODE=%~dp0node-v24.21.0-win-x64\node.exe"
echo [%date% %time%] Starting TENSORA launcher... > "%LOG_FILE%"

if exist "%BUNDLED_NODE%" goto node_found
echo Bundled Node.js was not found: >> "%LOG_FILE%"
echo %BUNDLED_NODE% >> "%LOG_FILE%"
echo Bundled Node.js is missing.
echo Keep the node-v24.21.0-win-x64 folder next to this launcher.
pause
exit /b 1

:node_found
"%BUNDLED_NODE%" --version >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto node_failed
echo Starting local server...
echo The browser should open automatically.
echo Do not open index.html directly.
echo Close this window to stop the local server.
echo.

"%BUNDLED_NODE%" "%~dp0server.js" 1>> "%LOG_FILE%" 2>>&1

echo.
echo Local server stopped. Details were written to:
echo %LOG_FILE%
pause
exit /b 0

:node_failed
echo Bundled Node.js could not start.
echo This package requires 64-bit Windows. See launcher.log for details.
pause
exit /b 1
