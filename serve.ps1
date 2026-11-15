 <#
.SYNOPSIS
  Serves shell\ on http://127.0.0.1:<Port>/ for the in-app browser.

.DESCRIPTION
  Minimal static file server. Browsers refuse cross-origin fetches from
  file://, so the Yandex suggest/search requests need http.

  Yandex's suggest endpoint sends no CORS headers, so the page asks for
  /suggest?part=... and this script relays the request to
  suggest.yandex.ru (same-origin for the page, so no CORS at all).
  Everything else is read from shell\.

  -Port <n>  Listening port (default 8899).
#>
param(
  [int]$Port = 8899
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shell'))
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "[LiveBrowser] Serving $root on http://127.0.0.1:$Port/"

function Send-Json($ctx, [string]$json, [int]$status = 200) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $ctx.Response.StatusCode = $status
  $ctx.Response.ContentType = 'application/json; charset=utf-8'
  $ctx.Response.Headers.Add('Cache-Control', 'no-store')
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Suggest($ctx) {
  # Decode the query from RawUrl byte-wise: HttpListener decodes QueryString,
  # and this console's UTF-8/ANSI encodings are unreliable, so let .NET hand
  # us the raw percent-encoded bytes and turn them into a proper string.
  $raw = $ctx.Request.RawUrl
  $part = ''
  $m = [regex]::Match($raw, '[?&]part=([^&]*)')
  if ($m.Success) {
    $pct = $m.Groups[1].Value.Replace('+', '%20').Replace('*', '%2A')
    $part = ConvertFrom-PercentEncoding $pct
  }
  if ([string]::IsNullOrWhiteSpace($part)) { return Send-Json $ctx '[""]' }
  try {
    $uri = 'https://suggest.yandex.ru/suggest-ff.cgi?uil=ru&v=4&n=10&srv=browser&part=' +
      (ConvertTo-PercentEncoding $part)
    $wc = New-Object Net.WebClient
    $bytes = $wc.DownloadData($uri)
    Send-Body $ctx $bytes
  } catch {
    Write-Host "[LiveBrowser] suggest failed: $($_.Exception.Message)"
    Send-Json $ctx '{"error":"suggest unavailable"}' 502
  }
}

# %D0%BF... -> the original string, decoded as UTF-8 by hand.
function ConvertFrom-PercentEncoding([string]$s) {
  $sb = New-Object Text.StringBuilder
  $list = New-Object 'System.Collections.Generic.List[byte]'
  for ($i = 0; $i -lt $s.Length; $i++) {
    if ($s[$i] -eq '%' -and $i + 2 -lt $s.Length) {
      $list.Add([Convert]::ToByte($s.Substring($i + 1, 2), 16))
      $i += 2
    } else {
      $list.Add([byte][char]$s[$i])
    }
  }
  $b = $list.ToArray()
  $i = 0
  while ($i -lt $b.Length) {
    $c0 = [int]$b[$i]
    if ($c0 -lt 0x80) {
      [void]$sb.Append([char]$c0)
      $i++
    } elseif ($c0 -lt 0xE0 -and ($i + 1) -lt $b.Length) {
      $c1 = [int]$b[$i + 1]
      $cp = ((0x1F -band $c0) -shl 6) -bor (0x3F -band $c1)
      [void]$sb.Append([char]$cp)
      $i += 2
    } elseif ($c0 -lt 0xF0 -and ($i + 2) -lt $b.Length) {
      $c1 = [int]$b[$i + 1]
      $c2 = [int]$b[$i + 2]
      $cp = ((0x0F -band $c0) -shl 12) -bor ((0x3F -band $c1) -shl 6) -bor (0x3F -band $c2)
      [void]$sb.Append([char]$cp)
      $i += 3
    } else {
      [void]$sb.Append([char]0xFFFD)
      $i++
    }
  }
  return $sb.ToString()
}

# UTF-16 string -> %XX%XX... using explicit UTF-8 byte computation.
function ConvertTo-PercentEncoding([string]$s) {
  $sb = New-Object Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    $cp = [int]$ch
    if ($cp -lt 0x80) {
      [void]$sb.Append(('%{0:X2}' -f $cp))
    } elseif ($cp -lt 0x800) {
      $b1 = 0xC0 -bor ($cp -shr 6)
      $b2 = 0x80 -bor ($cp -band 0x3F)
      [void]$sb.Append(('%{0:X2}%{1:X2}' -f $b1, $b2))
    } else {
      $b1 = 0xE0 -bor ($cp -shr 12)
      $b2 = 0x80 -bor (($cp -shr 6) -band 0x3F)
      $b3 = 0x80 -bor ($cp -band 0x3F)
      [void]$sb.Append(('%{0:X2}%{1:X2}%{2:X2}' -f $b1, $b2, $b3))
    }
  }
  return $sb.ToString()
}

function Send-Body($ctx, [byte[]]$bytes, [int]$status = 200) {
  $ctx.Response.StatusCode = $status
  $ctx.Response.ContentType = 'application/json; charset=utf-8'
  $ctx.Response.Headers.Add('Cache-Control', 'no-store')
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    if ($ctx.Request.Url.AbsolutePath -eq '/suggest') {
      Send-Suggest $ctx
    } else {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }
      $path = [IO.Path]::GetFullPath((Join-Path $root $rel))

      if ($path.StartsWith($root) -and (Test-Path $path -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($path)
        $ext = [IO.Path]::GetExtension($path).ToLowerInvariant()
        $ctx.Response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
        $ctx.Response.Headers.Add('Cache-Control', 'no-store')
        # The shell holds every site in an iframe.  Without a frame-ancestors
        # allowance any CSP this page picked up makes Chrome render a blank
        # white frame with no error the page can detect, so state it here.
        $ctx.Response.Headers.Add('Content-Security-Policy', "frame-ancestors 'self'")
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ctx.Response.StatusCode = 404
      }
    }
  } catch {
    Write-Host "[LiveBrowser] request failed: $($_.Exception.Message)"
  } finally {
    $ctx.Response.Close()
  }
}
