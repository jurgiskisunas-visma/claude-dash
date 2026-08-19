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
if ($env:CLAUDE_HOME)    { $env:ClaudeDash__ClaudeHome = $env:CLAUDE_HOME }

Write-Host "Backend  → http://localhost:7341"
Write-Host "Frontend → http://localhost:7342"
Write-Host ""

# Start backend
$backend = Start-Process pwsh -PassThru -NoNewWindow -ArgumentList @(
    "-NoLogo", "-Command",
    "cd `"$root\backend\ClaudeDash.Api`"; dotnet run --urls http://localhost:7341"
)

# Start frontend
$frontend = Start-Process pwsh -PassThru -NoNewWindow -ArgumentList @(
    "-NoLogo", "-Command",
    "cd `"$root\frontend`"; npm run dev"
)

try {
    Write-Host "Press Ctrl+C to stop both." -ForegroundColor DarkGray
    Wait-Process -Id $backend.Id, $frontend.Id
}
finally {
    foreach ($p in @($backend, $frontend)) {
        if ($p -and -not $p.HasExited) {
            try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}
