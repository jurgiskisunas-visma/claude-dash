<#
.SYNOPSIS
  Adds (or removes) a Startup-folder shortcut that launches ClaudeDash hidden at login.

.EXAMPLE
  .\install-startup.ps1
  .\install-startup.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    # Delete the shortcut instead of creating it.
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $root 'start-hidden.vbs'
$startup  = [Environment]::GetFolderPath('Startup')
$link     = Join-Path $startup 'ClaudeDash.lnk'

if ($Remove) {
    if (Test-Path $link) {
        if ($PSCmdlet.ShouldProcess($link, 'Remove startup shortcut')) {
            Remove-Item $link -Force
            Write-Host "Removed $link"
        }
    } else {
        Write-Host "Nothing to remove — $link does not exist."
    }
    return
}

if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }

if ($PSCmdlet.ShouldProcess($link, "Create shortcut to $launcher")) {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($link)
    $sc.TargetPath       = 'wscript.exe'
    $sc.Arguments        = '"{0}"' -f $launcher
    $sc.WorkingDirectory = $root
    $sc.Description      = 'Start ClaudeDash in the background'
    $sc.IconLocation     = Join-Path $root 'sparkle.ico'
    $sc.Save()

    Write-Host "Created $link"
    Write-Host "ClaudeDash will start hidden at login. Dashboard: http://localhost:7342"
}
