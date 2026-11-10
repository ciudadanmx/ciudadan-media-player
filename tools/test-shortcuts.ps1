# Prueba de los atajos tipo YouTube con el vídeo enfocado:
# envía teclas reales (SendKeys) y comprueba el estado del motor vía API.
param(
  [int]$ApiPort = 17890,
  [string]$Token = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static IntPtr Video() {
    IntPtr found = IntPtr.Zero; int best = 0;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString() == "Ciudadan Media Player") { int area = GetArea(h); if (area > best) { best = area; found = h; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static int GetArea(IntPtr h) { RECT r; GetWindowRect(h, out r); return (r.Right - r.Left) * (r.Bottom - r.Top); }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
}
'@

$hwnd = [VW]::Video()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'no se encuentra la ventana de video'; exit 1 }
# Truco ALT + AttachThreadInput para vencer el bloqueo de foreground de Windows
[System.Windows.Forms.SendKeys]::SendWait('%')
Start-Sleep -Milliseconds 300
[void][VW]::ShowWindow($hwnd, 9)
[void][VW]::BringWindowToTop($hwnd)
[void][VW]::SetForegroundWindow($hwnd)
Start-Sleep -Seconds 2
Write-Output ('primer plano: "' + [VW]::TitleOf([VW]::GetForegroundWindow()) + '"')

function State() {
  $rt = Get-Content 'C:\yii\ciudadan-media-player\runtime\control-api.json' -Raw | ConvertFrom-Json
  $h = @{ Authorization = 'Bearer ' + $rt.token }
  (Invoke-RestMethod -Uri ('http://127.0.0.1:' + $rt.port + '/state') -Headers $h).state
}

$s0 = State
Write-Output ('estado inicial: ' + $s0.status + '  pos=' + $s0.position)

Write-Output '-> pulsando ESPACIO'
[System.Windows.Forms.SendKeys]::SendWait(' ')
Start-Sleep -Seconds 2
$s1 = State
Write-Output ('tras espacio: ' + $s1.status)
$okPause = ($s1.status -eq 'paused')

Write-Output '-> pulsando ESPACIO otra vez'
[System.Windows.Forms.SendKeys]::SendWait(' ')
Start-Sleep -Seconds 2
$s2 = State
Write-Output ('tras 2o espacio: ' + $s2.status)
$okPlay = ($s2.status -eq 'playing')

Write-Output '-> pulsando FLECHA IZQUIERDA (retroceder 10 s)'
$posBefore = $s2.position
[System.Windows.Forms.SendKeys]::SendWait('{LEFT}')
Start-Sleep -Seconds 2
$s3 = State
Write-Output ('posicion: ' + $posBefore + ' -> ' + $s3.position)
$okRew = ($s3.position -lt $posBefore)

Write-Output '-> pulsando M (silenciar)'
[System.Windows.Forms.SendKeys]::SendWait('m')
Start-Sleep -Seconds 2
$s4 = State
Write-Output ('silenciado: ' + $s4.muted + '  volumen: ' + $s4.volume)
$okMute = ($s4.muted -eq $true)

Write-Output ''
Write-Output ('RESULTADO espacio->pausa: ' + $okPause + ' | espacio->play: ' + $okPlay + ' | izquierda: ' + $okRew + ' | M silencia: ' + $okMute)
if ($okPause -and $okPlay -and $okRew -and $okMute) { Write-Output 'ATAJOS OK'; exit 0 } else { Write-Output 'FALLO'; exit 1 }
