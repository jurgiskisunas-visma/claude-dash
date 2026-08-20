namespace ClaudeDash.Api.Services;

/// <summary>
/// Directory listing for the in-app folder browser.
///
/// This replaced a native folder dialog. The dialog was spawned by this process — a background
/// web server — and Windows refuses to let such a process take the foreground, so it opened
/// behind the browser about half the time no matter what was tried (owner windows, HWND_TOPMOST,
/// synthetic input to satisfy the focus rules). Listing directories over HTTP and drawing the
/// browser inside the page has none of that ambiguity: it is part of the page, so it is always
/// visible, and it works the same on any OS.
/// </summary>
public sealed class DirectoryBrowseService(ILogger<DirectoryBrowseService> logger)
{
    public BrowseResult Browse(string? path)
    {
        // No path yet: offer the roots worth starting from.
        if (string.IsNullOrWhiteSpace(path)) return Roots();

        var full = Path.GetFullPath(path.Trim());
        if (!Directory.Exists(full)) return Roots(error: $"No such directory: {full}");

        var dirs = new List<BrowseEntry>();
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(full))
            {
                try
                {
                    var info = new DirectoryInfo(dir);
                    // Hidden and system directories are noise when picking a project folder.
                    if (info.Attributes.HasFlag(FileAttributes.Hidden)
                        || info.Attributes.HasFlag(FileAttributes.System)) continue;
                    dirs.Add(new BrowseEntry(info.Name, info.FullName));
                }
                catch (Exception ex) { logger.LogTrace(ex, "Skipping {Dir}", dir); }
            }
        }
        catch (UnauthorizedAccessException)
        {
            return new BrowseResult(full, ParentOf(full), [], DriveList(), "That folder can't be read.");
        }
        catch (IOException ex)
        {
            return new BrowseResult(full, ParentOf(full), [], DriveList(), ex.Message);
        }

        dirs.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return new BrowseResult(full, ParentOf(full), dirs, DriveList(), null);
    }

    private BrowseResult Roots(string? error = null)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var entries = new List<BrowseEntry>();
        if (Directory.Exists(home)) entries.Add(new BrowseEntry("Home", home));
        return new BrowseResult(null, null, entries, DriveList(), error);
    }

    private List<BrowseEntry> DriveList()
    {
        var drives = new List<BrowseEntry>();
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                if (!d.IsReady) continue;
                drives.Add(new BrowseEntry(d.Name.TrimEnd(Path.DirectorySeparatorChar), d.RootDirectory.FullName));
            }
            catch (Exception ex) { logger.LogTrace(ex, "Skipping drive"); }
        }
        return drives;
    }

    private static string? ParentOf(string path)
    {
        try { return Directory.GetParent(path)?.FullName; }
        catch { return null; }
    }
}

public record BrowseEntry(string Name, string Path);

public record BrowseResult(
    string? Path,
    string? Parent,
    IReadOnlyList<BrowseEntry> Directories,
    IReadOnlyList<BrowseEntry> Drives,
    string? Error);
