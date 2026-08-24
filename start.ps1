#requires -Version 7

<#
  Starts ClaudeDash locally.
  - Backend: dotnet run on http://localhost:7341
  - Frontend: vite dev server on http://localhost:7342 (proxies /api /hub /ws to backend)
  Reads .env if present and exposes the values as process env vars.
#>

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# Load .env if present
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $eq = $line.IndexOf("=")
        if ($eq -lt 1) { return }
        $k = $line.Substring(0, $eq).Trim()
        $v = $line.Substring($eq + 1).Trim().Trim('"')
        if ($k -and $v) {
            [Environment]::SetEnvironmentVariable($k, $v, "Process")
        }
    }
    Write-Host "Loaded .env" -ForegroundColor DarkGray
}

# Map .env keys to ASP.NET configuration env vars (double-underscore for nested keys)
if ($env:JIRA_DOMAIN)    { $env:Jira__Domain   = $env:JIRA_DOMAIN }
if ($env:JIRA_EMAIL)     { $env:Jira__Email    = $env:JIRA_EMAIL }
if ($env:JIRA_API_TOKEN) { $env:Jira__ApiToken = $env:JIRA_API_TOKEN }
if ($env:JIRA_STATUS_LADDER) { $env:Jira__StatusLadder = $env:JIRA_STATUS_LADDER }
if ($env:SCRATCH_DIR)    { $env:Scratch__Dir  = $env:SCRATCH_DIR }
if ($env:CLAUDE_HOME)    { $env:ClaudeDash__ClaudeHome = $env:CLAUDE_HOME }

function Test-Listening([int]$Port) {
    $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

# Anything already serving is left exactly as it is. Re-running this script used to start a
# second backend, whose build then failed because the running one holds ClaudeDash.Api.exe —
# and restarting the backend would kill every terminal it hosts, which is never what you want
# from a command whose job is "make sure it's up".
$backendUp  = Test-Listening 7341
$frontendUp = Test-Listening 7342

if ($backendUp)  { Write-Host "Backend  → http://localhost:7341  (already running, left alone)" -ForegroundColor DarkYellow }
else             { Write-Host "Backend  → http://localhost:7341" }
if ($frontendUp) { Write-Host "Frontend → http://localhost:7342  (already running, left alone)" -ForegroundColor DarkYellow }
else             { Write-Host "Frontend → http://localhost:7342" }
Write-Host ""

if ($backendUp -and $frontendUp) {
    Write-Host "Everything is already up — nothing to do." -ForegroundColor Green
    Write-Host "  Open http://localhost:7342"
    Write-Host "  To restart the backend (this closes its terminals):" -ForegroundColor DarkGray
    Write-Host "    Get-Process -Name ClaudeDash.Api | Stop-Process -Force" -ForegroundColor DarkGray
    exit 0
}

$started = @()

if (-not $backendUp) {
    $started += Start-Process pwsh -PassThru -NoNewWindow -ArgumentList @(
        "-NoLogo", "-Command",
        "cd `"$root\backend\ClaudeDash.Api`"; dotnet run --urls http://localhost:7341"
    )
}

if (-not $frontendUp) {
    $started += Start-Process pwsh -PassThru -NoNewWindow -ArgumentList @(
        "-NoLogo", "-Command",
        "cd `"$root\frontend`"; npm run dev"
    )
}

try {
    $what = if ($started.Count -gt 1) { "both" } else { "it" }
    Write-Host "Press Ctrl+C to stop $what." -ForegroundColor DarkGray
    Wait-Process -Id ($started | ForEach-Object { $_.Id })
}
finally {
    # Only ever stop what this invocation started.
    foreach ($proc in $started) {
        if ($proc -and -not $proc.HasExited) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}
