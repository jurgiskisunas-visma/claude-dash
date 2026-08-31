using System.Text.Json;
using System.Text.RegularExpressions;
using ClaudeDash.Api.Models;

namespace ClaudeDash.Api.Services;

public sealed partial class ClaudeDataService
{
    private static readonly Regex JiraKeyRegex = MyRegex();
    private readonly string _claudeHome;
    private readonly ILogger<ClaudeDataService> _logger;

    public ClaudeDataService(IConfiguration config, ILogger<ClaudeDataService> logger)
    {
        _claudeHome = config["ClaudeDash:ClaudeHome"]
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");
        _logger = logger;
    }

    public string ClaudeHome => _claudeHome;
    public string ProjectsDir => Path.Combine(_claudeHome, "projects");
    public string SessionsDir => Path.Combine(_claudeHome, "sessions");

    /// <summary>
    /// Encodes an absolute path the same way Claude Code names its
    /// ~/.claude/projects/&lt;dir&gt; folders: every non-alphanumeric character becomes
    /// a dash (C:\dev\my-app -> C--dev-my-app).
    /// </summary>
    public static string EncodeWorkspaceId(string path)
        => NonAlphaNumRegex().Replace(path.TrimEnd('/', '\\'), "-");

    [GeneratedRegex("[^a-zA-Z0-9]")]
    private static partial Regex NonAlphaNumRegex();

    public IReadOnlyList<Workspace> ListWorkspaces()
    {
        if (!Directory.Exists(ProjectsDir)) return [];

        return Directory.EnumerateDirectories(ProjectsDir)
            .Select(dir =>
            {
                var id = Path.GetFileName(dir);
                var sessionFiles = Directory.Exists(dir)
                    ? Directory.GetFiles(dir, "*.jsonl")
                    : [];
                var lastWrite = sessionFiles.Length == 0
                    ? Directory.GetLastWriteTimeUtc(dir)
                    : sessionFiles.Max(File.GetLastWriteTimeUtc);
                return new Workspace(
                    Id: id,
                    DisplayPath: DecodeWorkspaceId(id),
                    SessionCount: sessionFiles.Length,
                    LastActivity: lastWrite);
            })
            .OrderByDescending(w => w.LastActivity)
            .ToList();
    }

    public IReadOnlyList<SessionSummary> ListAllSessions(int limit = 500)
    {
        if (!Directory.Exists(ProjectsDir)) return [];
        var live = LoadLiveSessionMap();
        var result = new List<SessionSummary>();
        foreach (var dir in Directory.EnumerateDirectories(ProjectsDir))
        {
            var wsId = Path.GetFileName(dir);
            foreach (var file in Directory.EnumerateFiles(dir, "*.jsonl"))
            {
                var s = SummarizeSession(wsId, file, live);
                if (s is not null) result.Add(s);
            }
        }
        return result
            .OrderByDescending(s => s.LastActivity)
            .Take(limit)
            .ToList();
    }

    public IReadOnlyList<SessionSummary> ListSessions(string workspaceId)
    {
        var dir = Path.Combine(ProjectsDir, workspaceId);
        if (!Directory.Exists(dir)) return [];

        var live = LoadLiveSessionMap();

        return Directory.EnumerateFiles(dir, "*.jsonl")
            .Select(file => SummarizeSession(workspaceId, file, live))
            .Where(s => s is not null)
            .Select(s => s!)
            .OrderByDescending(s => s.LastActivity)
            .ToList();
    }

    public IReadOnlyList<TranscriptEntry> ReadTranscript(string workspaceId, string sessionId, int limit = 500)
    {
        var path = Path.Combine(ProjectsDir, workspaceId, sessionId + ".jsonl");
        if (!File.Exists(path)) return [];

        var entries = new List<TranscriptEntry>();
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            TranscriptEntry? entry = null;
            try { entry = ParseLine(line); }
            catch (JsonException) { /* skip */ }
            if (entry is not null) entries.Add(entry);
        }

        if (entries.Count > limit)
            entries = entries.Skip(entries.Count - limit).ToList();
        return entries;
    }

    private static TranscriptEntry? ParseLine(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        var type = GetString(root, "type") ?? "unknown";
        var uuid = GetString(root, "uuid") ?? Guid.NewGuid().ToString();
        var parent = GetString(root, "parentUuid");
        var subtype = GetString(root, "subtype");
        var ts = GetDateTime(root, "timestamp");
        var branch = GetString(root, "gitBranch");
        string? role = null;
        string? model = null;
        var blocks = new List<ContentBlock>();

        if (root.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.Object)
        {
            role = GetString(msg, "role");
            model = GetString(msg, "model");
            if (msg.TryGetProperty("content", out var content))
            {
                if (content.ValueKind == JsonValueKind.String)
                    blocks.Add(new ContentBlock("text", content.GetString(), null, null, null, null, false));
                else if (content.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in content.EnumerateArray())
                        blocks.Add(ParseContentBlock(item));
                }
            }
        }
        else if (type == "system")
        {
            blocks.Add(new ContentBlock("system", GetString(root, "content"), null, null, null, null, false));
        }

        return new TranscriptEntry(uuid, parent, type, subtype, ts, role, model, blocks, branch);
    }

    private static ContentBlock ParseContentBlock(JsonElement item)
    {
        var t = GetString(item, "type") ?? "unknown";
        return t switch
        {
            "text" => new ContentBlock("text", GetString(item, "text"), null, null, null, null, false),
            "thinking" => new ContentBlock("thinking", GetString(item, "thinking"), null, null, null, null, false),
            "tool_use" => new ContentBlock(
                "tool_use",
                null,
                GetString(item, "name"),
                GetString(item, "id"),
                item.TryGetProperty("input", out var inp) ? inp.GetRawText() : null,
                null,
                false),
            "tool_result" => new ContentBlock(
                "tool_result",
                null,
                null,
                GetString(item, "tool_use_id"),
                null,
                item.TryGetProperty("content", out var c) ? StringifyToolResult(c) : null,
                item.TryGetProperty("is_error", out var e) && e.ValueKind == JsonValueKind.True),
            "image" => new ContentBlock("image", "(image)", null, null, null, null, false),
            _ => new ContentBlock(t, item.GetRawText(), null, null, null, null, false),
        };
    }

    private static string StringifyToolResult(JsonElement content)
    {
        if (content.ValueKind == JsonValueKind.String) return content.GetString() ?? "";
        if (content.ValueKind == JsonValueKind.Array)
        {
            var parts = content.EnumerateArray().Select(x =>
                x.TryGetProperty("text", out var tx) && tx.ValueKind == JsonValueKind.String
                    ? tx.GetString() ?? ""
                    : x.GetRawText());
            return string.Join("\n", parts);
        }
        return content.GetRawText();
    }

    public IReadOnlyList<LiveSession> LoadLiveSessions()
    {
        if (!Directory.Exists(SessionsDir)) return [];
        var list = new List<LiveSession>();
        foreach (var file in Directory.EnumerateFiles(SessionsDir, "*.json"))
        {
            try
            {
                using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var doc = JsonDocument.Parse(stream);
                var r = doc.RootElement;
                var startedAt = r.TryGetProperty("startedAt", out var sa) && sa.ValueKind == JsonValueKind.Number
                    ? DateTimeOffset.FromUnixTimeMilliseconds(sa.GetInt64()).UtcDateTime
                    : File.GetLastWriteTimeUtc(file);
                list.Add(new LiveSession(
                    Pid: GetInt(r, "pid") ?? 0,
                    SessionId: GetString(r, "sessionId") ?? "",
                    Cwd: GetString(r, "cwd") ?? "",
                    StartedAt: startedAt,
                    Version: GetString(r, "version") ?? "",
                    Kind: GetString(r, "kind") ?? "",
                    Entrypoint: GetString(r, "entrypoint") ?? ""));
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Failed to parse live session {File}", file);
            }
        }
        return list;
    }

    /// <summary>
    /// Live sessions keyed by session id. ~/.claude/sessions can legitimately hold
    /// several pid files naming the same session (a resumed session, or a stale file
    /// left by a process that died without cleaning up), so this must never assume the
    /// ids are unique — a plain ToDictionary throws on the second one. Entries with a
    /// live process win, then the most recent start; blank ids are dropped.
    /// </summary>
    public Dictionary<string, LiveSession> LoadLiveSessionMap()
    {
        var map = new Dictionary<string, LiveSession>(StringComparer.Ordinal);
        foreach (var s in LoadLiveSessions())
        {
            if (string.IsNullOrWhiteSpace(s.SessionId)) continue;
            if (map.TryGetValue(s.SessionId, out var existing) && !Preferred(s, existing)) continue;
            map[s.SessionId] = s;
        }
        return map;

        static bool Preferred(LiveSession candidate, LiveSession existing)
        {
            var candidateAlive = IsProcessAlive(candidate.Pid);
            var existingAlive = IsProcessAlive(existing.Pid);
            if (candidateAlive != existingAlive) return candidateAlive;
            return candidate.StartedAt > existing.StartedAt;
        }
    }

    private static bool IsProcessAlive(int pid)
    {
        if (pid <= 0) return false;
        try
        {
            using var p = System.Diagnostics.Process.GetProcessById(pid);
            return !p.HasExited;
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private static readonly HashSet<string> FileEditTools =
        new(StringComparer.Ordinal) { "Edit", "Write", "MultiEdit", "NotebookEdit" };

    /// <summary>
    /// Absolute paths of files this session edited via file tools (Edit/Write/…).
    /// Used to attribute changes to repos when the session cwd is a multi-repo parent.
    /// </summary>
    public IReadOnlyList<string> GetTouchedFilePaths(string workspaceId, string sessionId)
    {
        var path = Path.Combine(ProjectsDir, workspaceId, sessionId + ".jsonl");
        if (!File.Exists(path)) return [];

        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            string? line;
            while ((line = reader.ReadLine()) is not null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                // Cheap prefilter: only assistant lines carry tool_use blocks.
                if (!line.Contains("tool_use", StringComparison.Ordinal)) continue;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var r = doc.RootElement;
                    if (GetString(r, "type") != "assistant") continue;
                    if (!r.TryGetProperty("message", out var m)
                        || !m.TryGetProperty("content", out var c)
                        || c.ValueKind != JsonValueKind.Array) continue;
                    foreach (var blk in c.EnumerateArray())
                    {
                        if (!blk.TryGetProperty("type", out var bt) || bt.GetString() != "tool_use") continue;
                        var name = GetString(blk, "name");
                        if (name is null || !FileEditTools.Contains(name)) continue;
                        if (!blk.TryGetProperty("input", out var input) || input.ValueKind != JsonValueKind.Object) continue;
                        var fp = GetString(input, "file_path") ?? GetString(input, "notebook_path");
                        if (!string.IsNullOrWhiteSpace(fp) && Path.IsPathRooted(fp))
                            paths.Add(fp);
                    }
                }
                catch (JsonException) { }
            }
        }
        catch (IOException) { }
        return paths.ToList();
    }

    private SessionSummary? SummarizeSession(string workspaceId, string filePath, IReadOnlyDictionary<string, LiveSession> live)
    {
        var sessionId = Path.GetFileNameWithoutExtension(filePath);
        DateTime? started = null;
        DateTime lastTs = File.GetLastWriteTimeUtc(filePath);
        string? color = null, permMode = null, branch = null, cwd = null, firstPrompt = null;
        int messageCount = 0;
        var jiraKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Status tracking (working / awaiting_input / done).
        string? lastAssistantStopReason = null;
        // The most recent assistant tool_use we've seen — used to detect a pending AskUserQuestion.
        string? lastToolUseName = null;
        string? lastToolUseId = null;
        // Tool_use ids that have already received a tool_result reply.
        var resolvedToolUseIds = new HashSet<string>(StringComparer.Ordinal);

        try
        {
            using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            string? line;
            while ((line = reader.ReadLine()) is not null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var r = doc.RootElement;
                    var type = GetString(r, "type");
                    if (type == "agent-color") color ??= GetString(r, "agentColor");
                    else if (type == "permission-mode") permMode ??= GetString(r, "permissionMode");
                    cwd ??= GetString(r, "cwd");
                    branch ??= GetString(r, "gitBranch");
                    var ts = GetDateTime(r, "timestamp");
                    if (ts.HasValue)
                    {
                        started ??= ts;
                        if (ts > lastTs) lastTs = ts.Value;
                    }
                    if (type is "user" or "assistant")
                    {
                        messageCount++;
                        if (r.TryGetProperty("message", out var m))
                        {
                            if (type == "user" && firstPrompt is null
                                && m.TryGetProperty("content", out var c))
                            {
                                string? raw = c.ValueKind switch
                                {
                                    JsonValueKind.String => c.GetString(),
                                    JsonValueKind.Array => c.EnumerateArray()
                                        .Where(x => x.TryGetProperty("type", out var tt) && tt.GetString() == "text")
                                        .Select(x => x.TryGetProperty("text", out var tx) ? tx.GetString() : null)
                                        .FirstOrDefault(s => !string.IsNullOrEmpty(s)),
                                    _ => null,
                                };
                                if (!string.IsNullOrEmpty(raw))
                                    firstPrompt = raw.Length > 200 ? raw[..200] + "…" : raw;
                            }
                            // Track assistant stop_reason; capture latest tool_use.
                            if (type == "assistant")
                            {
                                lastAssistantStopReason = GetString(m, "stop_reason") ?? lastAssistantStopReason;
                                if (m.TryGetProperty("content", out var ac) && ac.ValueKind == JsonValueKind.Array)
                                {
                                    foreach (var blk in ac.EnumerateArray())
                                    {
                                        if (blk.TryGetProperty("type", out var bt) && bt.GetString() == "tool_use")
                                        {
                                            lastToolUseName = GetString(blk, "name");
                                            lastToolUseId = GetString(blk, "id");
                                        }
                                    }
                                }
                            }
                            else if (type == "user")
                            {
                                // User content can include tool_result entries — note their tool_use_ids as resolved.
                                if (m.TryGetProperty("content", out var uc) && uc.ValueKind == JsonValueKind.Array)
                                {
                                    foreach (var blk in uc.EnumerateArray())
                                    {
                                        if (blk.TryGetProperty("type", out var bt) && bt.GetString() == "tool_result"
                                            && blk.TryGetProperty("tool_use_id", out var tid) && tid.ValueKind == JsonValueKind.String)
                                        {
                                            resolvedToolUseIds.Add(tid.GetString()!);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                catch (JsonException) { }
            }
        }
        catch (IOException) { return null; }

        var isLive = live.ContainsKey(sessionId);
        int? pid = isLive ? live[sessionId].Pid : null;

        var displayPath = cwd ?? DecodeWorkspaceId(workspaceId);
        var dirLabel = LeafSegment(displayPath);
        var isWorktree = displayPath.Contains("worktree", StringComparison.OrdinalIgnoreCase)
            || displayPath.Contains(".worktrees", StringComparison.OrdinalIgnoreCase);

        // collect Jira keys from cwd, branch, and first prompt
        foreach (var src in new[] { displayPath, branch, firstPrompt })
            if (!string.IsNullOrEmpty(src))
                foreach (Match m in JiraKeyRegex.Matches(src!))
                    jiraKeys.Add(m.Value.ToUpperInvariant());

        // Derive status from the last assistant turn:
        //  - awaiting_input: last tool_use was AskUserQuestion and no tool_result has arrived for it yet
        //  - done: assistant ended the turn (stop_reason == "end_turn") OR session is no longer live
        //  - working: live session mid tool loop
        // A session that isn't live (no pid file) cannot actually be running. Without this
        // guard, sessions that were killed mid-turn keep reporting "working" indefinitely.
        string status;
        bool pendingTool = lastToolUseId is not null && !resolvedToolUseIds.Contains(lastToolUseId);
        bool pendingAskQ = pendingTool && string.Equals(lastToolUseName, "AskUserQuestion", StringComparison.Ordinal);
        if (!isLive)
            status = pendingAskQ ? "awaiting_input" : "done";
        else if (pendingAskQ)
            status = "awaiting_input";
        else if (string.Equals(lastAssistantStopReason, "end_turn", StringComparison.Ordinal) && !pendingTool)
            status = "done";
        else
            status = "working";

        return new SessionSummary(
            SessionId: sessionId,
            WorkspaceId: workspaceId,
            Cwd: displayPath,
            DirLabel: dirLabel,
            StartedAt: started ?? File.GetCreationTimeUtc(filePath),
            LastActivity: lastTs,
            MessageCount: messageCount,
            AgentColor: color,
            PermissionMode: permMode,
            GitBranch: branch,
            IsWorktree: isWorktree,
            FirstUserPrompt: firstPrompt,
            IsLive: isLive,
            Pid: pid,
            JiraKeys: jiraKeys.ToList(),
            Status: status);
    }

    private static string LeafSegment(string path)
    {
        if (string.IsNullOrEmpty(path)) return "";
        var trimmed = path.TrimEnd('\\', '/');
        var idx = Math.Max(trimmed.LastIndexOf('\\'), trimmed.LastIndexOf('/'));
        return idx >= 0 ? trimmed[(idx + 1)..] : trimmed;
    }

    private static string DecodeWorkspaceId(string id)
    {
        if (id.Length >= 3 && id[1] == '-' && id[2] == '-' && char.IsLetter(id[0]))
            return $"{char.ToUpper(id[0])}:\\" + id[3..].Replace('-', '\\');
        return id.Replace('-', '/');
    }

    private static string? GetString(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int? GetInt(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;

    private static DateTime? GetDateTime(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String
        && DateTime.TryParse(v.GetString(), out var dt) ? dt.ToUniversalTime() : null;

    [GeneratedRegex(@"\b[A-Z][A-Z0-9]+-\d+\b")]
    private static partial Regex MyRegex();
}
