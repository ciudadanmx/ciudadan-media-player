Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class IconProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetClassLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("gdi32.dll")] public static extern bool GetIconInfo(IntPtr hico, out ICONINFO ii);
  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  public static System.Collections.Generic.List<string> List() {
    var list = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      var t = sb.ToString();
      if (t.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      long big = SendMessage(h, 0x007F, new IntPtr(1), IntPtr.Zero).ToInt64(); // WM_GETICON, ICON_BIG
      long small = SendMessage(h, 0x007F, new IntPtr(0), IntPtr.Zero).ToInt64(); // ICON_SMALL
      long cls = GetClassLongPtr(h, -14).ToInt64(); // GCLP_HICON
      list.Add(pid + "|" + t + "|" + big + "|" + small + "|" + cls);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

$ids = (Get-Process electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if (-not $ids) { Write-Output 'NO HAY PROCESOS ELECTRON'; exit 1 }
Write-Output '=== icono de las ventanas de Electron ==='
foreach ($w in [IconProbe]::List()) {
  $p = $w -split '\|'
  if ($ids -contains [int]$p[0]) {
    $hico = if ([int64]$p[2] -ne 0) { [IntPtr][int64]$p[2] } elseif ([int64]$p[3] -ne 0) { [IntPtr][int64]$p[3] } else { [IntPtr][int64]$p[4] }
    Write-Output ("'" + $p[1] + "'  big=" + $p[2] + " small=" + $p[3] + " clase=" + $p[4])
    if ($hico -ne [IntPtr]::Zero) {
      try {
        $ico = [System.Drawing.Icon]::FromHandle($hico)
        $bmp = $ico.ToBitmap()
        $purple = 0; $total = 0; $colors = New-Object 'System.Collections.Generic.HashSet[string]'
        for ($y = 0; $y -lt $bmp.Height; $y += 2) { for ($x = 0; $x -lt $bmp.Width; $x += 2) {
          $c = $bmp.GetPixel($x, $y); $total++
          if (($c.R -gt 60) -and ($c.B -gt 60) -and ($c.G -lt ($c.R - 25)) -and ($c.G -lt ($c.B - 25))) { $purple++ }
          [void]$colors.Add(($c.R -shr 4).ToString() + ',' + ($c.G -shr 4).ToString() + ',' + ($c.B -shr 4).ToString())
        } }
        Write-Output ("   -> icono " + $bmp.Width + 'x' + $bmp.Height + "  colores=" + $colors.Count + "  pixeles_morado=" + [math]::Round(100.0 * $purple / $total, 1) + '%')
        $bmp.Dispose(); $ico.Dispose()
      } catch { Write-Output ('   -> no se pudo leer el icono: ' + $_.Exception.Message) }
    } else { Write-Output '   -> SIN ICONO' }
  }
}
