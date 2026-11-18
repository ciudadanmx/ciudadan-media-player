# =============================================================================
# Arranque de una COPIA del reproductor instalada en una unidad sincronizada
# (Google Drive, OneDrive...). En esas unidades cada escritura pasa por el
# proceso de sincronización, que bloquea el fichero: el log llegó a tardar 1 s
# por línea y el hilo principal se congelaba (175 atascos medidos).
#
# Solución: el CÓDIGO vive en la unidad sincronizada, pero el ESTADO (logs,
# datos, runtime, temporales y perfil de Electron) vive en disco local.
#
#   powershell -ExecutionPolicy Bypass -File tools\start-local-copy.ps1 `
#       -ProjectRoot "G:\Mi unidad\ciudadan-media-player" -ScreenIndex 2 -ApiPort 17990
# =============================================================================
param(
  [string]$ProjectRoot = 'G:\Mi unidad\ciudadan-media-player',
  [int]$ScreenIndex = 2,          # 0 = principal, 2 = tercer monitor
  [int]$ApiPort = 17990,
  [switch]$Debug
)

$ErrorActionPreference = 'Stop'
$work = Join-Path $env:LOCALAPPDATA 'CiudadanMediaPlayer\workspace'
$logs = Join-Path $work 'logs'
$data = Join-Path $work 'data'
$runtime = Join-Path $work 'runtime'
$tmp = Join-Path $work 'tmp'
$profile = Join-Path $work 'profile'
$vlc = Join-Path $work 'vlc64'
foreach ($d in @($logs, $data, $runtime, $tmp, $profile)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# VLC portable en DISCO LOCAL: cargar libVLC desde una unidad sincronizada
# (Google Drive) tarda minutos y acaba en "libvlc_new falló (sin instancia)".
if (-not (Test-Path (Join-Path $vlc 'vlc-3.0.23\libvlc.dll'))) {
  $src = Join-Path $ProjectRoot '.vlc64'
  if (Test-Path $src) {
    Write-Host "Copiando VLC portable a disco local ($vlc)..."
    robocopy $src $vlc /E /R:2 /W:1 /NFL /NDL /NJH /NP | Out-Null
  }
}

# Si ya hay una instancia de esta copia, se cierra (sólo la de esta copia).
$apiFile = Join-Path $runtime 'control-api.json'
if (Test-Path $apiFile) {
  try {
    $rt = Get-Content $apiFile -Raw | ConvertFrom-Json
    if ($rt.pid) { Stop-Process -Id $rt.pid -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
  } catch {}
}

$env:CMP_LOG_DIR = $logs
$env:CMP_DATA_DIR = $data
$env:CMP_RUNTIME_DIR = $runtime
$env:CMP_TMPDIR = $tmp
$env:CMP_USER_DATA = $profile
$env:CMP_VLC_DIR = $vlc
$env:CMP_API_PORT = "$ApiPort"
$env:CMP_SCREEN_INDEX = "$ScreenIndex"

$electron = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "No se encuentra Electron en $electron" }

$args = @('.', '--no-sandbox', "--user-data-dir=$profile")
if ($Debug) { $args += "--remote-debugging-port=$($ApiPort + 143)" }
Start-Process -FilePath $electron -ArgumentList $args -WorkingDirectory $ProjectRoot -WindowStyle Hidden

Write-Host "Ciudadan Media Player (copia) arrancada desde: $ProjectRoot"
Write-Host "  monitor:  $($ScreenIndex + 1)   API: http://127.0.0.1:$ApiPort"
Write-Host "  estado local: $work"
Start-Sleep -Seconds 12
if (Test-Path $apiFile) {
  $rt = Get-Content $apiFile -Raw | ConvertFrom-Json
  Write-Host "  API viva en el puerto $($rt.port) (pid $($rt.pid))"
} else {
  Write-Host '  la API aún no ha publicado su fichero de runtime; revisa el log en unos segundos'
}
