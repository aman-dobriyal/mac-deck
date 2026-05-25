@echo off
:: Mac Deck — Windows launcher
:: Double-click this file (or add it to Startup) to run the Mac Deck server.
:: Requires Node.js to be installed (https://nodejs.org).
::
:: To auto-start at login:
::   1. Press Win+R, type:  shell:startup
::   2. Copy a shortcut to this .bat file into that folder.

setlocal

:: ── Find node ──────────────────────────────────────────────────────────────────
set "NODE="
for %%P in (node.exe) do set "NODE=%%~$PATH:P"
if "%NODE%"=="" (
  echo [Mac Deck] node.exe not found in PATH.
  echo Install Node.js from https://nodejs.org and re-run.
  pause
  exit /b 1
)

:: ── Resolve server.js relative to this .bat ────────────────────────────────────
set "BAT_DIR=%~dp0"
:: extras\start.bat lives one folder below server.js
set "SERVER=%BAT_DIR%..\server.js"
for %%F in ("%SERVER%") do set "SERVER=%%~fF"

if not exist "%SERVER%" (
  echo [Mac Deck] server.js not found at: %SERVER%
  pause
  exit /b 1
)

:: ── Check if already running on port 3333 ──────────────────────────────────────
netstat -ano | findstr ":3333 " >nul 2>&1
if %errorlevel%==0 (
  echo [Mac Deck] Already running on port 3333. Nothing to do.
  timeout /t 2 >nul
  exit /b 0
)

:: ── Start server (minimised console window) ────────────────────────────────────
echo [Mac Deck] Starting server...
echo [Mac Deck] Open http://localhost:3333 on your phone (same WiFi).
echo.
echo Press Ctrl+C to stop.
echo.

"%NODE%" "%SERVER%"
