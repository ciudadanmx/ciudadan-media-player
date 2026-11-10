# Capturas de la nueva barra: con la lista lateral abierta y con el modal de búsqueda.
param(
  [int]$CdpPort = 9226,
  [string]$Dir = 'C:\yii\ciudadan-media-player\logs'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Snap {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static IntPtr FindPart(string part) {
    IntPtr found = IntPtr.Zero; int best = 0;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) {
        RECT r; GetWindowRect(h, out r); int a = (r.Right-r.Left)*(r.Bottom-r.Top);
        if (a > best) { best = a; found = h; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list"
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*yt-controls.html*' } | Select-Object -First 1
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).GetAwaiter().GetResult()
$script:cid = 0
function Send-Cdp($method, $params) {
  $script:cid++
  $msg = @{ id = $script:cid; method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync((New-Object ArraySegment[byte] (,$bytes)), [Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult() | Out-Null
  $buf = New-Object byte[] 65536; $out = ''
  do { $r = $ws.ReceiveAsync((New-Object ArraySegment[byte] (,$buf)), $ct).GetAwaiter().GetResult()
       $out += [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count) } while (-not $r.EndOfMessage)
  return ($out | ConvertTo-Json -Depth 8 -Compress)
}
function Eval($expr) {
  $r = Send-Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true } | ConvertFrom-Json
  return $r.result.result.value
}

$hwnd = [Snap]::FindPart('Ciudadan Media Player')
$r = New-Object Snap+RECT; [void][Snap]::GetWindowRect($hwnd, [ref]$r)
Write-Output ('ventana de video: ' + $r.Left + ',' + $r.Top + ' ' + ($r.Right-$r.Left) + 'x' + ($r.Bottom-$r.Top))
# la ventana de video al frente para que la captura muestre el video real
# (truco ALT + BringWindowToTop para vencer el bloqueo de foreground de Windows)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('%')
Start-Sleep -Milliseconds 300
[void][Snap]::ShowWindow($hwnd, 9)
[void][Snap]::BringWindowToTop($hwnd)
[void][Snap]::SetForegroundWindow($hwnd)
Start-Sleep -Seconds 2
Write-Output ('primer plano: "' + [Snap]::TitleOf([Snap]::GetForegroundWindow()) + '"')

function Shot($file) {
  $bmp = New-Object System.Drawing.Bitmap ($r.Right-$r.Left), ($r.Bottom-$r.Top)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $g.Dispose(); $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output ('captura: ' + $file)
}

# el raton sobre la barra para que se vea
function Wake-Bar {
  [void][Snap]::SetCursorPos([int]($r.Left + 400), [int]($r.Top + ($r.Bottom-$r.Top) - 40))
}

# 0) cerrar panel y modal que quedaran abiertos de una captura anterior
[void](Eval "document.getElementById('plClose').click(); document.getElementById('modalCancel').click(); document.body.classList.remove('showModal','showPlaylist'); true")
Start-Sleep -Milliseconds 400

# 1) barra normal: mover el raton y capturar enseguida (si no, se auto-oculta)
Wake-Bar
Start-Sleep -Milliseconds 500
Shot (Join-Path $Dir 'yt-bar-new.png')

# 2) con la lista lateral abierta
[void](Eval "document.getElementById('plToggle').click(); true")
Wake-Bar
Start-Sleep -Milliseconds 400
Shot (Join-Path $Dir 'yt-lista.png')
[void](Eval "document.getElementById('plClose').click(); true")

# 3) con el modal de busqueda abierto
[void](Eval "document.getElementById('search').click(); document.getElementById('modalInput').value='https://www.youtube.com/watch?v=aqz-KE-bpKQ'; true")
Wake-Bar
Start-Sleep -Milliseconds 400
Shot (Join-Path $Dir 'yt-modal.png')
$ws.Dispose()
