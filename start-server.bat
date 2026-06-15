@echo off
title Obsidian Research — Starting...
color 0A

echo.
echo  ================================================
echo   OBSIDIAN RESEARCH ASSISTANT
echo  ================================================
echo.

:: Change to the directory where this .bat file lives
cd /d "%~dp0"

:: Check Node is installed
where node >nul 2>&1
if errorlevel 1 (
  color 0C
  echo  [ERROR] Node.js is not installed or not on PATH.
  echo  Download it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  Node.js : %NODE_VER%

:: Check chatbot-server directory exists
if not exist "chatbot-server" (
  color 0C
  echo  [ERROR] chatbot-server directory not found.
  echo.
  pause
  exit /b 1
)

:: Install backend dependencies if needed
if not exist "chatbot-server\node_modules" (
  echo.
  echo  [SETUP] Installing backend dependencies (first run only)...
  pushd chatbot-server
  npm install
  if errorlevel 1 (
    color 0C
    echo  [ERROR] npm install failed.
    popd
    pause
    exit /b 1
  )
  popd
  echo  [OK] Dependencies installed.
)

:: Create required directories
if not exist "chatbot-server\uploads" mkdir chatbot-server\uploads
if not exist "chatbot-server\data"    mkdir chatbot-server\data

echo.
echo  Starting servers...
echo.

:: ── Start backend API server (port 3001) in its own window ──
start "Obsidian API Server :3001" /min cmd /k "cd /d "%~dp0chatbot-server" && color 0B && node server.js"

:: Wait 1 second then start frontend server
timeout /t 1 /nobreak >nul

:: ── Start frontend static server (port 8080) in its own window ──
start "Obsidian Frontend :8080" /min cmd /k "cd /d "%~dp0" && color 0E && node serve.js"

:: Wait for both to start
timeout /t 2 /nobreak >nul

echo.
echo  ================================================
echo   Both servers are running!
echo.
echo   Frontend : http://localhost:8080
echo   Chatbot  : http://localhost:8080/chatbot.html
echo   API      : http://localhost:3001
echo   Health   : http://localhost:3001/api/chat/health
echo   Diagnose : http://localhost:8080/upload-test.html
echo  ================================================
echo.

:: Open the app in default browser
start "" "http://localhost:8080/chatbot.html"

echo  Press any key to stop both servers...
pause >nul

:: Kill both Node processes on port 8080 and 3001
echo  Stopping servers...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8080 " ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3001 " ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo  Done. You can close this window.
pause
