# Coincidencia de plantilla: busca el icono exacto del reproductor en la captura
# del escritorio (comprueba si Explorer realmente dibuja el icono morado).
param(
  [string]$Img = 'C:\yii\ciudadan-media-player\logs\desktop-icon-check.png',
  [string]$Lnk = 'C:\Users\elyiz\Desktop\Ciudadan Media Player - YouTube (libVLC).lnk'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ShellIcon2 {
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
}
"@

function Get-IconBitmap([string]$path, [uint32]$flags) {
  $info = New-Object ShellIcon2+SHFILEINFO
  [ShellIcon2]::SHGetFileInfo($path, 0, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info), $flags) | Out-Null
  if ($info.hIcon -eq [IntPtr]::Zero) { return $null }
  $ico = [System.Drawing.Icon]::FromHandle($info.hIcon)
  $bmp = $ico.ToBitmap()
  $ico.Dispose(); [ShellIcon2]::DestroyIcon($info.hIcon) | Out-Null
  return $bmp
}

$shot = [System.Drawing.Bitmap]::FromFile($Img)
foreach ($flags in @(0x100, 0x4000)) {   # SHGFI_ICON (32) y SHGFI_SYSLARGEICON (48)
  $tpl = Get-IconBitmap $Lnk $flags
  if (-not $tpl) { continue }
  Write-Output ('== plantilla ' + $tpl.Width + 'x' + $tpl.Height + ' (flags 0x' + $flags.ToString('X') + ') ==')
  $best = -1; $bx = -1; $by = -1
  $maxX = [Math]::Min(700, $shot.Width - $tpl.Width)
  $maxY = [Math]::Min(1050, $shot.Height - $tpl.Height)
  for ($y = 0; $y -le $maxY; $y++) {
    for ($x = 0; $x -le $maxX; $x++) {
      $hit = 0; $tot = 0
      for ($ty = 0; $ty -lt $tpl.Height; $ty += 2) {
        for ($tx = 0; $tx -lt $tpl.Width; $tx += 2) {
          $tp = $tpl.GetPixel($tx, $ty)
          if ($tp.A -lt 20) { continue }
          $tot++
          $sp = $shot.GetPixel($x + $tx, $y + $ty)
          if ([Math]::Abs([int]$sp.R - [int]$tp.R) -le 45 -and [Math]::Abs([int]$sp.G - [int]$tp.G) -le 45 -and [Math]::Abs([int]$sp.B - [int]$tp.B) -le 45) { $hit++ }
        }
      }
      if ($tot -gt 0) {
        $score = [int](1000 * $hit / $tot)
        if ($score -gt $best) { $best = $score; $bx = $x; $by = $y }
      }
    }
  }
  Write-Output ('   mejor coincidencia: ' + $best + '/1000 en x=' + $bx + ' y=' + $by)
  if ($best -ge 850) {
    $crop = New-Object System.Drawing.Rectangle $bx, $by, $tpl.Width, $tpl.Height
    $out = $shot.Clone($crop, $shot.PixelFormat)
    $out.Save('C:\yii\ciudadan-media-player\logs\desktop-icon-found.png', [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
    Write-Output '   => ICONO ENCONTRADO en el escritorio (logs\desktop-icon-found.png)'
  } else {
    Write-Output '   => NO se encuentra el icono en la captura'
  }
  $tpl.Dispose()
}
$shot.Dispose()
