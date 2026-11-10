# Captura del vídeo con la barra estilo YouTube visible (mueve el ratón y captura).
param(
  [string]$Out = 'C:\yii\ciudadan-media-player\logs\yt-bar-real.png'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Cur {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
'@

# Buscar la ventana de vídeo (la de título 'Ciudadan Media Player' más grande)
$list = Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> List() {
    var l = new List<string>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      var t = sb.ToString();
      if (t == "Ciudadan Media Player") { RECT r; GetWindowRect(h, out r);
        l.Add(r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top)); }
      return true;
    }, IntPtr.Zero);
    return l;
  }
}
'@ -PassThru

$rects = [W]::List()
if ($rects.Count -eq 0) { Write-Output 'no se encuentra la ventana de video'; exit 1 }
# la ventana de video es la mas grande (960x540); el panel de controles es 960x104
$chosen = $null; $bestArea = 0
foreach ($r in $rects) {
  $pp = $r -split ','
  $area = [int]$pp[2] * [int]$pp[3]
  if ($area -gt $bestArea) { $bestArea = $area; $chosen = $r }
}
$parts = $chosen -split ','
$x = [int]$parts[0]; $y = [int]$parts[1]; $w = [int]$parts[2]; $h = [int]$parts[3]
Write-Output ("ventana: " + $w + "x" + $h + " en " + $x + "," + $y)

# mover el raton por el video para que la barra aparezca
[Cur]::SetCursorPos([int]($x + $w / 2), [int]($y + $h - 60)) | Out-Null
Start-Sleep -Milliseconds 400
[Cur]::SetCursorPos([int]($x + $w / 2 + 12), [int]($y + $h - 60)) | Out-Null
Start-Sleep -Milliseconds 700

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ('captura: ' + $Out)
