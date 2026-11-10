# Da el foco real a la ventana de vídeo (truco ALT para el bloqueo de foreground)
# y devuelve el título de la ventana en primer plano.
param([string]$Title = 'Ciudadan Media Player')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FG2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero; int best = 0;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString() == title) { RECT r; GetWindowRect(h, out r); int area = (r.Right-r.Left)*(r.Bottom-r.Top); if (area > best) { best = area; found = h; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
  public static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
}
'@

$hwnd = [FG2]::Find($Title)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'ventana no encontrada'; exit 1 }

# Truco: enviar ALT libera el bloqueo de foreground de Windows
[System.Windows.Forms.SendKeys]::SendWait('%')
Start-Sleep -Milliseconds 300
[void][FG2]::ShowWindow($hwnd, 9)
[void][FG2]::BringWindowToTop($hwnd)
$fgThread = [FG2]::GetWindowThreadProcessId([FG2]::GetForegroundWindow(), [ref]([uint32]0))
$myThread = [FG2]::GetCurrentThreadId()
[void][FG2]::AttachThreadInput($myThread, $fgThread, $true)
[void][FG2]::SetForegroundWindow($hwnd)
[void][FG2]::BringWindowToTop($hwnd)
[void][FG2]::AttachThreadInput($myThread, $fgThread, $false)
Start-Sleep -Seconds 1

$fg = [FG2]::GetForegroundWindow()
Write-Output ('ventana objetivo hwnd=' + $hwnd.ToInt64())
Write-Output ('primer plano hwnd=' + $fg.ToInt64() + ' titulo="' + [FG2]::TitleOf($fg) + '"')
if ($fg -ne $hwnd) { Write-Output 'NO se pudo dar el foco'; exit 2 }
Write-Output 'FOCO OK'
exit 0
