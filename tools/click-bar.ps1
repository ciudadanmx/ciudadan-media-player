# Clic REAL de ratón sobre un botón de la barra flotante (no sintético):
# calcula la posición en pantalla del botón vía CDP, mueve el ratón y hace clic.
param(
  [int]$CdpPort = 9226,
  [string]$Button = 'play',
  [string]$AppDir = 'C:\yii\ciudadan-media-player'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static IntPtr FindPart(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
'@

# 1) rectángulo del botón en el DOM (vía CDP)
$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list"
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*yt-controls.html*' } | Select-Object -First 1
if (-not $page) { Write-Output 'no se encuentra la pagina de la barra'; exit 1 }
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).GetAwaiter().GetResult()
function Send-Cdp($id, $method, $params) {
  $msg = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $seg = New-Object ArraySegment[byte] (,$bytes)
  $ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
  $buf = New-Object byte[] 65536
  $out = ''
  do {
    $r = $ws.ReceiveAsync((New-Object ArraySegment[byte] (,$buf)), $ct).GetAwaiter().GetResult()
    $out += [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)
  } while (-not $r.EndOfMessage)
  return ($out | ConvertFrom-Json)
}
$expr = "(()=>{const b=document.getElementById('$Button');const r=b.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()"
$resp = Send-Cdp 1 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true }
$rect = $resp.result.result.value
Write-Output ('botón ' + $Button + ' en el DOM: ' + ($rect | ConvertTo-Json -Compress))

# 2) ventana de la barra y posición en pantalla
$ov = [Mouse]::FindPart('Controles YouTube')
if ($ov -eq [IntPtr]::Zero) { Write-Output 'no se encuentra la ventana de la barra'; exit 1 }
$ro = New-Object Mouse+RECT; [void][Mouse]::GetWindowRect($ov, [ref]$ro)
$sx = [int]($ro.Left + $rect.x + $rect.w / 2)
$sy = [int]($ro.Top + $rect.y + $rect.h / 2)
Write-Output ('barra en ' + $ro.Left + ',' + $ro.Top + '  ->  clic en ' + $sx + ',' + $sy)

# 3) ¿qué ventana recibe el clic en ese punto?
$hit = [Mouse]::WindowFromPoint((New-Object Mouse+POINT -Property @{ X = $sx; Y = $sy }))
Write-Output ('ventana bajo el cursor: "' + [Mouse]::TitleOf($hit) + '"')

# 4) clic real
[void][Mouse]::SetCursorPos($sx, $sy)
Start-Sleep -Milliseconds 400
[Mouse]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
Start-Sleep -Milliseconds 80
[Mouse]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
Write-Output 'clic enviado'
$ws.Dispose()
