# Analiza la captura real del monitor y cuenta los colores clave:
#   - morada neón del progreso (#D946EF y su degradado #A855F7..#F0ABFC)
#   - negro verdoso de las barras (R=12 G=30 B=19, con tolerancia)
#   - texto de subtítulos en el color elegido (#E879F9)
param([string]$Imagen = "$env:LOCALAPPDATA\CiudadanMediaPlayer\workspace\logs\monitor3-subtitulos.png")
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Imagen)
$morado = 0; $verdeNegro = 0; $textoSub = 0; $rojo = 0
$w = $bmp.Width; $h = $bmp.Height
for ($y = 0; $y -lt $h; $y += 2) {
  for ($x = 0; $x -lt $w; $x += 2) {
    $c = $bmp.GetPixel($x, $y)
    $r = [int]$c.R; $g = [int]$c.G; $bl = [int]$c.B
    # morada neón (púrpura/magenta saturado)
    if ($r -gt 120 -and $bl -gt 120 -and $g -lt ($r - 40) -and $g -lt ($bl - 40)) { $morado++ }
    # negro verdoso de las barras (G明显 mayor que R y B, todos bajos)
    elseif ($g -gt $r -and $g -gt $bl -and $g -lt 90 -and $r -lt 70 -and $bl -lt 70) { $verdeNegro++ }
    # rojo puro (el color antiguo de la barra de progreso) -> no debe aparecer
    if ($r -gt 200 -and $g -lt 60 -and $bl -lt 60) { $rojo++ }
    # texto de subtítulos #E879F9 (232,121,249)
    if ([Math]::Abs($r-232) -lt 26 -and [Math]::Abs($g-121) -lt 30 -and [Math]::Abs($bl-249) -lt 26) { $textoSub++ }
  }
}
Write-Output ("imagen: {0} ({1}x{2})" -f (Split-Path $Imagen -Leaf), $w, $h)
Write-Output ("pixeles morada neon (progreso/barra superior): {0}" -f $morado)
Write-Output ("pixeles negro verdoso (barras):                 {0}" -f $verdeNegro)
Write-Output ("pixeles texto de subtitulos #E879F9:            {0}" -f $textoSub)
Write-Output ("pixeles rojo puro (color antiguo, debe ser 0):   {0}" -f $rojo)
$bmp.Dispose()
