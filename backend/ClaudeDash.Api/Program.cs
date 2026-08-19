using ClaudeDash.Api.Hubs;
using ClaudeDash.Api.Services;

// If the backend was started from inside a Claude Code session (e.g. restarted
// during development), that session's tool-shell environment leaks into ours and
// gets inherited by every claude.exe we spawn via ConPTY:
//   - CLAUDECODE / CLAUDE_CODE_* / CLAUDE_PID → child thinks it's a nested session
//     and DISABLES transcript persistence
//   - NO_COLOR / CLICOLOR / FORCE_COLOR → the TUI renders monochrome
//   - GIT_TERMINAL_PROMPT=0 → git in spawned terminals fails instead of prompting
// Strip them before anything can spawn.
string[] exactPoison = ["CLAUDECODE", "CLAUDE_PID", "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR", "GIT_TERMINAL_PROMPT"];
foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables())
{
    var key = (string)e.Key;
    if (exactPoison.Contains(key, StringComparer.OrdinalIgnoreCase)
        || key.StartsWith("CLAUDE_CODE_", StringComparison.OrdinalIgnoreCase))
    {
        Environment.SetEnvironmentVariable(key, null);
    }
}
// ConPTY supports 24-bit color; advertise it like Windows Terminal does.
Environment.SetEnvironmentVariable("COLORTERM", "truecolor");

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<ClaudeDataService>();
builder.Services.AddSingleton<JiraService>();
builder.Services.AddSingleton<PtySessionManager>();
builder.Services.AddSingleton<FolderPickerService>();
builder.Services.AddSingleton<TerminalService>();
builder.Services.AddSingleton<GitService>();
builder.Services.AddSingleton<GitHubService>();
builder.Services.AddHttpClient();
builder.Services.AddHostedService<FileWatcherService>();
builder.Services.AddSignalR();
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .SetIsOriginAllowed(_ => true)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

var app = builder.Build();
app.UseCors();
app.UseWebSockets();

app.MapGet("/api/health", (ClaudeDataService d, JiraService j, IConfiguration cfg) => Results.Ok(new
{
    status = "ok",
    claudeHome = d.ClaudeHome,
    projectsExist = Directory.Exists(d.ProjectsDir),
    sessionsExist = Directory.Exists(d.SessionsDir),
    jiraConfigured = j.IsConfigured,
    // Workflow-specific, so it lives in config (Jira__StatusLadder / JIRA_STATUS_LADDER).
    jiraStatusLadder = (cfg["Jira:StatusLadder"] ?? "")
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
    terminalEnabled = true,
    serverTime = DateTime.UtcNow,
}));

// Native folder picker. The browser cannot hand back an absolute path, and the backend runs
// on the same machine as the UI, so it opens the real dialog. Returns null path on cancel.
app.MapPost("/api/pick-folder", async (FolderPickerService picker, string? start, CancellationToken ct) =>
{
    var picked = await picker.PickAsync(string.IsNullOrWhiteSpace(start) ? null : start, ct);
    return Results.Ok(new { path = picked });
});

// Scratch pad: a dedicated cwd for the always-on popup terminal. Its sessions are
// filtered out of the session list by the frontend so "small talk" doesn't pollute it.
app.MapGet("/api/scratch", () =>
{
    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    var cwd = Path.Combine(home, "claudedash-scratch");
    Directory.CreateDirectory(cwd);
    return Results.Ok(new { cwd, workspaceId = ClaudeDataService.EncodeWorkspaceId(cwd) });
});

app.MapGet("/api/workspaces", (ClaudeDataService d) => Results.Ok(d.ListWorkspaces()));
app.MapGet("/api/sessions", (ClaudeDataService d, int? limit) =>
    Results.Ok(d.ListAllSessions(limit ?? 500)));
app.MapGet("/api/workspaces/{id}/sessions", (string id, ClaudeDataService d) =>
    Results.Ok(d.ListSessions(id)));
app.MapGet("/api/workspaces/{id}/sessions/{sid}/transcript",
    (string id, string sid, int? limit, ClaudeDataService d) =>
        Results.Ok(d.ReadTranscript(id, sid, limit ?? 500)));
app.MapGet("/api/live", (ClaudeDataService d) => Results.Ok(d.LoadLiveSessions()));

app.MapGet("/api/jira/issue/{key}", async (string key, JiraService j, CancellationToken ct) =>
{
    var d = await j.GetIssueAsync(key, ct);
    return d is null ? Results.NotFound() : Results.Ok(d);
});

app.MapPost("/api/jira/issue/{key}/transition", async (
    string key,
    ClaudeDash.Api.Models.JiraTransitionRequest req,
    JiraService j,
    CancellationToken ct) =>
{
    var (ok, error) = await j.TransitionAsync(key, req.Status, req.ClearAssignee, ct);
    return ok
        ? Results.Ok(new { ok = true, warning = error })
        : Results.BadRequest(new { ok = false, error });
});

app.MapGet("/api/workspaces/{ws}/sessions/{sid}/changes",
    async (string ws, string sid, string? baseRef, bool? ignoreWhitespace,
        ClaudeDataService d, GitService git, CancellationToken ct) =>
{
    var sessions = d.ListSessions(ws);
    var cwd = sessions.FirstOrDefault(s => s.SessionId == sid)?.Cwd
          ?? sessions.FirstOrDefault()?.Cwd;
    if (cwd is null) return Results.BadRequest(new { error = "session not found" });
    var touched = d.GetTouchedFilePaths(ws, sid);
    var res = await git.GetMultiChangesAsync(cwd, touched, baseRef, ignoreWhitespace ?? false, ct);
    return Results.Ok(res);
});

app.MapGet("/api/workspaces/{ws}/sessions/{sid}/changes/file",
    async (string ws, string sid, string path, string? repo, string? baseRef, bool? ignoreWhitespace,
        ClaudeDataService d, GitService git, CancellationToken ct) =>
{
    var sessions = d.ListSessions(ws);
    var cwd = sessions.FirstOrDefault(s => s.SessionId == sid)?.Cwd
          ?? sessions.FirstOrDefault()?.Cwd;
    if (cwd is null) return Results.BadRequest(new { error = "session not found" });
    // Multi-repo workspaces pass the repo root the file belongs to.
    if (!string.IsNullOrWhiteSpace(repo))
    {
        if (!GitService.IsRepoRoot(repo))
            return Results.BadRequest(new { error = $"not a git repo: {repo}" });
        cwd = repo;
    }
    var diff = await git.GetFileDiffAsync(cwd, baseRef, path, ignoreWhitespace ?? false, ct);
    return diff is null ? Results.NotFound() : Results.Text(diff, "text/plain");
});

app.MapGet("/api/workspaces/{ws}/sessions/{sid}/pr",
    async (string ws, string sid, ClaudeDataService d, GitHubService gh, CancellationToken ct) =>
{
    var sessions = d.ListSessions(ws);
    var cwd = sessions.FirstOrDefault(s => s.SessionId == sid)?.Cwd
          ?? sessions.FirstOrDefault()?.Cwd;
    if (cwd is null) return Results.Ok((object?)null);
    var pr = await gh.GetCurrentPrAsync(cwd, ct);
    if (pr is null) return Results.Ok((object?)null);
    // Flatten gh's nested fields a bit so the frontend doesn't have to dig.
    var el = pr.Value;
    string? Get(string name) => el.TryGetProperty(name, out var v)
        && (v.ValueKind == System.Text.Json.JsonValueKind.String) ? v.GetString() : null;
    string? authorLogin = el.TryGetProperty("author", out var au)
        && au.ValueKind == System.Text.Json.JsonValueKind.Object
        && au.TryGetProperty("login", out var lg) ? lg.GetString() : null;
    string? checksStatus = null;
    if (el.TryGetProperty("statusCheckRollup", out var checks)
        && checks.ValueKind == System.Text.Json.JsonValueKind.Array && checks.GetArrayLength() > 0)
    {
        // Reduce per-check states to a summary: PASS | PENDING | FAIL.
        bool anyFail = false, anyPending = false;
        foreach (var c in checks.EnumerateArray())
        {
            var conclusion = c.TryGetProperty("conclusion", out var cn) ? cn.GetString() ?? "" : "";
            var status = c.TryGetProperty("status", out var st) ? st.GetString() ?? "" : "";
            if (conclusion is "FAILURE" or "CANCELLED" or "TIMED_OUT" or "ACTION_REQUIRED") anyFail = true;
            else if (status is "IN_PROGRESS" or "QUEUED" or "PENDING" || string.IsNullOrEmpty(conclusion)) anyPending = true;
        }
        checksStatus = anyFail ? "FAILING" : anyPending ? "PENDING" : "PASSING";
    }
    return Results.Ok(new
    {
        number = el.TryGetProperty("number", out var n) ? n.GetInt32() : 0,
        title = Get("title") ?? "",
        state = Get("state") ?? "",
        url = Get("url") ?? "",
        isDraft = el.TryGetProperty("isDraft", out var dr) && dr.ValueKind == System.Text.Json.JsonValueKind.True,
        author = authorLogin,
        baseRefName = Get("baseRefName"),
        headRefName = Get("headRefName"),
        body = Get("body"),
        updatedAt = Get("updatedAt"),
        mergeable = Get("mergeable"),
        checksStatus,
    });
});

// Terminals that are alive on the backend right now. PTYs outlive the browser, so the
// frontend calls this on load to reattach to whatever is still running.
app.MapGet("/api/terminals", (PtySessionManager m) => Results.Ok(m.List().Select(s => new
{
    key = s.Key,
    workspaceId = s.WorkspaceId,
    sessionId = s.SessionId,
    mode = s.Mode,
    cwd = s.Cwd,
    commandLine = s.CommandLine,
    startedAt = s.StartedAtUtc,
    pid = s.Pid,
    attached = s.AttachedCount,
    exited = s.Exited,
})));

// Re-key a session when the frontend promotes a launch-placeholder key to the real
// sessionId-keyed one, so both sides keep matching keys.
app.MapPost("/api/terminals/rename", (string from, string to, PtySessionManager m) =>
    m.Rename(from, to) ? Results.Ok(new { renamed = true }) : Results.NotFound(new { renamed = false }));

// Explicit kill — the only thing (besides the process exiting or the backend
// restarting) that ends a PTY session.
app.MapDelete("/api/terminals", (string key, PtySessionManager m) =>
    m.Kill(key) ? Results.Ok(new { killed = true }) : Results.NotFound(new { killed = false }));

app.Map("/ws/terminal", async (HttpContext ctx, TerminalService svc) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest)
    {
        ctx.Response.StatusCode = 400;
        await ctx.Response.WriteAsync("WebSocket required");
        return;
    }
    var workspaceId = ctx.Request.Query["workspaceId"].ToString();
    var sessionId = ctx.Request.Query["sessionId"].ToString();
    var mode = ctx.Request.Query["mode"].ToString();
    var shell = ctx.Request.Query["shell"].ToString();
    var cwd = ctx.Request.Query["cwd"].ToString();
    // The frontend's own terminal key. Sent so a reattach after a reload finds the
    // already-running PTY instead of spawning a duplicate.
    var key = ctx.Request.Query["key"].ToString();
    if (string.IsNullOrWhiteSpace(workspaceId))
    {
        ctx.Response.StatusCode = 400;
        await ctx.Response.WriteAsync("workspaceId required");
        return;
    }
    using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    await svc.BridgeAsync(ws, workspaceId, sessionId, mode, ctx.RequestAborted,
        string.IsNullOrEmpty(shell) ? null : shell,
        string.IsNullOrEmpty(cwd) ? null : cwd,
        string.IsNullOrEmpty(key) ? null : key);
});

app.MapHub<DashboardHub>("/hub");
app.Run();
