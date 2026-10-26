@echo off
rem Luma Clinic - double-click to start (demo build).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22 or newer from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies for the first time...
  call npm install
  if errorlevel 1 (
    echo npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo Starting Luma Clinic. Keep this window open while you use the app; close it to stop.
start "" cmd /c "timeout /t 8 /nobreak >nul && start http://127.0.0.1:5173"
call npm run dev
pause
