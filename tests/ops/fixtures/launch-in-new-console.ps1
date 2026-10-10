# P206: starts the interruption fixture in its OWN hidden console (Windows only) and writes its PID to pid.txt in the output directory.
#
# Node's `detached: true` on Windows means DETACHED_PROCESS (no console at all), so a console control
# event could never be delivered to such a child. Start-Process creates a new console instead.
# stdout/stderr are redirected to files in the output directory because the console is not ours.
param(
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$Fixture,
  [Parameter(Mandatory = $true)][string]$Phase,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$WorkDir
)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$p = Start-Process -FilePath $Node `
  -ArgumentList @('--import', 'tsx', $Fixture, $Phase, $OutDir) `
  -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $OutDir 'child.stdout.txt') `
  -RedirectStandardError (Join-Path $OutDir 'child.stderr.txt')
Set-Content -Path (Join-Path $OutDir 'pid.txt') -Value $p.Id
