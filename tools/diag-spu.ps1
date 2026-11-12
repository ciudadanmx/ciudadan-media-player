cd C:\yii\ciudadan-media-player
Get-Process electron,vlc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item .electron-userdata\Singleton* -ErrorAction SilentlyContinue
Start-Sleep -Seconds 8
$env:CMP_API_PORT = '17995'
$env:CMP_API_TOKEN = 'tok-diag'
$env:CMP_AUTOTEST_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
$env:CMP_AUTOTEST_SECS = '30'
$p = Start-Process -FilePath 'node_modules\electron\dist\electron.exe' -ArgumentList '.', '--no-sandbox', '--user-data-dir=C:\yii\ciudadan-media-player\.electron-userdata', '--api-test' -WorkingDirectory 'C:\yii\ciudadan-media-player' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 100
Select-String -Path logs\app.log -Pattern 'spu check|subt.tulos|resuelto|load:' | Select-Object -Last 10 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(300, $_.Line.Length)) }
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Get-Process electron,vlc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Output 'fin diag'
