param(
  [string]$HealthUrl = 'http://127.0.0.1:19753/api/health',
  [string]$TrialHomeUrl = 'http://127.0.0.1:19753/',
  [string]$StarterPath = '',
  [string]$MutexName = 'Local\OpenMausBot-Personal-Trial-Watchdog',
  [int]$PollSeconds = 20,
  [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
$trialDir = Join-Path $repoDir '.persistent-work-trial'
if (-not $StarterPath) { $StarterPath = Join-Path $PSScriptRoot 'start-persistent-work-trial.ps1' }
New-Item -ItemType Directory -Path $trialDir -Force | Out-Null
if (-not $LogPath) { $LogPath = Join-Path $trialDir 'watchdog.log' }
$mutex = [System.Threading.Mutex]::new($false, $MutexName)
$owned = $false
try {
  try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { exit 0 }
  while ($true) {
    $healthy = $false
    try {
      $result = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
      $healthy = $result.app -eq 'openmausbot'
    } catch {}
    if (-not $healthy) {
      $occupied = $false
      try { $null = Invoke-WebRequest -Uri $trialHomeUrl -TimeoutSec 3; $occupied = $true } catch {
        if ($_.Exception.Response) { $occupied = $true }
      }
      if ($occupied) {
        Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) Unhealthy response with occupied port; waiting without stopping a process."
      } else {
        try {
          $null = & $StarterPath
          Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) Start requested."
        } catch {
          Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) Start failed; will retry."
        }
      }
    }
    Start-Sleep -Seconds $PollSeconds
  }
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
