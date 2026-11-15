@echo off
rem Build + assemble the portable LiveBrowser folder into dist\.
rem Uses the private .NET SDK in build\dotnet-sdk (no system-wide install).
setlocal
cd /d "%~dp0"
set "DOTNET=%~dp0build\dotnet-sdk\dotnet.exe"

"%DOTNET%" publish host\LiveBrowser.csproj -c Release -r win-x64 --self-contained true ^
  -p:PublishSingleFile=false -o build\self || goto :fail

rem Old dist steps aside instead of being deleted: theme.json, settings.json,
rem session.json, window.json, downloads.json and the WebView2 profile are the
rem user's browser state, and a rebuild used to wipe all of it.
if exist dist.old rmdir /s /q dist.old
if exist dist move dist dist.old
mkdir dist
xcopy /e /i /q /y build\self dist >nul
rmdir /s /q dist\shell 2>nul
xcopy /e /i /q /y shell dist\shell >nul
for %%f in (theme.json settings.json session.json window.json downloads.json) do (
  if exist dist.old\%%f copy /y dist.old\%%f dist\%%f >nul
)
if exist dist.old\profile move dist.old\profile dist\profile
rmdir /s /q dist.old
rem Tall fixture for the LIVEBROWSER_SELFTEST smooth-scroll probe.  Rebuilt on
rem every build on purpose: "rmdir /s /q dist" above used to wipe it, and the
rem scroll check then degraded to "no test page" without anyone noticing.
mkdir dist\_sc 2>nul
copy /y test\sc.html dist\_sc\index.html >nul
rem Heavy fixture for the SHELLPROBE stress step (20 tabs, RAM/CPU).  Local on
rem purpose: the measurement must not depend on the user's connection.
mkdir dist\_heavy 2>nul
copy /y test\heavy.html dist\_heavy\index.html >nul
rem Ad-block fixture for SHELLPROBE adblock: a page asking a blocked host, so
rem the probe can tell "filter works" from "page had nothing to block".
mkdir dist\_ads 2>nul
copy /y test\ad.html dist\_ads\index.html >nul
echo.
echo [LiveBrowser] Ready: %~dp0dist\LiveBrowser.exe
exit /b 0

:fail
echo [LiveBrowser] Build failed.
exit /b 1
