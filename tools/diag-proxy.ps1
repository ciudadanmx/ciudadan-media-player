cd C:\yii\ciudadan-media-player
Get-Process electron,vlc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item .electron-userdata\Singleton* -ErrorAction SilentlyContinue
Start-Sleep -Seconds 8
$env:CMP_API_PORT = '17996'
$env:CMP_API_TOKEN = 'tok-diag2'
$env:CMP_AUTOTEST_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
$env:CMP_AUTOTEST_SECS = '40'
$p = Start-Process -FilePath 'node_modules\electron\dist\electron.exe' -ArgumentList '.', '--no-sandbox', '--user-data-dir=C:\yii\ciudadan-media-player\.electron-userdata', '--api-test' -WorkingDirectory 'C:\yii\ciudadan-media-player' -PassThru
# esperar a que aparezca la URL del stream en el log
$stream = $null
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 2
  $m = Select-String -Path logs\app.log -Pattern 'resuelto:.*-> (http://\S+)' -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($m) { $stream = $m.Line -replace '.*-> ', ''; $stream = $stream -replace '\s.*$', ''; break }
}
Write-Output "stream: $stream"
if ($stream) {
  Get-Process vlc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  node tools\probe-spu.mjs 6 proxy $stream 2>&1 | Select-String -Pattern '^== |^mrl|^state=|^set_spu|^err' | Select-Object -Last 8 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(260, $_.Line.Length)) }
}
Select-String -Path logs\app.log -Pattern 'spu check' | Select-Object -Last 4 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(320, $_.Line.Length)) }
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Get-Process electron,vlc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Output 'fin diag-proxy'
