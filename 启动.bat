@echo off
chcp 65001 >nul
title Sports Pose Coach - local server
cd /d "%~dp0"

rem ============================================================
rem  Sports Pose Coach / one-click launcher
rem  Why a local server instead of double-clicking the HTML:
rem    1) MediaPipe WASM is loaded via fetch, blocked under file://
rem    2) getUserMedia (camera) needs a secure context
rem  http://127.0.0.1 satisfies both.
rem ============================================================

if not exist "tools\serve.js" (
  echo.
  echo   [ERROR] tools\serve.js not found.
  echo   Please keep this .bat in the project root folder.
  echo.
  pause
  exit /b 1
)

set "NODE_EXE="

rem --- 1) node on PATH ---
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"

rem --- 2) node bundled with WorkBuddy ---
if not defined NODE_EXE (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if not defined NODE_EXE if exist "%%~fd\node.exe" set "NODE_EXE=%%~fd\node.exe"
  )
)

if not defined NODE_EXE goto :try_python

echo.
echo   Node.js : %NODE_EXE%
echo   Starting local server...
echo.

if /i "%NODE_EXE%"=="node" (
  node "tools\serve.js"
) else (
  "%NODE_EXE%" "tools\serve.js"
)
if errorlevel 1 goto :run_failed
goto :stopped

:try_python
where python >nul 2>nul
if errorlevel 1 goto :not_found
echo.
echo   [fallback] Node.js not found, using the Python server.
echo.
python "tools\serve.py"
if errorlevel 1 goto :run_failed
goto :stopped

:not_found
echo.
echo   [ERROR] Neither Node.js nor Python was found on this PC.
echo   Install Node.js 18+ from https://nodejs.org and run this file again.
echo.
pause
exit /b 1

:run_failed
echo.
echo   [ERROR] The local server exited with an error. See messages above.
echo   If the port is busy, close the other program and retry.
echo.
pause
exit /b 1

:stopped
echo.
echo   Server stopped.
pause
exit /b 0
