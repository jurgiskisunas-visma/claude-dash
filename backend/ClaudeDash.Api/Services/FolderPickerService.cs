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

    /// <summary>The dialog is modal to the user, so only one at a time.</summary>
    private readonly SemaphoreSlim _oneAtATime = new(1, 1);

    public async Task<string?> PickAsync(string? initialPath, CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows())
        {
            logger.LogWarning("Native folder picker is Windows-only");
            return null;
        }

        if (!await _oneAtATime.WaitAsync(TimeSpan.FromSeconds(1), ct)) return null;
        try
        {
            return await RunDialogAsync(initialPath, ct);
        }
        finally
        {
            _oneAtATime.Release();
        }
    }

    private async Task<string?> RunDialogAsync(string? initialPath, CancellationToken ct)
    {
        // -STA is required: WinForms dialogs need a single-threaded apartment.
        var script = """
            Add-Type -AssemblyName System.Windows.Forms | Out-Null
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.Description = 'Pick the working directory for the new Claude session'
            $dialog.ShowNewFolderButton = $true
            $dialog.UseDescriptionForTitle = $true
            if ($env:CLAUDEDASH_PICK_START -and (Test-Path $env:CLAUDEDASH_PICK_START)) {
              $dialog.SelectedPath = $env:CLAUDEDASH_PICK_START
            }
            if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
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

            try
            {
                using var proc = Process.Start(psi);
                if (proc is null) continue;

                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(Timeout);

                var stdout = await proc.StandardOutput.ReadToEndAsync(timeout.Token);
                await proc.WaitForExitAsync(timeout.Token);

                var picked = stdout.Trim();
                if (string.IsNullOrEmpty(picked)) return null;   // user cancelled
                return Directory.Exists(picked) ? picked : null;
            }
            catch (OperationCanceledException)
            {
                logger.LogInformation("Folder picker cancelled or timed out");
                return null;
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Folder picker via {Shell} failed", shell);
            }
        }

        logger.LogWarning("Could not open a native folder picker (no usable PowerShell)");
        return null;
    }
}
