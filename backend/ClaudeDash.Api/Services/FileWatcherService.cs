using ClaudeDash.Api.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace ClaudeDash.Api.Services;

public sealed class FileWatcherService : BackgroundService
{
    private readonly ClaudeDataService _data;
    private readonly IHubContext<DashboardHub> _hub;
    private readonly ILogger<FileWatcherService> _logger;
    private readonly List<FileSystemWatcher> _watchers = [];

    public FileWatcherService(ClaudeDataService data,
        IHubContext<DashboardHub> hub, ILogger<FileWatcherService> logger)
    {
        _data = data;
        _hub = hub;
        _logger = logger;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        TryWatch(_data.ProjectsDir, "session", true);
        TryWatch(_data.SessionsDir, "live", false);
        _logger.LogInformation("FileWatchers active on {Home}", _data.ClaudeHome);
        return Task.CompletedTask;
    }

    private void TryWatch(string path, string kind, bool recurse)
    {
        if (!Directory.Exists(path))
        {
            _logger.LogWarning("Watcher path missing: {Path}", path);
            return;
        }
        var w = new FileSystemWatcher(path)
        {
            IncludeSubdirectories = recurse,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.DirectoryName,
            EnableRaisingEvents = true,
        };
        w.Changed += (_, e) => Push(kind, e.FullPath);
        w.Created += (_, e) => Push(kind, e.FullPath);
        w.Deleted += (_, e) => Push(kind, e.FullPath);
        w.Renamed += (_, e) => Push(kind, e.FullPath);
        w.Error += (_, e) => _logger.LogWarning(e.GetException(), "Watcher error on {Path}", path);
        _watchers.Add(w);
    }

    private void Push(string kind, string fullPath)
    {
        try
        {
            string? workspaceId = null, sessionId = null;
            if (kind == "session")
            {
                var rel = Path.GetRelativePath(_data.ProjectsDir, fullPath);
                var parts = rel.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (parts.Length >= 1) workspaceId = parts[0];
                if (parts.Length >= 2 && parts[1].EndsWith(".jsonl"))
                    sessionId = Path.GetFileNameWithoutExtension(parts[1]);
            }
            var evt = new ChangeEvent(kind, workspaceId, sessionId, DateTime.UtcNow);
            _ = _hub.Clients.All.SendAsync("change", evt);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Push failed");
        }
    }

    public override void Dispose()
    {
        foreach (var w in _watchers) w.Dispose();
        base.Dispose();
    }
}
