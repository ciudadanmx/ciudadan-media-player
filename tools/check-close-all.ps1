# Comprueba que al cerrar la ventana de vídeo se cierra TODA la app
# (la antigua ventana inferior de controles se quedaba viva).
param(
  [int]$WaitStart = 60
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CloseWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int CountAll() {
    int n = 0;
    EnumWindows((h, p) => { if (IsWindowVisible(h)) n++; return true; }, IntPtr.Zero);
    return n;
  }
}
'@
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt $WaitStart; $i++) {
  $hwnd = [CloseWin]::Find('Ciudadan Media Player')
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Seconds 1
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'no aparece la ventana de video'; exit 1 }
$antes = (Get-Process electron -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Output ('procesos electron antes: ' + $antes + ' | ventanas visibles: ' + [CloseWin]::CountAll())
[void][CloseWin]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE
$despues = $antes
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  $despues = (Get-Process electron -ErrorAction SilentlyContinue | Measure-Object).Count
  if ($despues -eq 0) { break }
}
Write-Output ('procesos electron despues de cerrar la ventana: ' + $despues + ' (tras ' + ($i+1) + ' s)')
if ($despues -eq 0) { Write-Output 'CIERRE OK: la app cierra TODAS sus ventanas (no queda la de controles)'; exit 0 }
Write-Output 'CIERRE FAIL: quedan procesos de electron'
exit 1
