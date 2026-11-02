$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
$trialDir = Join-Path $repoDir '.persistent-work-trial'
$entry = Join-Path $PSScriptRoot 'start-persistent-work-trial.ts'
$address = 'http://127.0.0.1:19753/'
try {
  $existing = Invoke-WebRequest -Uri $address -TimeoutSec 2 -UseBasicParsing
  if ($existing.Content -match 'persistent-work-trial.tsx') { Write-Output $address; exit 0 }
  throw '端口 19753 已被其他程序占用。'
} catch {
  if ($_.Exception.Message -match '端口 19753') { throw }
}
New-Item -ItemType Directory -Path $trialDir -Force | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$job = Start-Process -FilePath $nodePath -ArgumentList @('--experimental-strip-types', ('"' + $entry + '"')) -WorkingDirectory $repoDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $trialDir 'launcher.log') -RedirectStandardError (Join-Path $trialDir 'launcher-error.log')
for ($i = 0; $i -lt 120; $i++) {
  if ($job.HasExited) { throw "试用服务未能启动，请查看 $trialDir\launcher-error.log" }
  try {
    $response = Invoke-WebRequest -Uri $address -TimeoutSec 1 -UseBasicParsing
    if ($response.Content -match 'persistent-work-trial.tsx') { Write-Output $address; exit 0 }
  } catch {}
  Start-Sleep -Milliseconds 500
}
throw "试用服务启动超时，请查看 $trialDir\launcher-error.log"
