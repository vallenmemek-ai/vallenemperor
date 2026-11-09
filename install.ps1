# VallenEmperor installer for Windows (PowerShell 5.1+ or pwsh 7+).
#   .\install.ps1                 build and install launchers
#   .\install.ps1 -Uninstall      remove launchers
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $env:LOCALAPPDATA 'VallenEmperor\bin'

function Assert-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js >= 20 is required. Install it with: winget install OpenJS.NodeJS.LTS' }
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 20) { throw "Node.js >= 20 required (found $(& node -v))." }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
}

if ($Uninstall) {
  foreach ($name in @('vallenemperor.cmd', 'vallenemperorcli.cmd')) {
    $target = Join-Path $binDir $name
    if (Test-Path $target) { Remove-Item $target -Force; Write-Host "Removed $target" }
  }
  Write-Host "Uninstalled VallenEmperor launchers from $binDir"
  exit 0
}

Assert-Node
Push-Location $repoDir
try {
  & npm ci --workspace=vallenagent --workspace=vallencli --include-workspace-root=false
  if ($LASTEXITCODE -ne 0) {
    Write-Warning 'npm ci failed; retrying with npm install...'
    & npm install --workspace=vallenagent --workspace=vallencli --include-workspace-root=false
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  }
  & npm -w vallenagent run build
  if ($LASTEXITCODE -ne 0) { throw 'Core build failed.' }
  & npm -w vallencli run build
  if ($LASTEXITCODE -ne 0) { throw 'CLI build failed.' }
}
finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$launcher = Join-Path $repoDir 'bin\vallenemperor.cmd'
foreach ($name in @('vallenemperor.cmd', 'vallenemperorcli.cmd')) {
  $shim = Join-Path $binDir $name
  Set-Content -Path $shim -Encoding ASCII -Value @"
@echo off
call "$launcher" %*
"@
}
Write-Host "Installed VallenEmperor launchers to $binDir"
if (-not ($env:PATH -split ';' | Where-Object { $_ -eq $binDir })) {
  Write-Host "Add it to PATH for this user:"
  Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `$env:PATH + ';$binDir', 'User')"
}
