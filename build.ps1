<#
.SYNOPSIS
  Builds the backend and the frontend.

.DESCRIPTION
  Type-checks and bundles the frontend (tsc -b && vite build) and compiles the backend.
  Run .\setup.ps1 first on a fresh clone — this script does not restore packages.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -Release
  .\build.ps1 -Clean -StopRunning
#>
[CmdletBinding()]
param(
    # Build the backend in Release instead of Debug.
    [switch]$Release,

    # Delete bin/, obj/ and dist/ first.
    [switch]$Clean,

    # Stop a running backend before building. A running instance holds ClaudeDash.Api.exe,
    # which makes the build fail with MSB3027 — and stopping it kills every terminal it hosts.
    [switch]$StopRunning
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = if ($Release) { 'Release' } else { 'Debug' }
$started = Get-Date

if ($StopRunning) {
    $running = Get-Process -Name ClaudeDash.Api -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "Stopping backend (pid $($running.Id -join ', ')) — its terminals will close" -ForegroundColor Yellow
        $running | Stop-Process -Force
        Start-Sleep -Milliseconds 700
    }
}

if ($Clean) {
    Write-Host "Cleaning" -ForegroundColor Cyan
    foreach ($path in @(
        "$root\backend\ClaudeDash.Api\bin",
        "$root\backend\ClaudeDash.Api\obj",
        "$root\frontend\dist"
    )) {
        if (Test-Path $path) { Remove-Item -Recurse -Force $path; Write-Host "  removed $path" -ForegroundColor DarkGray }
    }
}

# A running Debug backend holds bin\Debug\...\ClaudeDash.Api.exe, so building over it fails
# after ten retries. Skip it rather than fight it: the running instance is someone's working
# session with live terminals attached. Release builds write elsewhere and are never affected.
$runningBackend = if ($config -eq 'Debug') { Get-Process -Name ClaudeDash.Api -ErrorAction SilentlyContinue } else { $null }

if ($runningBackend -and -not $StopRunning) {
    Write-Host "`nBackend ($config) — skipped" -ForegroundColor DarkYellow
    Write-Host "  ClaudeDash.Api is running (pid $($runningBackend.Id -join ', ')) and holds its own binary." -ForegroundColor DarkGray
    Write-Host "  Left it alone. Use -StopRunning to stop it and build (closes its terminals)," -ForegroundColor DarkGray
    Write-Host "  or -Release to build without touching it." -ForegroundColor DarkGray
} else {
    Write-Host "`nBackend ($config)" -ForegroundColor Cyan
    Push-Location (Join-Path $root 'backend\ClaudeDash.Api')
    try {
        dotnet build -c $config --nologo
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally { Pop-Location }
}

Write-Host "`nFrontend" -ForegroundColor Cyan
Push-Location (Join-Path $root 'frontend')
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Host "node_modules is missing — run .\setup.ps1 first." -ForegroundColor Yellow
        exit 1
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }

$elapsed = [int]((Get-Date) - $started).TotalSeconds
Write-Host "`nBuilt in ${elapsed}s" -ForegroundColor Green
if (-not ($runningBackend -and -not $StopRunning)) {
    Write-Host "  backend   backend\ClaudeDash.Api\bin\$config\net10.0\" -ForegroundColor DarkGray
}
Write-Host "  frontend  frontend\dist\" -ForegroundColor DarkGray
Write-Host "`nRun it with .\start.ps1 (dev servers, hot reload)`n"
