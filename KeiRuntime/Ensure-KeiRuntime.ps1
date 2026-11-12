$ErrorActionPreference = 'Stop'
$mutex = New-Object System.Threading.Mutex($false, 'Local\KeiRuntimeStartup')
$locked = $false
try {
    $locked = $mutex.WaitOne(10000)
    if (-not $locked) {throw 'Another Runtime startup is in progress'}
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:17881/health' -TimeoutSec 3
        if ($health.status -eq 'ok') {Write-Output 'Kei Runtime already ready.'; exit 0}
    } catch {}
    $running = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^python(w)?\.exe$' -and $_.CommandLine -match 'run_runtime\.py' }
    if (-not $running) {
        $env:ASTRBOT_API_KEY = [Environment]::GetEnvironmentVariable('ASTRBOT_API_KEY','User')
        $env:PYTHONUTF8 = '1'
        $env:PYTHONIOENCODING = 'utf-8'
        $env:KEI_LOG_PATH = 'D:\KeiDesktop\launcher-logs\runtime.out.log'
        Start-Process -FilePath 'D:\KeiRuntime\.venv\Scripts\python.exe' -ArgumentList '-u','run_runtime.py' -WorkingDirectory 'D:\KeiRuntime' -WindowStyle Hidden | Out-Null
    }
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:17881/health' -TimeoutSec 2
            if ($health.status -eq 'ok') {Write-Output 'Kei Runtime ready for daily Bilibili activity.'; exit 0}
        } catch {}
        Start-Sleep -Seconds 1
    }
    throw 'Kei Runtime did not become ready; check runtime.out.log'
} finally {
    if ($locked) {$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
