# Comprueba que la barra flotante NO tapa la barra de título de la ventana de vídeo:
#  - compara los rectángulos de ambas ventanas
#  - WindowFromPoint en la barra de título: debe devolver la ventana de VÍDEO
#    (si devolviera la overlay, los botones de minimizar/cerrar/mover quedarían tapados)
param(
  [string]$VideoTitle = 'Ciudadan Media Player',
  [string]$OverlayPart = 'Controles YouTube'
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TB {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
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
  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
}
'@

$video = [TB]::Find($VideoTitle)
$overlay = [TB]::FindPart($OverlayPart)
if ($video -eq [IntPtr]::Zero) { Write-Output 'no se encuentra la ventana de video'; exit 1 }
if ($overlay -eq [IntPtr]::Zero) { Write-Output 'no se encuentra la ventana de la barra'; exit 1 }

$rv = New-Object TB+RECT; [void][TB]::GetWindowRect($video, [ref]$rv)
$ro = New-Object TB+RECT; [void][TB]::GetWindowRect($overlay, [ref]$ro)
Write-Output ('ventana de video : x=' + $rv.Left + ' y=' + $rv.Top + ' w=' + ($rv.Right - $rv.Left) + ' h=' + ($rv.Bottom - $rv.Top))
Write-Output ('barra flotante   : x=' + $ro.Left + ' y=' + $ro.Top + ' w=' + ($ro.Right - $ro.Left) + ' h=' + ($ro.Bottom - $ro.Top))

$ok = $true
# 1) la barra no puede empezar por encima del área de contenido
if ($ro.Top -lt $rv.Top) { Write-Output 'FALLO: la barra empieza por encima de la ventana'; $ok = $false }
else { Write-Output ('OK: la barra empieza ' + ($ro.Top - $rv.Top) + ' px por debajo del borde superior (barra de título libre)') }

# 2) en un punto de la barra de título, la ventana que recibe el clic es la de vídeo
$titleBarY = $rv.Top + 10
$hit = [TB]::WindowFromPoint((New-Object TB+POINT -Property @{ X = [int]($rv.Left + 200); Y = [int]$titleBarY }))
$hitTitle = [TB]::TitleOf($hit)
Write-Output ('WindowFromPoint en la barra de título -> "' + $hitTitle + '" (clase ' + [TB]::ClassOf($hit) + ')')
if ($hit -ne $video) { Write-Output 'FALLO: la barra flotante intercepta los clics de la barra de título'; $ok = $false }
else { Write-Output 'OK: los clics de la barra de título (minimizar/cerrar/mover) llegan a la ventana de vídeo' }

# 3) y en el centro del vídeo llega a la barra flotante (los controles siguen siendo clicables)
$hit2 = [TB]::WindowFromPoint((New-Object TB+POINT -Property @{ X = [int](($rv.Left + $rv.Right) / 2); Y = [int](($rv.Top + $rv.Bottom) / 2) }))
Write-Output ('WindowFromPoint en el centro del vídeo -> "' + [TB]::TitleOf($hit2) + '"')

if ($ok) { Write-Output ''; Write-Output 'TITULO-BAR OK: la barra de título es utilizable'; exit 0 }
Write-Output ''; Write-Output 'TITULO-BAR FAIL'; exit 1
