# Zoom 4x del icono del escritorio + análisis del .ico (opacidad y forma).
param(
  [string]$Shot = 'C:\yii\ciudadan-media-player\logs\desk-a.png',
  [string]$Ico  = 'C:\yii\ciudadan-media-player\assets\favicon-ciudadan-morado-transparente.ico',
  [string]$Dir  = 'C:\yii\ciudadan-media-player\logs'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# --- zoom del icono en el escritorio ---
$bmpShot = [System.Drawing.Bitmap]::FromFile($Shot)
$rect = New-Object System.Drawing.Rectangle 240, 488, 70, 72
$crop = New-Object System.Drawing.Bitmap 70, 72
$gc = [System.Drawing.Graphics]::FromImage($crop)
$gc.DrawImage($bmpShot, (New-Object System.Drawing.Rectangle 0, 0, 70, 72), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$gc.Dispose()
$big = New-Object System.Drawing.Bitmap 280, 288
$g = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.DrawImage($crop, 0, 0, 280, 288)
$g.Dispose()
$big.Save((Join-Path $Dir 'desktop-icon-zoom.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $crop.Dispose(); $bmpShot.Dispose()
Write-Output ('zoom guardado: logs\desktop-icon-zoom.png (4x del icono dibujado)')

# --- análisis del .ico ---
$iconObj = [System.Drawing.Icon]::new([string]$Ico, 32, 32)
$bmp = $iconObj.ToBitmap()
$op = 0; $tot = 0; $minx = 99; $maxx = -1; $miny = 99; $maxy = -1
$bright = 0
for ($y = 0; $y -lt $bmp.Height; $y++) {
  for ($x = 0; $x -lt $bmp.Width; $x++) {
    $c = $bmp.GetPixel($x, $y); $tot++
    if ($c.A -gt 30) {
      $op++
      if ($x -lt $minx) { $minx = $x }; if ($x -gt $maxx) { $maxx = $x }
      if ($y -lt $miny) { $miny = $y }; if ($y -gt $maxy) { $maxy = $y }
      if (($c.R + $c.G + $c.B) -gt 330) { $bright++ }
    }
  }
}
Write-Output ('.ico 32x32: opacos=' + $op + '/' + $tot + ' (' + [int](100 * $op / $tot) + '%)  bbox x=' + $minx + '..' + $maxx + ' y=' + $miny + '..' + $maxy)
Write-Output ('  pixeles claros (resplandor/borde): ' + $bright)
$centre = $bmp.GetPixel(16, 16)
Write-Output ('  centro: RGB(' + $centre.R + ',' + $centre.G + ',' + $centre.B + ') A=' + $centre.A)
$bmp.Dispose(); $iconObj.Dispose()
