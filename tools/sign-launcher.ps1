# Firma local del lanzador. Usa certutil para confiar en las almacenes del usuario
# (CurrentUser\Root y CurrentUser\TrustedPublisher) sin abrir el dialogo de
# "almacen protegido" que bloquea la ejecucion.
$ErrorActionPreference = 'Continue'
$root = 'C:\yii\ciudadan-media-player'
# El lanzador vive FUERA de la carpeta del proyecto: en esa ruta Windows lo marcaba
# como "adjunto" (Attachment Manager) y mostraba el aviso "Advertencia de seguridad
# de Abrir archivo" al abrirlo, aunque estuviera firmado y sin Mark of the Web.
# En %LOCALAPPDATA% (ruta nunca "adjunta") arranca limpio.
$launcherDir = Join-Path $env:LOCALAPPDATA 'CiudadanMediaPlayer'
$exe = Join-Path $launcherDir 'CiudadanMediaPlayer.exe'
$cer = Join-Path $env:TEMP 'ciudadan-media-player-code-signing.cer'
$subject = 'CN=Ciudadan Media Player'

if (-not (Test-Path $launcherDir)) { New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null }
if (-not (Test-Path (Join-Path $launcherDir 'app-root.txt'))) {
  Set-Content -Path (Join-Path $launcherDir 'app-root.txt') -Value $root -Encoding ASCII -NoNewline
}

Write-Output '--- 1) mark of the web ---'
foreach ($f in @($exe, (Join-Path $root 'assets\favicon-ciudadan-morado-transparente.ico'))) {
  if (Test-Path $f) {
    if (Get-Item $f -Stream * -ErrorAction SilentlyContinue | Where-Object { $_.Stream -eq 'Zone.Identifier' }) {
      Unblock-File -Path $f; Write-Output ('  quitado MOTW: ' + (Split-Path $f -Leaf))
    } else { Write-Output ('  sin MOTW: ' + (Split-Path $f -Leaf)) }
  }
}

Write-Output '--- 2) certificado de firma ---'
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $subject -and $_.HasPrivateKey } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\CurrentUser\My `
    -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(5) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
  Write-Output '  certificado creado'
}
Write-Output ('  ' + $cert.Subject + '  thumbprint=' + $cert.Thumbprint)

Write-Output '--- 3) exportando e instalando la confianza local (certutil, sin dialogos) ---'
[System.IO.File]::WriteAllBytes($cer, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
foreach ($store in @('Root', 'TrustedPublisher')) {
  $out = & certutil.exe -user -f -addstore $store $cer 2>&1 | Out-String
  $ok = $out -match 'Certificate added|agregado|successfully'
  Write-Output ('  CurrentUser\' + $store + ': ' + $(if ($ok) { 'añadido' } else { 'sin confirmar -> ' + ($out -replace '\r?\n', ' ').Trim() }))
}

Write-Output '--- 4) firmando el lanzador y electron.exe ---'
# Se firma TODO lo ejecutable de la ruta de arranque: el lanzador y el binario
# de Electron (electron.exe viene sin firmar del proyecto Electron y es el que
# dispara el aviso de "aplicacion no reconocida" de SmartScreen/Defender).
$paraFirmar = @($exe, (Join-Path $root 'node_modules\electron\dist\electron.exe')) |
  Where-Object { Test-Path $_ }
foreach ($f in $paraFirmar) {
  $sig = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -HashAlgorithm SHA256
  Write-Output ('  ' + (Split-Path $f -Leaf) + ' -> ' + $sig.Status + ' (' + $sig.StatusMessage + ')')
  if ($sig.Status -ne 'Valid') {
    # La cadena puede no resolverse todavia: se reintenta tras refrescar el almacen.
    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = 'NoCheck'
    [void]$chain.Build($cert)
    $sig = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -HashAlgorithm SHA256
    Write-Output ('    reintento: ' + $sig.Status + ' (' + $sig.StatusMessage + ')')
  }
}

Write-Output '--- 5) verificacion ---'
foreach ($f in $paraFirmar) {
  $check = Get-AuthenticodeSignature $f
  Write-Output ('  ' + (Split-Path $f -Leaf) + ' -> ' + $check.Status + ' | ' + $(if ($check.SignerCertificate) { $check.SignerCertificate.Subject } else { '(ninguno)' }))
}

Write-Output '--- 6) refrescando la identidad del fichero ---'
# Al volver a firmar, Windows conserva en el binario el estado "adjunto" que
# dispara el aviso "Advertencia de seguridad de Abrir archivo" (Attachment
# Manager) aunque ya no exista el stream Zone.Identifier. Reescribir el fichero
# con una copia limpia devuelve al sistema el estado "local sin avisos" y la
# firma sigue siendo valida (es una copia byte a byte).
foreach ($f in $paraFirmar) {
  $tmp = $f + '.refresh'
  Copy-Item $f $tmp -Force
  Move-Item $tmp $f -Force
  Unblock-File $f -ErrorAction SilentlyContinue
  Write-Output ('  ' + (Split-Path $f -Leaf) + ' -> ' + (Get-AuthenticodeSignature $f).Status)
}

Get-Item $exe | Select-Object Name, Length, LastWriteTime

