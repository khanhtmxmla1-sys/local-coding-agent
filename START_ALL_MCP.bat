@echo off
setlocal
title Starter - Full Master MCP Suite QuizPro v5.0.0
color 0A

set "LCA_DIR=C:\Users\Administrator\Desktop\ide\local-coding-agent"
set "GEOGEBRA_DIR=C:\Users\Administrator\Desktop\ide\geogebra-mcp"
set "PANDOC_DIR=C:\Users\Administrator\Desktop\ide\mcp-pandoc"
set "UNSPLASH_DIR=C:\Users\Administrator\Desktop\ide\unsplash-mcp"
set "LATEX_DIR=C:\Users\Administrator\Desktop\ide\latex-mcp"
set "WORKSPACE=C:\quizpro"
set "NGROK_EXE=C:\Users\Administrator\Desktop\ide\ngrok.exe"
set "MCP_PROXY_REQUIRE_AUTH=1"
set "MCP_FILESYSTEM_ROOT=%WORKSPACE%"

echo =========================================================================
echo       STARTING FULL MASTER MCP SUITE QUIZPRO v5.0.0
echo =========================================================================
echo.

echo [1/10] Cleaning up previous QuizPro MCP processes...
taskkill /f /fi "WINDOWTITLE eq Local Coding Agent QuizPro*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq MCP Reverse Proxy QuizPro*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq GeoGebra MCP Server*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq Pandoc MCP Server*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq Unsplash MCP Server*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq LaTeX MCP Server*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq Ngrok Tunnel QuizPro*" >nul 2>&1
taskkill /f /im ngrok.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/10] Checking workspace directory...
if not exist "%WORKSPACE%" mkdir "%WORKSPACE%"

echo [3/10] Starting GeoGebra MCP Server...
if exist "%GEOGEBRA_DIR%" start "GeoGebra MCP Server" cmd /k "cd /d %GEOGEBRA_DIR% && title GeoGebra MCP Server && node src/index.js"

echo [4/10] Starting Pandoc MCP Server...
if exist "%PANDOC_DIR%" start "Pandoc MCP Server" cmd /k "cd /d %PANDOC_DIR% && title Pandoc MCP Server && python -m mcp_pandoc"

echo [5/10] Starting Unsplash MCP Server...
if exist "%UNSPLASH_DIR%" start "Unsplash MCP Server" cmd /k "cd /d %UNSPLASH_DIR% && title Unsplash MCP Server && python server.py"

echo [6/10] Starting LaTeX and OCR MCP Server...
if exist "%LATEX_DIR%" start "LaTeX MCP Server" cmd /k "cd /d %LATEX_DIR% && title LaTeX MCP Server && python latex_server.py"

echo [7/10] Starting Local Coding Agent v5.0.0 on port 8787...
start "Local Coding Agent QuizPro" cmd /k "cd /d %LCA_DIR% && set NODE_OPTIONS=--max-old-space-size=4096 && set AGENT_POLICY=full && set AGENT_MODE=full && set PORT=8787 && set DASHBOARD_PORT=8790 && set AGENT_WORKSPACE=%WORKSPACE% && node scripts\local-coding-agent.mjs start --no-tunnel --mode full --policy full --workspace %WORKSPACE%"

timeout /t 5 /nobreak >nul
powershell -NoProfile -Command "try { $h = Invoke-RestMethod 'http://127.0.0.1:8787/healthz' -TimeoutSec 5; if ($h.status -ne 'ok') { exit 1 }; Write-Host '[OK] Local Coding Agent' $h.version '- MCP:' $h.mcp_endpoint -ForegroundColor Green } catch { Write-Host '[ERROR] Local Coding Agent is OFFLINE' -ForegroundColor Red; exit 1 }"
if errorlevel 1 goto :fail

echo [8/10] Starting hardened MCP Reverse Proxy on port 8000...
start "MCP Reverse Proxy QuizPro" cmd /k "cd /d %LCA_DIR% && node scripts\mcp-reverse-proxy.cjs"
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$t = Test-NetConnection -ComputerName 127.0.0.1 -Port 8000 -WarningAction SilentlyContinue; if (-not $t.TcpTestSucceeded) { Write-Host '[ERROR] MCP Reverse Proxy is OFFLINE on port 8000' -ForegroundColor Red; exit 1 }; Write-Host '[OK] MCP Reverse Proxy listening on 127.0.0.1:8000' -ForegroundColor Green"
if errorlevel 1 goto :fail

echo [9/10] Checking ngrok executable...
if not exist "%NGROK_EXE%" (
    echo [ERROR] ngrok.exe not found at %NGROK_EXE%
    goto :fail
)

echo [10/10] Starting Ngrok tunnel to MCP Reverse Proxy port 8000...
start "Ngrok Tunnel QuizPro" cmd /k "cd /d C:\Users\Administrator\Desktop\ide && ngrok.exe http 8000 --url polka-unpaved-contest.ngrok-free.dev"

timeout /t 3 /nobreak >nul

echo.
echo =========================================================================
echo                  FULL MASTER QUIZPRO MCP SUITE STARTED
echo =========================================================================
echo Local Coding Agent: http://127.0.0.1:8787/mcp
echo Dashboard:          http://127.0.0.1:8790/ui
echo Local Proxy:        http://127.0.0.1:8000/mcp
echo Public MCP:         https://polka-unpaved-contest.ngrok-free.dev/mcp
echo GitNexus SSE:       https://polka-unpaved-contest.ngrok-free.dev/gitnexus/sse
echo Filesystem SSE:     https://polka-unpaved-contest.ngrok-free.dev/filesystem/sse
echo Filesystem root:    %WORKSPACE%
echo.
echo SECURITY: MCP Reverse Proxy uses Bearer authentication by default.
echo           Do not set MCP_PROXY_REQUIRE_AUTH=0 on a public tunnel.
echo =========================================================================
echo.
pause
exit /b 0

:fail
color 0C
echo.
echo [ERROR] MCP suite startup failed. Ngrok was not started or should be stopped.
pause
exit /b 1
