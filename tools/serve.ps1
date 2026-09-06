# Local preview server.
#
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1
#   then open http://localhost:8123/
#
# The app cannot be opened straight off disk: ES modules and service workers
# both need a real HTTP origin. This exists so you can preview a change without
# installing Node or Python. Ctrl+C to stop.

param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 8123
)

$ErrorActionPreference = 'Stop'

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
  '.txt'  = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "serving $Root on http://localhost:$Port/"

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response

    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($rel -eq '/') { $rel = '/index.html' }
    $rel = $rel.TrimStart('/')

    $path = Join-Path $Root $rel
    $full = [System.IO.Path]::GetFullPath($path)

    if (-not $full.StartsWith([System.IO.Path]::GetFullPath($Root))) {
      $res.StatusCode = 403
      $res.Close()
      continue
    }

    if (Test-Path -LiteralPath $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $type = $mime[$ext]
      if (-not $type) { $type = 'application/octet-stream' }

      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.ContentType = $type
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.Headers.Add('Service-Worker-Allowed', '/')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.StatusCode = 200
      Write-Output "200 $rel"
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes('not found')
      $res.OutputStream.Write($msg, 0, $msg.Length)
      Write-Output "404 $rel"
    }

    $res.Close()
  } catch {
    Write-Output "error: $($_.Exception.Message)"
  }
}
