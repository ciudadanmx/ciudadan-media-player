# Histograma de color de los píxeles que forman el icono (diferencia A-B)
param(
  [string]$Dir = 'C:\yii\ciudadan-media-player\logs'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$a = [System.Drawing.Bitmap]::FromFile((Join-Path $Dir 'desk-a.png'))
$b = [System.Drawing.Bitmap]::FromFile((Join-Path $Dir 'desk-b.png'))

$hist = @{}
$exact = 0; $near = 0; $n = 0
$minx = 99999; $maxx = -1; $miny = 99999; $maxy = -1
for ($y = 480; $y -lt 560; $y++) {
  for ($x = 235; $x -lt 310; $x++) {
    $pa = $a.GetPixel($x, $y); $pb = $b.GetPixel($x, $y)
    if ([Math]::Abs($pa.R - $pb.R) -gt 12 -or [Math]::Abs($pa.G - $pb.G) -gt 12 -or [Math]::Abs($pa.B - $pb.B) -gt 12) {
      $n++
      if ($x -lt $minx) { $minx = $x }; if ($x -gt $maxx) { $maxx = $x }
      if ($y -lt $miny) { $miny = $y }; if ($y -gt $maxy) { $maxy = $y }
      $k = '{0},{1},{2}' -f $pa.R, $pa.G, $pa.B
      if ($hist.ContainsKey($k)) { $hist[$k]++ } else { $hist[$k] = 1 }
      if ($pa.R -eq 38 -and $pa.G -eq 0 -and $pa.B -eq 82) { $exact++ }
      if ([Math]::Abs($pa.R - 38) -le 22 -and $pa.G -le 35 -and [Math]::Abs($pa.B - 82) -le 30) { $near++ }
    }
  }
}
Write-Output ('pixeles del icono: ' + $n + '  bbox x=' + $minx + '..' + $maxx + ' y=' + $miny + '..' + $maxy)
Write-Output ('pixeles EXACTOS (38,0,82): ' + $exact)
Write-Output ('pixeles PRÓXIMOS al morado Ciudadan: ' + $near)
Write-Output 'colores más frecuentes del icono:'
$hist.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8 | ForEach-Object {
  $p = $_.Key -split ','
  Write-Output ('   RGB(' + $p[0] + ',' + $p[1] + ',' + $p[2] + ') x' + $_.Value)
}
$a.Dispose(); $b.Dispose()
