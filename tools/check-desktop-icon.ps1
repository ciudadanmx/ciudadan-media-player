# Comprueba el icono que Explorer resuelve para el acceso directo y captura el escritorio.
param(
  [string]$Lnk = 'C:\Users\elyiz\Desktop\Ciudadan Media Player - YouTube (libVLC).lnk',
  [string]$Out = 'C:\yii\ciudadan-media-player\logs\desktop-icon-check.png'
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ShellIcon {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
  public struct SHFILEINFO {
    public IntPtr hIcon; public int iIcon; public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)]  public string szTypeName;
  }
  [DllImport("shell32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes,
      ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
}
"@

Write-Output '== 1. Icono que resuelve Explorer para el .lnk =='
$info = New-Object ShellIcon+SHFILEINFO
$SHGFI_ICON = 0x00000100; $SHGFI_LARGEICON = 0x00000000
[ShellIcon]::SHGetFileInfo($Lnk, 0, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info), $SHGFI_ICON) | Out-Null
if ($info.hIcon -eq [IntPtr]::Zero) { Write-Output '   ERROR: Explorer no devuelve icono para el .lnk' }
else {
  $bmp = New-Object System.Drawing.Bitmap 32,32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $mem = [ShellIcon]::CreateCompatibleDC($hdc)
  $old = [ShellIcon]::SelectObject($mem, $info.hIcon)
  $g.ReleaseHdc($hdc)
  # GetIconInfo dibuja 32x32 (o 48x48 si hay varias); usamos GetIconInfoEx si es posible
  $ico = [System.Drawing.Icon]::FromHandle($info.hIcon)
  $big = $ico.ToBitmap()
  $bmp.Dispose(); $g.Dispose()
  $px = $big.GetPixel([int]($big.Width/2), [int]($big.Height/2))
  $c = $big.GetPixel(3,3)
  Write-Output ('   tamaño: ' + $big.Width + 'x' + $big.Height)
  Write-Output ('   pixel centro: R=' + $px.R + ' G=' + $px.G + ' B=' + $px.B + ' A=' + $px.A)
  Write-Output ('   pixel esquina: R=' + $c.R + ' G=' + $c.G + ' B=' + $c.B + ' A=' + $c.A)
  $purple = ($px.R -lt 120 -and $px.B -gt 40 -and $px.R + $px.B -gt $px.G + 60)
  Write-Output ('   => icono morado Ciudadan: ' + $purple)
  $big.Dispose(); $ico.Dispose()
  [ShellIcon]::DestroyIcon($info.hIcon) | Out-Null
}

Write-Output ''
Write-Output '== 2. Captura del escritorio (iconos reales dibujados) =='
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Seconds 3
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen 2>$null
if (-not $bounds) { $bounds = New-Object System.Drawing.Rectangle 0,0,1920,1080 }
$bmp2 = New-Object System.Drawing.Bitmap 1920, 1080
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.CopyFromScreen(0, 0, 0, 0, $bmp2.Size)
$bmp2.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g2.Dispose(); $bmp2.Dispose()
Write-Output ('   captura: ' + $Out)

# buscar el morado del icono en la zona de iconos (columna izquierda)
$img = [System.Drawing.Bitmap]::FromFile($Out)
$found = @()
for ($y = 0; $y -lt 950; $y += 2) {
  for ($x = 0; $x -lt 420; $x += 2) {
    $c = $img.GetPixel($x, $y)
    if ($c.R -lt 130 -and $c.B -gt 45 -and $c.R + $c.B -gt $c.G + 70 -and $c.B -gt $c.G + 25) {
      $found += ,@($x, $y)
    }
  }
}
$img.Dispose()
if ($found.Count -gt 0) {
  $xs = ($found | ForEach-Object { $_[0] }); $ys = ($found | ForEach-Object { $_[1] })
  Write-Output ('   pixeles morados detectados: ' + $found.Count)
  Write-Output ('   zona: x=' + ($xs | Measure-Object -Minimum).Minimum + '..' + ($xs | Measure-Object -Maximum).Maximum + '  y=' + ($ys | Measure-Object -Minimum).Minimum + '..' + ($ys | Measure-Object -Maximum).Maximum)
} else {
  Write-Output '   NO se detectaron pixeles morados del icono en la columna de iconos'
}
