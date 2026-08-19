using System.Diagnostics;
using System.Text;
using ClaudeDash.Api.Models;

namespace ClaudeDash.Api.Services;

public sealed class GitService
{
    private readonly ILogger<GitService> _logger;

    public GitService(ILogger<GitService> logger) { _logger = logger; }

    /// <summary>
    /// Returns a list of files that differ between the working tree and the given base ref.
    /// Pass null base to auto-detect (origin/master → master → main → HEAD~1 fallback).
    /// </summary>
    public async Task<ChangesResult> GetChangesAsync(
        string cwd, string? baseRef, bool ignoreWhitespace, CancellationToken ct)
    {
        if (!Directory.Exists(cwd))
            return new ChangesResult(false, null, "cwd does not exist", "", "", []);
        if (!Directory.Exists(Path.Combine(cwd, ".git")) && !File.Exists(Path.Combine(cwd, ".git")))
            return new ChangesResult(false, null, "not a git repo", "", "", []);

        var (curBranchOk, curBranchOut) = await RunGitAsync(cwd, "rev-parse --abbrev-ref HEAD", ct);
        var curBranch = curBranchOk ? curBranchOut.Trim() : "HEAD";

        var resolved = await ResolveBaseRefAsync(cwd, baseRef, ct);
        if (resolved is null)
            return new ChangesResult(false, null, $"could not resolve base ref '{baseRef ?? "auto"}'", curBranch, "", []);

        var wsFlag = ignoreWhitespace ? " -w" : "";

        // Names + add/del counts: `git diff --numstat <base>`
        var (statOk, statOut) = await RunGitAsync(cwd, $"diff --numstat{wsFlag} {resolved}", ct);
        if (!statOk)
            return new ChangesResult(false, resolved, statOut, curBranch, "", []);

        var files = new List<ChangedFileSummary>();
        foreach (var line in statOut.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            // numstat: <added>\t<deleted>\t<path>   (binary: -\t-\t<path>)
            var parts = line.Trim().Split('\t');
            if (parts.Length < 3) continue;
            int? added = int.TryParse(parts[0], out var a) ? a : null;
            int? deleted = int.TryParse(parts[1], out var d) ? d : null;
            files.Add(new ChangedFileSummary(parts[2], parts[0] == "-" || parts[1] == "-", added ?? 0, deleted ?? 0));
        }

        // File status (added/modified/deleted/renamed): `git diff --name-status`
        var (nsOk, nsOut) = await RunGitAsync(cwd, $"diff --name-status {resolved}", ct);
        var statusByPath = new Dictionary<string, string>(StringComparer.Ordinal);
        if (nsOk)
        {
            foreach (var line in nsOut.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = line.Trim().Split('\t');
                if (parts.Length < 2) continue;
                // M, A, D, R<percent>, C<percent>
                var code = parts[0].Substring(0, 1);
                var path = parts[parts.Length - 1];
                statusByPath[path] = code switch
                {
                    "A" => "added",
                    "D" => "deleted",
                    "M" => "modified",
                    "R" => "renamed",
                    "C" => "copied",
                    _ => code.ToLowerInvariant(),
                };
            }
        }

        var enriched = files.Select(f => new ChangedFileSummary(
            f.Path, f.IsBinary, f.Additions, f.Deletions,
            Status: statusByPath.GetValueOrDefault(f.Path, "modified"))).ToList();

        return new ChangesResult(true, resolved, null, curBranch, $"git diff{wsFlag} {resolved} -- <file>", enriched);
    }

    /// <summary>Returns a single file's unified diff text vs the resolved base.</summary>
    public async Task<string?> GetFileDiffAsync(
        string cwd, string? baseRef, string path, bool ignoreWhitespace, CancellationToken ct)
    {
        var resolved = await ResolveBaseRefAsync(cwd, baseRef, ct);
        if (resolved is null) return null;
        var wsFlag = ignoreWhitespace ? " -w" : "";
        // Force --no-color and a big context window to make the renderer's life easy.
        var (ok, output) = await RunGitAsync(cwd,
            $"--no-pager diff{wsFlag} --no-color --unified=3 {resolved} -- \"{path}\"", ct);
        return ok ? output : null;
    }

    public async Task<string?> ResolveBaseRefAsync(string cwd, string? baseRef, CancellationToken ct)
    {
        var candidates = string.IsNullOrWhiteSpace(baseRef)
            ? new[] { "origin/master", "origin/main", "master", "main" }
            : new[] { baseRef };
        foreach (var c in candidates)
        {
            var (ok, _) = await RunGitAsync(cwd, $"rev-parse --verify --quiet {c}", ct);
            if (ok)
            {
                // Use merge-base when we have a branching base (so we don't show base-side commits).
                var (mbOk, mbOut) = await RunGitAsync(cwd, $"merge-base HEAD {c}", ct);
                return mbOk && !string.IsNullOrWhiteSpace(mbOut) ? mbOut.Trim() : c;
            }
        }
        // Last resort: HEAD~1 if it exists.
        var (h1Ok, h1Out) = await RunGitAsync(cwd, "rev-parse --verify --quiet HEAD~1", ct);
        if (h1Ok) return h1Out.Trim();
        return null;
    }

    /// <summary>True when the directory is a git repo root (.git dir or worktree file).</summary>
    public static bool IsRepoRoot(string dir) =>
        Directory.Exists(Path.Combine(dir, ".git")) || File.Exists(Path.Combine(dir, ".git"));

    /// <summary>Walks up from a file/dir path to the nearest enclosing repo root, or null.</summary>
    public static string? FindRepoRoot(string path)
    {
        try
        {
            var dir = Directory.Exists(path) ? path : Path.GetDirectoryName(path);
            while (!string.IsNullOrEmpty(dir))
            {
                if (IsRepoRoot(dir)) return Path.GetFullPath(dir);
                dir = Path.GetDirectoryName(dir);
            }
        }
        catch { /* malformed path */ }
        return null;
    }

    /// <summary>
    /// Computes changes for every repo relevant to a session. When cwd itself is a repo
    /// that's the single entry. Otherwise (a parent directory holding several repos) repos are
    /// discovered from the files the session touched, falling back to a one-level scan for
    /// child repos when the transcript yields nothing.
    /// </summary>
    public async Task<MultiChangesResult> GetMultiChangesAsync(
        string cwd, IReadOnlyList<string> touchedFiles, string? baseRef, bool ignoreWhitespace, CancellationToken ct)
    {
        if (!Directory.Exists(cwd))
            return new MultiChangesResult(false, "cwd does not exist", cwd, "cwd", []);

        var cwdFull = Path.GetFullPath(cwd);
        var repos = new List<string>();
        string via;

        if (IsRepoRoot(cwdFull))
        {
            repos.Add(cwdFull);
            via = "cwd";
        }
        else
        {
            // Attribute repos through the files this session actually edited.
            var set = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var f in touchedFiles)
            {
                var root = FindRepoRoot(f);
                if (root is not null) set.Add(root);
            }
            via = "touched-files";
            if (set.Count == 0)
            {
                // Nothing attributable — scan direct children so the tab still works.
                foreach (var sub in Directory.EnumerateDirectories(cwdFull))
                    if (IsRepoRoot(sub)) set.Add(Path.GetFullPath(sub));
                via = "scan";
            }
            repos.AddRange(set);
        }

        if (repos.Count == 0)
            return new MultiChangesResult(false, "no git repos found for this session (cwd is not a repo and no touched files map to one)", cwdFull, via, []);

        var results = new List<RepoChanges>();
        foreach (var repo in repos)
        {
            var changes = await GetChangesAsync(repo, baseRef, ignoreWhitespace, ct);
            var name = RelativeName(cwdFull, repo);
            results.Add(new RepoChanges(repo, name, changes));
        }
        return new MultiChangesResult(true, null, cwdFull, via, results);
    }

    private static string RelativeName(string cwd, string repo)
    {
        if (string.Equals(cwd, repo, StringComparison.OrdinalIgnoreCase)) return ".";
        var rel = Path.GetRelativePath(cwd, repo);
        // Repos outside the cwd (worktrees, siblings) get their leaf name instead of "..\..".
        return rel.StartsWith("..", StringComparison.Ordinal) ? Path.GetFileName(repo.TrimEnd('\\', '/')) : rel;
    }

    private async Task<(bool ok, string output)> RunGitAsync(string cwd, string args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("git", args)
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
            await p.WaitForExitAsync(ct);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            // For diff commands we want stdout-only; for everything else combined is fine for logging.
            var combined = string.IsNullOrEmpty(stdout) ? stderr.TrimEnd() : stdout;
            if (p.ExitCode != 0 && !string.IsNullOrEmpty(stderr))
            {
                _logger.LogDebug("git {Args} (cwd={Cwd}) exit={Code} stderr={Err}",
                    args, cwd, p.ExitCode, stderr.Length > 200 ? stderr[..200] : stderr);
            }
            return (p.ExitCode == 0, combined);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }
}
