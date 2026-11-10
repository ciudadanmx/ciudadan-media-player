# Localiza el icono morado del reproductor en la captura del escritorio.
param(
  [string]$Img = 'C:\yii\ciudadan-media-player\logs\desktop-icon-check.png'
)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Img)
Write-Output ('captura: ' + $bmp.Width + 'x' + $bmp.Height)

# mapa de pixeles morados en pasos de 1 px (region de iconos: x<450, y<1000)
$mask = @{}
for ($y = 0; $y -lt [Math]::Min(1000, $bmp.Height); $y++) {
  for ($x = 0; $x -lt [Math]::Min(450, $bmp.Width); $x++) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.R -lt 135 -and $c.B -gt 45 -and ($c.R + $c.B) -gt ($c.G + 70) -and ($c.B -gt $c.G + 25)) {
      $mask["$x,$y"] = $true
    }
  }
}
# agrupar por bandas de y contiguas
$ys = $mask.Keys | ForEach-Object { [int](($_ -split ',')[1]) } | Sort-Object -Unique
$bands = @(); $start = $null; $prev = $null
foreach ($y in $ys) {
  if ($null -eq $start) { $start = $y; $prev = $y; continue }
  if ($y - $prev -gt 6) { $bands += ,@($start, $prev); $start = $y }
  $prev = $y
}
if ($null -ne $start) { $bands += ,@($start, $prev) }

foreach ($b in $bands) {
  $y0 = $b[0]; $y1 = $b[1]
  $minx = 9999; $maxx = -1; $n = 0
  for ($y = $y0; $y -le $y1; $y++) {
    for ($x = 0; $x -lt [Math]::Min(450, $bmp.Width); $x++) {
      if ($mask.ContainsKey("$x,$y")) { $n++; if ($x -lt $minx) { $minx = $x }; if ($x -gt $maxx) { $maxx = $x } }
    }
  }
  Write-Output ('banda y=' + $y0 + '..' + $y1 + '  x=' + $minx + '..' + $maxx + '  pixeles=' + $n)
}
$bmp.Dispose()
