Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static System.Collections.Generic.List<string> List() {
    var list = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      var t = sb.ToString();
      if (t.Length > 0) { RECT r; GetWindowRect(h, out r); uint pid; GetWindowThreadProcessId(h, out pid);
        list.Add(pid + "|" + t + "|" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top) + "|" + h.ToInt64()); }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

$repo = 'C:\yii\ciudadan-media-player'
Write-Output '=== ventanas visibles del proceso electron ==='
$procIds = (Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty Id)
$targets = @()
foreach ($w in [Win]::List()) {
  $p = $w -split '\|'
  if ($procIds -contains [int]$p[0]) { Write-Output ("pid=" + $p[0] + " titulo='" + $p[1] + "' rect=" + $p[2]); $targets += $w }
}
if ($targets.Count -eq 0) { Write-Output 'NO HAY VENTANAS ELECTRON VISIBLES'; exit 1 }

# Region del video = ventana con mayor area que contenga 'Player'
$video = $targets | ForEach-Object { $p = $_ -split '\|'; $r = $p[2] -split ','; [pscustomobject]@{ Title=$p[1]; X=[int]$r[0]; Y=[int]$r[1]; W=[int]$r[2]; H=[int]$r[3]; Hwnd=[IntPtr][int64]$p[4] } } | Sort-Object { $_.W * $_.H } -Descending | Select-Object -First 1

# Traer la ventana de video al frente: si otra ventana la tapa, la captura del
# escritorio mostraria esa otra ventana (y no el video) -> falso negativo.
[void][Win]::ShowWindow($video.Hwnd, 9)   # SW_RESTORE
[void][Win]::BringWindowToTop($video.Hwnd)
[void][Win]::SetForegroundWindow($video.Hwnd)
Start-Sleep -Milliseconds 1200
Write-Output ("ventana de video: '" + $video.Title + "' " + $video.W + "x" + $video.H + " en " + $video.X + "," + $video.Y)

function Snap($path) {
  $bmp = New-Object System.Drawing.Bitmap($video.W, $video.H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($video.X, $video.Y, 0, 0, $bmp.Size)
  $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
$a = Join-Path $repo 'logs\shot-a.png'; $b = Join-Path $repo 'logs\shot-b.png'
Snap $a; Start-Sleep -Seconds 3; Snap $b

$ba = [System.Drawing.Bitmap]::FromFile($a); $bb = [System.Drawing.Bitmap]::FromFile($b)
$total = 0; $nonBlack = 0; $changed = 0; $sum = 0.0; $colors = @{}
$step = 4
for ($y = 0; $y -lt $ba.Height; $y += $step) {
  for ($x = 0; $x -lt $ba.Width; $x += $step) {
    $pa = $ba.GetPixel($x, $y); $pb = $bb.GetPixel($x, $y)
    $total++; $sum += ($pa.R + $pa.G + $pa.B) / 3.0
    if (($pa.R + $pa.G + $pa.B) -gt 30) { $nonBlack++ }
    if ([Math]::Abs($pa.R - $pb.R) -gt 12 -or [Math]::Abs($pa.G - $pb.G) -gt 12 -or [Math]::Abs($pa.B - $pb.B) -gt 12) { $changed++ }
    $k = "$($pa.R),$($pa.G),$($pa.B)"; if (-not $colors.ContainsKey($k)) { $colors[$k] = 0 }; $colors[$k]++
  }
}
$ba.Dispose(); $bb.Dispose()
$pctNonBlack = [math]::Round(100.0 * $nonBlack / $total, 1)
$pctChanged = [math]::Round(100.0 * $changed / $total, 1)
$mean = [math]::Round($sum / $total, 1)
$distinct = $colors.Count
Write-Output ''
Write-Output '=== EVIDENCIA DE RENDER EN LA VENTANA ELECTRON ==='
Write-Output ("muestras=$total  brillo_medio=$mean  pixeles_no_negros=$pctNonBlack%  colores_distintos=$distinct")
Write-Output ("pixeles_cambiados_entre_3s=$pctChanged%  (video en movimiento si > 0.5%)")
if ($pctNonBlack -gt 50 -and $pctChanged -gt 0.5) { Write-Output 'RESULTADO: RENDER DE VIDEO CONFIRMADO (imagen + movimiento)'; exit 0 }
elseif ($pctNonBlack -gt 50) { Write-Output 'RESULTADO: imagen visible pero sin movimiento medible'; exit 2 }
else { Write-Output 'RESULTADO: ventana Electron NEGRA (sin render de video)'; exit 3 }
