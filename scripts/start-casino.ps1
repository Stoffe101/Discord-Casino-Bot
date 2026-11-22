# Runs the compiled casino bot and restarts it if it exits unexpectedly.
# Usage (from the project folder):  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-casino.ps1
# Build first with `npm run build`. Nothing here registers scheduled tasks or services.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root 'dist\main.js'))) {
    Write-Error 'dist\main.js not found. Run "npm run build" first.'
    exit 1
}
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
$log = Join-Path $root 'logs\runner.log'

$delay = 5
while ($true) {
    $started = Get-Date
    Add-Content -Path $log -Value "[$($started.ToString('s'))] starting casino bot"
    & node --enable-source-maps (Join-Path $root 'dist\main.js') *>> $log
    $code = $LASTEXITCODE
    Add-Content -Path $log -Value "[$((Get-Date).ToString('s'))] bot exited with code $code"
    if ($code -eq 0) { break }               # graceful shutdown (Ctrl+C / SIGTERM)
    if ($code -eq 2) {                      # configuration problem or another bot already running
        Write-Host 'The bot refused to start (configuration problem or another instance is running). See logs\runner.log.'
        break
    }
    if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 300) }
    Start-Sleep -Seconds $delay
}
