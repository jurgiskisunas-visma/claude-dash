using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ClaudeDash.Api.Services;

public sealed class GitHubService
{
    private readonly ILogger<GitHubService> _logger;

    public GitHubService(ILogger<GitHubService> logger) { _logger = logger; }

    /// <summary>
    /// Look up the PR for the current branch in <paramref name="cwd"/> via `gh pr view`.
    /// Returns null if no PR exists or the gh CLI isn't available / not authenticated.
    /// </summary>
    public async Task<JsonElement?> GetCurrentPrAsync(string cwd, CancellationToken ct)
    {
        if (!Directory.Exists(cwd)) return null;
        // Fields requested: number, title, state, url, isDraft, author, base/head ref names,
        // body excerpt, last update, mergeable, rollup of check statuses.
        var fields = "number,title,state,url,isDraft,author,baseRefName,headRefName,body,updatedAt,mergeable,statusCheckRollup";
        var (ok, output) = await RunGhAsync(cwd, $"pr view --json {fields}", ct);
        if (!ok) return null;
        try
        {
            using var doc = JsonDocument.Parse(output);
            // Clone the root element so it survives the using-block.
            return doc.RootElement.Clone();
        }
        catch (JsonException) { return null; }
    }

    private async Task<(bool ok, string output)> RunGhAsync(string cwd, string args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("gh", args)
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        try
        {
            using var p = Process.Start(psi)!;
            var stdoutTask = p.StandardOutput.ReadToEndAsync(ct);
            var stderrTask = p.StandardError.ReadToEndAsync(ct);
            var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            await p.WaitForExitAsync(timeout.Token);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            if (p.ExitCode != 0)
            {
                _logger.LogDebug("gh {Args} (cwd={Cwd}) exit={Code} stderr={Err}",
                    args, cwd, p.ExitCode, stderr.Length > 200 ? stderr[..200] : stderr);
                return (false, stderr);
            }
            return (true, stdout);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "gh invocation failed");
            return (false, ex.Message);
        }
    }
}
