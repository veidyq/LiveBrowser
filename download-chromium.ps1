<#
.SYNOPSIS
  Downloads a portable Chromium snapshot for LiveBrowser.

.DESCRIPTION
  Fetches the latest Win_x64 Chromium build from the official
  chromium-browser-snapshots bucket into vendor\, then extracts it.
  Idempotent: skips the download if chrome.exe is already present.

  -Version <n>  Download a specific revision instead of the latest.
  -Force        Re-download even if chrome.exe exists.
#>
param(
  [int]$Version = 0,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $root 'vendor'
$chromeExe = Join-Path $vendor 'chrome-win\chrome.exe'
$zipPath = Join-Path $vendor 'chromium-win.zip'

if ((Test-Path $chromeExe) -and -not $Force) {
  Write-Host "[LiveBrowser] Chromium already installed: $chromeExe" -ForegroundColor Green
  exit 0
}

New-Item -ItemType Directory -Force -Path $vendor | Out-Null

if ($Version -le 0) {
  Write-Host '[LiveBrowser] Resolving latest Win_x64 revision...'
  $revUrl = 'https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Win_x64%2FLAST_CHANGE?alt=media'
  $Version = [int](Invoke-RestMethod -Uri $revUrl)
}

Write-Host "[LiveBrowser] Downloading Chromium revision $Version (~360 MB)..."
$zipUrl = "https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Win_x64%2F$Version%2Fchrome-win.zip?alt=media"
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

if ((Get-Item $zipPath).Length -lt 50MB) {
  throw "Downloaded archive looks truncated ($((Get-Item $zipPath).Length) bytes)."
}

Write-Host '[LiveBrowser] Extracting...'
Expand-Archive -Path $zipPath -DestinationPath $vendor -Force
Remove-Item $zipPath -Force

if (-not (Test-Path $chromeExe)) {
  throw "Extraction finished but $chromeExe is missing."
}

Write-Host "[LiveBrowser] Ready: $chromeExe" -ForegroundColor Green
