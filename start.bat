@echo off
setlocal enableextensions enabledelayedexpansion
cd /d "%~dp0"

set "SHELL_DIR=%~dp0"
set "CHROME=%SHELL_DIR%vendor\chrome-win\chrome.exe"
set "PROFILE=%SHELL_DIR%profile"

if not exist "%CHROME%" (
  echo [LiveBrowser] Chromium not found.
  echo [LiveBrowser] Run download-chromium.ps1 first:
  echo     powershell -ExecutionPolicy Bypass -File "%~dp0download-chromium.ps1"
  pause
  exit /b 1
)

if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1

rem Suggestions and Yandex search go through serve.ps1 (CORS relay).
rem Start it in the background if it isn't already running, then wait
rem briefly for the port to open.
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0serve.ps1','-Port','8899' }"
timeout /t 2 /nobreak >nul

rem Isolated profile + no background Google traffic.  The profile is wiped on
rem every start: a stuck cache or session should never make the window come
rem up blank, and it holds nothing worth keeping between runs.
if exist "%PROFILE%" rmdir /s /q "%PROFILE%" >nul 2>&1

rem No --app on purpose.  An app window has no address bar, so a site that
rem ends up blank (framing/session/captcha) can't be escaped or inspected.
rem One address bar stays as an escape hatch; tabs still live in the shell.
"%CHROME%" ^
  --user-data-dir="%PROFILE%" ^
  "http://127.0.0.1:8899/index.html" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-background-networking ^
  --disable-component-update ^
  --disable-sync ^
  --disable-domain-reliability ^
  --disable-client-side-phishing-detection ^
  --disable-features=OptimizationHints,MediaRouter ^
  --no-service-autorun ^
  --password-store=basic ^
  --window-size=1280,900

endlocal
