# Captura directa de la BARRA flotante vía CDP (no depende de lo que haya en pantalla)
# y composición sobre fondo oscuro, en tres estados: barra, lista y modal.
param(
  [int]$CdpPort = 9226,
  [string]$Dir = 'C:\yii\ciudadan-media-player\logs'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list"
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*yt-controls.html*' } | Select-Object -First 1
if (-not $page) { Write-Output 'no se encuentra la pagina de la barra'; exit 1 }
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).GetAwaiter().GetResult()
$script:cid = 0
function Send-Cdp($method, $params) {
  $script:cid++
  $msg = @{ id = $script:cid; method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync((New-Object ArraySegment[byte] (,$bytes)), [Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult() | Out-Null
  $buf = New-Object byte[] 1048576; $out = ''
  do { $r = $ws.ReceiveAsync((New-Object ArraySegment[byte] (,$buf)), $ct).GetAwaiter().GetResult()
       $out += [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count) } while (-not $r.EndOfMessage)
  return ($out | ConvertFrom-Json)
}
function Eval($expr) {
  $r = Send-Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true }
  return $r.result.result.value
}
function Shot($name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  $png = [Convert]::FromBase64String($r.result.data)
  $tmp = [IO.Path]::GetTempFileName() + '.png'
  [IO.File]::WriteAllBytes($tmp, $png)
  $src = [System.Drawing.Bitmap]::FromFile($tmp)
  $dst = New-Object System.Drawing.Bitmap $src.Width, $src.Height
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 18, 18, 22))
  $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
  $g.Dispose(); $src.Dispose()
  $out = Join-Path $Dir $name
  $dst.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $dst.Dispose()
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Write-Output ('captura: ' + $out)
}

$size = Eval "[innerWidth,innerHeight]"
Write-Output ('overlay: ' + ($size -join 'x'))

# 1) barra visible (sin auto-ocultado)
[void](Eval "document.body.classList.remove('hidden','showPlaylist','showModal'); true")
Start-Sleep -Milliseconds 400
Shot 'ui-bar.png'

# 2) lista lateral abierta
[void](Eval "document.getElementById('plToggle').click(); document.body.classList.remove('hidden'); true")
Start-Sleep -Milliseconds 400
Shot 'ui-lista.png'
[void](Eval "document.getElementById('plClose').click(); true")

# 3) modal de busqueda
[void](Eval "document.getElementById('search').click(); document.getElementById('modalInput').value='https://www.youtube.com/watch?v=aqz-KE-bpKQ'; document.body.classList.remove('hidden'); true")
Start-Sleep -Milliseconds 400
Shot 'ui-modal.png'
$ws.Dispose()
