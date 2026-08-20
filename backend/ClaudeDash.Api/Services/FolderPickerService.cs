using System.Diagnostics;
using System.Text;

namespace ClaudeDash.Api.Services;

/// <summary>
/// Opens the host's native folder-picker dialog and returns what the user chose.
///
/// The browser can't do this: the File System Access API hands back a directory *handle*
/// with no absolute path, and `webkitdirectory` only gives relative paths — neither is
/// enough to spawn a process in that directory. Since the backend runs on the same machine
/// as the browser (localhost-only tool), it can put a real dialog on screen instead.
///
/// Implemented by shelling out to PowerShell + WinForms rather than COM-interoping
/// IFileDialog: about twenty lines instead of two hundred, and this is a local dev tool.
/// </summary>
public sealed class FolderPickerService(ILogger<FolderPickerService> logger)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    private readonly object _gate = new();

    /// <summary>
    /// The dialog currently on screen, if any. A second request takes over rather than being
    /// refused: the old dialog may be one the user never saw (it can open behind the browser),
    /// and refusing would leave the Browse button silently dead until the backend restarted.
    /// </summary>
    private Process? _open;

    public async Task<FolderPickResult> PickAsync(string? initialPath, CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows())
        {
            logger.LogWarning("Native folder picker is Windows-only");
            return new FolderPickResult(null, "The folder picker is only available on Windows.");
        }

        DismissOpenDialog();
        return await RunDialogAsync(initialPath, ct);
    }

    /// <summary>Closes a dialog left over from an earlier request, so a new one can open.</summary>
    private void DismissOpenDialog()
    {
        Process? stale;
        lock (_gate) { stale = _open; _open = null; }
        if (stale is null) return;
        try
        {
            if (!stale.HasExited)
            {
                logger.LogInformation("Replacing a folder dialog that was still open (pid {Pid})", stale.Id);
                stale.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex) { logger.LogDebug(ex, "Could not close the previous folder dialog"); }
        finally { stale.Dispose(); }
    }

    private async Task<FolderPickResult> RunDialogAsync(string? initialPath, CancellationToken ct)
    {
        // -STA is required: WinForms dialogs need a single-threaded apartment.
        //
        // The invisible owner window matters: a dialog with no owner opens behind whatever has
        // focus (the browser), so it looks like the Browse button did nothing while a process
        // sits there waiting forever. A TopMost owner puts it in front, and SetForegroundWindow
        // makes Windows give it focus.
        var script = """
            Add-Type -AssemblyName System.Windows.Forms | Out-Null
            # Single-quoted, single-line: a PowerShell here-string would have to close at
            # column 0, which a C# raw string literal does not allow.
            $sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); public struct RECT { public int Left, Top, Right, Bottom; } public struct POINT { public int X, Y; }'
            Add-Type -Namespace Native -Name Win -MemberDefinition $sig | Out-Null

            # An owner window is what makes the dialog appear on top; without one it opens
            # behind whatever has focus and looks like nothing happened. It is also what decides
            # *where* the dialog lands: the shell centres "Browse For Folder" on its owner, and
            # centring on the primary screen can put it on a monitor the user isn't looking at
            # (or off-screen entirely on some multi-monitor layouts). So the owner is placed over
            # the window that currently has focus — the browser the click came from.
            # Without this the form's coordinates are logical units while GetCursorPos returns
            # physical pixels, so placement drifts by the display's scaling factor.
            [void][Native.Win]::SetProcessDPIAware()

            $owner = New-Object System.Windows.Forms.Form
            $owner.FormBorderStyle = 'None'
            $owner.TopMost = $true
            $owner.ShowInTaskbar = $false
            $owner.Opacity = 0
            $owner.Width = 1
            $owner.Height = 1

            # Placement, most reliable first. The mouse is the best signal: the user just
            # clicked Browse with it, so its monitor is the one they are looking at. Focus is
            # the fallback, and the primary screen the last resort — which on a multi-monitor
            # layout with negative coordinates can be nowhere near the user's attention.
            $placed = $false
            $pt = New-Object Native.Win+POINT
            if ([Native.Win]::GetCursorPos([ref]$pt)) {
              $owner.StartPosition = 'Manual'
              $owner.Left = $pt.X
              $owner.Top = $pt.Y
              $placed = $true
            }
            if (-not $placed) {
              $fg = [Native.Win]::GetForegroundWindow()
              if ($fg -ne [IntPtr]::Zero) {
                $r = New-Object Native.Win+RECT
                if ([Native.Win]::GetWindowRect($fg, [ref]$r)) {
                  $w = $r.Right - $r.Left
                  $h = $r.Bottom - $r.Top
                  if ($w -gt 200 -and $h -gt 200) {
                    $owner.StartPosition = 'Manual'
                    $owner.Left = $r.Left + [int]($w / 2)
                    $owner.Top  = $r.Top  + [int]($h / 2)
                    $placed = $true
                  }
                }
              }
            }
            if (-not $placed) { $owner.StartPosition = 'CenterScreen' }

            $owner.Show()
            [void][Native.Win]::SetForegroundWindow($owner.Handle)
            $owner.Activate()

            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.Description = 'Pick the working directory for the new Claude session'
            $dialog.ShowNewFolderButton = $true
            $dialog.UseDescriptionForTitle = $true
            if ($env:CLAUDEDASH_PICK_START -and (Test-Path $env:CLAUDEDASH_PICK_START)) {
              $dialog.SelectedPath = $env:CLAUDEDASH_PICK_START
            }

            $result = $dialog.ShowDialog($owner)
            $owner.Close()
            if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
              [Console]::Out.Write($dialog.SelectedPath)
            }
            """;

        foreach (var shell in new[] { "powershell.exe", "pwsh.exe" })
        {
            var psi = new ProcessStartInfo(shell)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("-NoProfile");
            psi.ArgumentList.Add("-STA");
            psi.ArgumentList.Add("-Command");
            psi.ArgumentList.Add(script);
            psi.Environment["CLAUDEDASH_PICK_START"] = initialPath ?? "";
            psi.StandardOutputEncoding = Encoding.UTF8;

            Process? proc = null;
            try
            {
                proc = Process.Start(psi);
                if (proc is null) continue;
                lock (_gate) { _open = proc; }
                logger.LogInformation("Folder dialog opened via {Shell} (pid {Pid})", shell, proc.Id);

                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(Timeout);

                var stdout = await proc.StandardOutput.ReadToEndAsync(timeout.Token);
                await proc.WaitForExitAsync(timeout.Token);

                var picked = stdout.Trim();
                if (string.IsNullOrEmpty(picked)) return new FolderPickResult(null, null);  // cancelled
                return Directory.Exists(picked)
                    ? new FolderPickResult(picked, null)
                    : new FolderPickResult(null, $"That folder no longer exists: {picked}");
            }
            catch (OperationCanceledException)
            {
                // Either the caller went away or another request took this dialog over.
                logger.LogInformation("Folder dialog closed without a selection");
                return new FolderPickResult(null, null);
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Folder picker via {Shell} failed", shell);
            }
            finally
            {
                lock (_gate) { if (ReferenceEquals(_open, proc)) _open = null; }
                proc?.Dispose();
            }
        }

        logger.LogWarning("Could not open a native folder picker (no usable PowerShell)");
        return new FolderPickResult(null, "Could not open a folder dialog — no usable PowerShell on PATH.");
    }
}

/// <summary>
/// Outcome of a pick. <paramref name="Path"/> null with no <paramref name="Error"/> means the
/// user cancelled, which the UI should treat as a no-op rather than a failure.
/// </summary>
public record FolderPickResult(string? Path, string? Error);
