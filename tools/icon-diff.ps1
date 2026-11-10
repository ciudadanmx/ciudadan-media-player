# Prueba decisiva del icono del escritorio: captura con el acceso directo visible,
# lo oculta (attrib +h), vuelve a capturar y calcula la diferencia.
# La zona que cambia es exactamente donde Explorer dibujaba el icono (y su etiqueta).
param(
  [string]$Lnk = 'C:\Users\elyiz\Desktop\Ciudadan Media Player - YouTube (libVLC).lnk',
  [string]$Dir = 'C:\yii\ciudadan-media-player\logs'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Capture([string]$file) {
  $b = New-Object System.Drawing.Bitmap 1920, 1080
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen(0, 0, 0, 0, $b.Size)
  $g.Dispose()
  $b.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
}

Write-Output '1) captura con el acceso directo visible'
Capture (Join-Path $Dir 'desk-a.png')
Start-Sleep -Seconds 2

Write-Output '2) ocultando el acceso directo (attrib +h)'
& attrib +h $Lnk
Start-Sleep -Seconds 4
Capture (Join-Path $Dir 'desk-b.png')

Write-Output '3) restaurando (attrib -h)'
& attrib -h $Lnk
Start-Sleep -Seconds 4
Capture (Join-Path $Dir 'desk-c.png')

$a = [System.Drawing.Bitmap]::FromFile((Join-Path $Dir 'desk-a.png'))
$b = [System.Drawing.Bitmap]::FromFile((Join-Path $Dir 'desk-b.png'))
$diff = 0; $minx = 99999; $maxx = -1; $miny = 99999; $maxy = -1
for ($y = 0; $y -lt 1040; $y++) {
  for ($x = 0; $x -lt 760; $x++) {
    $pa = $a.GetPixel($x, $y); $pb = $b.GetPixel($x, $y)
    if ([Math]::Abs($pa.R - $pb.R) -gt 12 -or [Math]::Abs($pa.G - $pb.G) -gt 12 -or [Math]::Abs($pa.B - $pb.B) -gt 12) {
      $diff++
      if ($x -lt $minx) { $minx = $x }; if ($x -gt $maxx) { $maxx = $x }
      if ($y -lt $miny) { $miny = $y }; if ($y -gt $maxy) { $maxy = $y }
    }
  }
}
Write-Output ('pixeles que cambian al ocultar el icono: ' + $diff)
if ($diff -gt 0) {
  Write-Output ('zona de la diferencia: x=' + $minx + '..' + $maxx + '  y=' + $miny + '..' + $maxy)
  $w = [Math]::Min(300, $maxx - $minx + 20); $h = [Math]::Min(300, $maxy - $miny + 20)
  $crop = New-Object System.Drawing.Rectangle ([Math]::Max(0, $minx - 10)), ([Math]::Max(0, $miny - 10)), $w, $h
  $out = $a.Clone($crop, $a.PixelFormat)
  $out.Save((Join-Path $Dir 'desktop-icon-region.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Output ('recorte del icono: logs\desktop-icon-region.png (' + $w + 'x' + $h + ')')
} else {
  Write-Output '=> el escritorio NO cambia al ocultar el acceso directo (el icono no se dibuja)'
}
$a.Dispose(); $b.Dispose()
