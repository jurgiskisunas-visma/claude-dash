<#
.SYNOPSIS
  First-time setup: checks prerequisites, creates .env, restores packages, builds once.

.DESCRIPTION
  Safe to re-run — everything it does is idempotent. Run this after cloning, then use
  .\start.ps1 to run the dashboard and .\build.ps1 for later builds.

.EXAMPLE
  .\setup.ps1
  .\setup.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    # Restore packages but don't compile. Useful if you only want to run the dev servers,
    # which build on the fly anyway.
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$problems = @()

function Test-Tool {
    param([string]$Command, [string]$Name, [string]$Url, [switch]$Optional)

    $found = Get-Command $Command -ErrorAction SilentlyContinue
    if ($found) {
        $version = try { (& $Command --version 2>$null | Select-Object -First 1) } catch { 'unknown' }
        Write-Host ("  {0,-12} {1}" -f $Name, $version) -ForegroundColor DarkGray
        return $true
    }
    if ($Optional) {
        Write-Host ("  {0,-12} not found — optional" -f $Name) -ForegroundColor DarkYellow
    } else {
        $script:problems += "$Name is required. Install it from $Url"
        Write-Host ("  {0,-12} MISSING" -f $Name) -ForegroundColor Red
    }
    return $false
}

Write-Host "`nPrerequisites" -ForegroundColor Cyan
Test-Tool -Command 'dotnet' -Name '.NET SDK' -Url 'https://dotnet.microsoft.com/download' | Out-Null
Test-Tool -Command 'node'   -Name 'Node.js'  -Url 'https://nodejs.org' | Out-Null
Test-Tool -Command 'npm'    -Name 'npm'      -Url 'https://nodejs.org' | Out-Null
# Not required to build — only to actually spawn sessions from the dashboard.
Test-Tool -Command 'claude' -Name 'Claude'   -Url 'https://claude.com/claude-code' -Optional | Out-Null
Test-Tool -Command 'gh'     -Name 'gh (PRs)' -Url 'https://cli.github.com' -Optional | Out-Null

if ($problems.Count) {
    Write-Host "`nCannot continue:" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

# --- .env ---------------------------------------------------------------------------
Write-Host "`nConfiguration" -ForegroundColor Cyan
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    Write-Host "  .env already exists — left alone" -ForegroundColor DarkGray
} else {
    Copy-Item (Join-Path $root '.env.example') $envFile
    Write-Host "  created .env from .env.example" -ForegroundColor Green
    Write-Host "  (only needed for the Jira tab; the rest works with it empty)" -ForegroundColor DarkGray
}

# --- packages -----------------------------------------------------------------------
Write-Host "`nRestoring packages" -ForegroundColor Cyan
Push-Location (Join-Path $root 'backend\ClaudeDash.Api')
try {
    dotnet restore | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "dotnet restore failed" }
    Write-Host "  backend  ok" -ForegroundColor Green
} finally { Pop-Location }

Push-Location (Join-Path $root 'frontend')
try {
    if (Test-Path 'node_modules') {
        # `npm ci` deletes node_modules first, which fails while the dev server holds
        # esbuild.exe. On an existing tree `npm install` is the non-destructive option.
        $vite = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -like '*vite*' }
        if ($vite) { Write-Host "  dev server is running — using npm install" -ForegroundColor DarkYellow }
        npm install
    } elseif (Test-Path 'package-lock.json') {
        npm ci        # fresh clone: reproducible install straight from the lock file
    } else {
        npm install
    }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Write-Host "  frontend ok" -ForegroundColor Green
} finally { Pop-Location }

# --- first build --------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host "`nBuilding" -ForegroundColor Cyan
    & (Join-Path $root 'build.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "`nReady." -ForegroundColor Green
Write-Host "  .\start.ps1            run it (dashboard on http://localhost:7342)"
Write-Host "  .\build.ps1            build after changes"
Write-Host "  .\install-startup.ps1  start it automatically at login"
Write-Host ""
