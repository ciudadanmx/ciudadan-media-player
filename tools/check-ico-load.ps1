Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class IcoApi {
  [DllImport("shell32.dll", CharSet=CharSet.Auto)]
  public static extern uint ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
  [DllImport("shell32.dll", CharSet=CharSet.Auto)]
  public static extern int ExtractIconEx(string lpszFile, int nIconIndex, IntPtr phiconLarge, IntPtr phiconSmall, uint nIcons);
  [DllImport("shell32.dll", CharSet=CharSet.Auto)]
  public static extern uint SHGetFileInfo(string pszPath, uint dwFileAttributes, out SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
  public struct SHFILEINFO { public IntPtr hIcon; public int iIcon; public IntPtr dwAttributes; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string szTypeName; }
}
'@

$ico = 'C:\yii\ciudadan-media-player\assets\favicon-ciudadan-morado-transparente.ico'
Write-Output ('--- ExtractIconEx (conteo de iconos que ve el shell) en ' + $ico + ' ---')
$large = New-Object IntPtr[] 16
$small = New-Object IntPtr[] 16
$count = [IcoApi]::ExtractIconEx($ico, -1, $large, $small, 16)
Write-Output ('  iconos enumerados por el shell: ' + $count)
if ($count -gt 0) {
  for ($i = 0; $i -lt [Math]::Min([int]$count, 16); $i++) {
    $h = $large[$i]
    if ($h -ne [IntPtr]::Zero) {
      $icon = [System.Drawing.Icon]::FromHandle($h)
      $bmp = $icon.ToBitmap()
      $c = $bmp.GetPixel(0,0)
      Write-Output ("  [$i] " + $bmp.Width + 'x' + $bmp.Height + ' px  esquina A=' + $c.A + ' 透明=' + ($c.A -eq 0))
      $bmp.Dispose()
    }
  }
}
Write-Output '--- SHGetFileInfo(SHGFI_ICON) sobre el .ico ---'
$fi = New-Object IcoApi+SHFILEINFO
[void][IcoApi]::SHGetFileInfo($ico, 0, [ref]$fi, [Runtime.InteropServices.Marshal]::SizeOf($fi), 0x100)
Write-Output ('  hIcon=' + $fi.hIcon + '  iIcon=' + $fi.iIcon)
if ($fi.hIcon -ne [IntPtr]::Zero) {
  $bmp = ([System.Drawing.Icon]::FromHandle($fi.hIcon)).ToBitmap()
  Write-Output ('  icono del shell: ' + $bmp.Width + 'x' + $bmp.Height + '  esquina A=' + $bmp.GetPixel(0,0).A)
  $bmp.Dispose()
}
Write-Output '--- prueba con el .ico de VLC (referencia: ese si lo pintaba?) ---'
$vlcIco = 'C:\yii\ciudadan-media-player\.vlc64\vlc-3.0.23\vlc.ico'
if (Test-Path $vlcIco) {
  $c2 = [IcoApi]::ExtractIconEx($vlcIco, -1, $large, $small, 16)
  Write-Output ('  vlc.ico -> iconos enumerados: ' + $c2)
}
