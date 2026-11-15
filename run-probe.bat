@echo off
rem Full headless self-check in one command: build, run LIVEBROWSER_PROBE=1,
rem report every SHELLPROBE line and fail if any of them is not green.
rem
rem No screenshots and no OS input: the probe works inside the shell page only
rem (the user asked for this after a screenshot once captured their private
rem chats).  Nothing here raises the window.
rem
rem Why the pre-flight step exists: a killed or crashed instance leaves the
rem profile locked, and the next start then fails with 0x800700AA.  The browser
rem clears a *stale* lock itself now, but a still-running instance is a real
rem conflict, so it is stopped here — this script only ever kills the copy in
rem dist\ that it is about to run.
setlocal enableextensions enabledelayedexpansion
cd /d "%~dp0"

set "EXE=%~dp0dist\LiveBrowser.exe"
set "LOG=%~dp0dist\debug.log"
set "TIMEOUT_S=240"

if not exist "%EXE%" (
  echo [probe] dist\LiveBrowser.exe not found - run build.bat first.
  exit /b 1
)

rem --- pre-flight: no leftover instance may hold the profile -----------------
rem Every utility is called from System32 by full path: Git Bash puts its own
rem POSIX find/findstr/tasklist first on PATH, and those reject Windows flags.
set "SYS=%SystemRoot%\System32"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%SYS%\tasklist.exe" /FI "IMAGENAME eq LiveBrowser.exe" 2>nul | "%SYS%\findstr.exe" /C:"LiveBrowser.exe" >nul
if not errorlevel 1 (
  echo [probe] stopping a leftover LiveBrowser instance...
  "%SYS%\taskkill.exe" /IM LiveBrowser.exe /F >nul 2>&1
  rem Give the runtime a moment to release the profile and its child processes.
  ping -n 4 127.0.0.1 >nul
)

rem The log is started fresh every run: the report below reads the whole file,
rem and a stale "SHELLPROBE1 start" with no answer (a run cut short) would keep
rem the past verdicts of another boot in the same file.
del /q "%LOG%" >nul 2>&1
rem A crash marker from a run that was killed must not turn the next start into
rem the "restore tabs?" dialog: the probe would then accept the dialog and its
rem two boots would take turns answering, neither reaching the marker.
if exist "%~dp0dist\crash.flag" del /q "%~dp0dist\crash.flag" >nul 2>&1
rem A private profile left by a killed run would make the private step's
rem "folder started empty / was wiped" checks meaningless.
if exist "%~dp0dist\profile-private" rmdir /s /q "%~dp0dist\profile-private" >nul 2>&1

rem --- run -------------------------------------------------------------------
rem No "start /wait": the probe never closes its own window (it stays headless
rem and quiet), so /wait would block this script forever and the report below
rem would never run.  Launch in the background and bound the run by the marker.
echo [probe] running headless self-check (up to %TIMEOUT_S%s)...
set "LIVEBROWSER_PROBE=1"
start "" /b "%EXE%"

rem Wait for "SHELLPROBE done" (the last line the probe writes), then stop the
rem process: the browser itself would otherwise sit open indefinitely.
set /a WAITED=0
:waitdone
if %WAITED% GEQ %TIMEOUT_S% goto :timeout
if not exist "%LOG%" (
  ping -n 2 127.0.0.1 >nul
  set /a WAITED+=1
  goto :waitdone
)
rem %SYS%\findstr.exe is spelled out on purpose: Git Bash ships its own
rem find/findstr ahead of System32 on PATH, and those are POSIX tools that
rem answer "no such file" to /I instead of searching the log.
"%SYS%\findstr.exe" /C:"SHELLPROBE done" "%LOG%" >nul 2>&1
if errorlevel 1 (
  ping -n 2 127.0.0.1 >nul
  set /a WAITED+=1
  goto :waitdone
)
rem Give the writer a beat so the report sees every line.
ping -n 2 127.0.0.1 >nul
"%SYS%\taskkill.exe" /IM LiveBrowser.exe /F >nul 2>&1

rem --- report ----------------------------------------------------------------
echo.
echo [probe] results:
"%SYS%\findstr.exe" /C:"SHELLPROBE" "%LOG%"
echo.

rem A line is red when it says "failed", or when it carries a skip.  Verdicts
rem are checked per step below, on the step's own line: a bare "same":false
rem cannot be a pattern here (findstr reads the \" as a quote and then takes
rem the rest for a file name), and the payloads are escaped differently in a
rem quoted JSON field ("same\\":false), so a grep for it is blind by design.
rem Declared verdicts that print a number (total=N, tabs/slept) are anchored
rem so ":20" and ":0.5" do not read as zero.  Every pattern goes through /C:
rem (literal): with /R a quoted comma inside a command line is split by
rem cmd.exe and the pattern is truncated.
set "RED=0"
"%SYS%\findstr.exe" /C:"SHELLPROBE" "%LOG%" | "%SYS%\findstr.exe" /C:"failed" /C:"\"skip\"" >nul 2>&1
if not errorlevel 1 set "RED=1"
"%SYS%\findstr.exe" /C:"SHELLPROBE errcard" "%LOG%" | "%SYS%\findstr.exe" /C:"\"card\":false" >nul 2>&1
if not errorlevel 1 set "RED=1"
"%SYS%\findstr.exe" /R /C:"\"total\":1[,}]" /C:"\"total\":2[,}]" "%LOG%" >nul 2>&1
if not errorlevel 1 set "RED=1"
"%SYS%\findstr.exe" /C:"SHELLPROBE stress" "%LOG%" | "%SYS%\findstr.exe" /C:"\"tabs\":0," /C:"\"slept\":0," >nul 2>&1
if not errorlevel 1 set "RED=1"
rem adblock: a wrong match (matchBad non-empty), a blocked count of zero or a
rem page that never reported its state means the filter is not wired, not that
rem the blocklist is short.  Checked with powershell, like private below: these
rem verdicts contain closing quotes and a colon, and findstr cannot take such a
rem pattern through cmd's quoting -- it opened "\matchBad" as a directory and
rem printed "The directory name is invalid." on every run.
"%PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\adblock-probe.ps1" "%LOG%"
if errorlevel 1 set "RED=1"
rem intro: the first-run film has to be internally consistent before it is
rem allowed to ship -- frames a pure function of t, exactly one prism peak,
rem a settled last frame.  The step turns each of those into a field and the
rem line is red when any of them is false; the Hz number is reported, not
rem enforced (a busy CI box is not a reason to fail the film).
"%SYS%\findstr.exe" /C:"SHELLPROBE intro " "%LOG%" | "%SYS%\findstr.exe" /C:"\"pure\":false" /C:"\"finite\":false" /C:"\"settled\":false" /C:"\"shown\":false" /C:"\"hidden\":true" >nul 2>&1
if not errorlevel 1 set "RED=1"
rem vtabs: the column has to move the site, stack the tabs in the shell and
rem put the old geometry back.  The step itself turns every bad number into a
rem "failed" field and is green without one, and this rule only has to say the
rem step ran at all -- the line is already printed above, and the pattern is a
rem bare word so no quoting can swallow it.
"%SYS%\findstr.exe" /C:"SHELLPROBE vtabs" "%LOG%" >nul 2>&1
if errorlevel 1 set "RED=1"
rem private: the marker must carry its verdicts as true.  findstr is not
rem usable for this: these patterns contain \ " : which it cannot take through
rem cmd's quoting (it ends up opening "\chipShown" as a file), and a bare
rem "chipShown":true is a regex whose * repeats the preceding 'n'.  So the
rem verdicts are checked with powershell, which reads the file itself: the
rem line must be there and none of its verdicts may be false.
rem The checker lives in tools\ and the log path is passed as an argument: a
rem generated one-liner would have to quote the path inside the script, and
rem that needs escapes that are easy to get wrong.
rem Private runs do not start a probe round of their own (MainForm.Chrome.cs),
rem so a round that starts and never answers can only be a torn-down page.
"%PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\private-probe.ps1" "%LOG%"
if errorlevel 1 set "RED=1"
rem Every round that started must also have answered.  The shell asks for a
rem round when it reports "ready"; a round that starts and never answers means
rem its page was torn down mid-check (a disposed view answers "failed" on the
rem next lines), which is a real loss of the check, not a quiet pass.
rem Counted with powershell: the two for /f counters that stood here lost the
rem tail of "%SYS%\findstr.exe" and "%SYS%\find.exe" inside their single
rem quotes, so both counts came out empty and the comparison passed on empty.
"%PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\rounds-probe.ps1" "%LOG%"
if errorlevel 1 set "RED=1"

"%SYS%\findstr.exe" /C:"SHELLPROBE done" "%LOG%" >nul 2>&1
if errorlevel 1 (
  echo [probe] FAIL: the run did not reach the end marker.
  exit /b 1
)
if "%RED%"=="1" (
  echo [probe] FAIL: see the red lines above.
  exit /b 1
)
rem A line that carries an "error" payload.  This is the last findstr rule that
rem took a quoted-with-colon pattern: cmd handed its `\"error\"` on as a bare
rem `\error` directory to both findstr calls and each printed "The directory
rem name is invalid."  A word without a quote or a colon needs no escaping, so
rem the pattern is the bare `error` and the JSON quotes around it do the
rem narrowing: no other field on these lines is spelled that way.
"%SYS%\findstr.exe" /C:"SHELLPROBE" "%LOG%" | "%SYS%\findstr.exe" /C:"error" >nul 2>&1
if not errorlevel 1 (
  echo [probe] FAIL: a step reported an error payload.
  exit /b 1
)

rem A leftover crash.flag means the previous session ended by force.  The
rem probe itself is stopped with taskkill, so the flag it writes is expected;
rem only its presence after a run that never reached the marker is a signal,
rem which the marker check above already covers.
echo [probe] PASS
exit /b 0

:timeout
echo [probe] FAIL: no "SHELLPROBE done" after %TIMEOUT_S%s.
"%SYS%\taskkill.exe" /IM LiveBrowser.exe /F >nul 2>&1
exit /b 1
