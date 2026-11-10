# Busca el color exacto del icono (38,0,82) en la captura del escritorio:
# si aparece, Explorer está dibujando el icono morado del reproductor.
param(
  [string]$Img = 'C:\yii\ciudadan-media-player\logs\desktop-icon-check.png'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Img)
Write-Output ('captura: ' + $bmp.Width + 'x' + $bmp.Height)

$exact = 0; $minx = 99999; $maxx = -1; $miny = 99999; $maxy = -1
$near = 0; $nminx = 99999; $nmaxx = -1; $nminy = 99999; $nmaxy = -1
for ($y = 0; $y -lt [Math]::Min(1040, $bmp.Height); $y++) {
  for ($x = 0; $x -lt [Math]::Min(760, $bmp.Width); $x++) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.R -eq 38 -and $c.G -eq 0 -and $c.B -eq 82) {
      $exact++
      if ($x -lt $minx) { $minx = $x }; if ($x -gt $maxx) { $maxx = $x }
      if ($y -lt $miny) { $miny = $y }; if ($y -gt $maxy) { $maxy = $y }
    }
    elseif ([Math]::Abs($c.R - 38) -le 18 -and $c.G -le 30 -and [Math]::Abs($c.B - 82) -le 25 -and ($c.B -gt $c.G + 30)) {
      $near++
      if ($x -lt $nminx) { $nminx = $x }; if ($x -gt $nmaxx) { $nmaxx = $x }
      if ($y -lt $nminy) { $nminy = $y }; if ($y -gt $nmaxy) { $nmaxy = $y }
    }
  }
}
Write-Output ('pixeles EXACTOS (38,0,82): ' + $exact + $(if ($exact -gt 0) { '  zona x=' + $minx + '..' + $maxx + ' y=' + $miny + '..' + $maxy } else { '' }))
Write-Output ('pixeles PRÓXIMOS (morado):   ' + $near + $(if ($near -gt 0) { '  zona x=' + $nminx + '..' + $nmaxx + ' y=' + $nminy + '..' + $nmaxy } else { '' }))
if ($near -gt 0) {
  $crop = New-Object System.Drawing.Rectangle ([Math]::Max(0, $nminx - 12)), ([Math]::Max(0, $nminy - 12)), ([Math]::Min(220, $bmp.Width - $nminx + 24)), ([Math]::Min(220, $bmp.Height - $nminy + 24))
  $out = $bmp.Clone($crop, $bmp.PixelFormat)
  $out.Save('C:\yii\ciudadan-media-player\logs\desktop-icon-found.png', [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Output 'recorte guardado: logs\desktop-icon-found.png'
}
$bmp.Dispose()
