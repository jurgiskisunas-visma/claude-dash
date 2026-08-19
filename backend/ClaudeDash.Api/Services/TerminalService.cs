using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace ClaudeDash.Api.Services;

public sealed class TerminalService
{
    private readonly ClaudeDataService _data;
    private readonly IConfiguration _config;
    private readonly ILogger<TerminalService> _logger;
    private readonly PtySessionManager _sessions;

    public TerminalService(
        ClaudeDataService data,
        IConfiguration config,
        ILogger<TerminalService> logger,
        PtySessionManager sessions)
    {
        _data = data;
        _config = config;
        _logger = logger;
        _sessions = sessions;
    }

    public async Task BridgeAsync(
        WebSocket ws,
        string workspaceId,
        string? sessionId,
        string mode,
        CancellationToken ct,
        string? shellOverride = null,
        string? cwdOverride = null,
        string? keyOverride = null)
    {
        // The key is what makes a PTY outlive its viewer: the frontend sends the same
        // `workspaceId|sessionId|mode` key it uses locally, so a reload reattaches to the
        // already-running process instead of spawning a second one.
        var key = string.IsNullOrWhiteSpace(keyOverride)
            ? $"{workspaceId}|{sessionId ?? ""}|{mode}"
            : keyOverride;

        var existing = _sessions.Get(key);
        if (existing is { Exited: false })
        {
            await AttachAsync(ws, existing, ct);
            return;
        }

        // Caller-provided cwd wins (used when starting in a brand-new directory
        // that doesn't yet have an encoded entry under ~/.claude/projects/).
        var cwd = !string.IsNullOrWhiteSpace(cwdOverride)
            ? cwdOverride
            : ResolveCwd(workspaceId);
        if (string.IsNullOrWhiteSpace(cwd) || !Directory.Exists(cwd))
        {
            await SendTextAsync(ws,
                $"\r\n\x1b[31mWorking directory does not exist on host:\x1b[0m {cwd}\r\n", ct);
            await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "no cwd", ct);
            return;
        }

        // `claude --continue` fails when the workspace has no transcript yet, so the
        // first ever scratch-pad launch falls back to a plain fresh session.
        if (mode == "continue")
        {
            var projDir = Path.Combine(_data.ProjectsDir, workspaceId);
            var hasHistory = Directory.Exists(projDir)
                && Directory.EnumerateFiles(projDir, "*.jsonl").Any();
            if (!hasHistory) mode = "new";
        }

        if (mode == "resume" && !string.IsNullOrWhiteSpace(sessionId))
        {
            var live = _data.LoadLiveSessions().Any(l => l.SessionId == sessionId);
            if (live)
            {
                await SendTextAsync(ws,
                    "\r\n\x1b[33m[ClaudeDash] This session is currently live (locked by another claude process).\r\n" +
                    "`claude --resume` will refuse to attach to it. Use a Fresh terminal instead.\x1b[0m\r\n", ct);
            }
        }

        var commandLine = shellOverride switch
        {
            "cmd" => "cmd.exe",
            "pwsh" => "pwsh.exe -NoLogo",
            "ps" => "powershell.exe -NoLogo",
            _ => BuildCommandLine(mode, sessionId),
        };

        PtySession session;
        try
        {
            session = _sessions.GetOrCreate(key, () =>
                new PtySession(key, workspaceId, sessionId, mode, cwd!, commandLine, 140, 36, _logger));
            _logger.LogInformation("PTY session started: {Key} -> {Cmd} (cwd={Cwd}, pid={Pid})",
                key, commandLine, cwd, session.Pid);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to spawn ConPTY: {Cmd} (cwd={Cwd})", commandLine, cwd);
            await SendTextAsync(ws,
                $"\r\n\x1b[31mFailed to spawn:\x1b[0m {ex.Message}\r\nTried: {commandLine}\r\n", ct);
            await ws.CloseAsync(WebSocketCloseStatus.InternalServerError, "spawn failed", ct);
            return;
        }

        // The banner shows the executable's name, not its resolved path: that path runs through
        // the user's profile directory, and this line lands in every terminal screenshot.
        await SendTextAsync(ws, $"\x1b[2m[ClaudeDash] {ShortCommand(commandLine)}  in  {cwd}\x1b[0m\r\n", ct);
        await AttachAsync(ws, session, ct);
    }

    /// <summary>
    /// Pipes one WebSocket viewer to a running <see cref="PtySession"/>: replay first,
    /// then live output, with input flowing back. Returning from here detaches the viewer
    /// only - the PTY keeps running for the next attach.
    /// </summary>
    private async Task AttachAsync(WebSocket ws, PtySession session, CancellationToken ct)
    {
        var (replay, reader, lease) = session.Attach();
        using var _ = lease;

        var sendLock = new SemaphoreSlim(1, 1);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);

        if (replay.Length > 0)
        {
            await sendLock.WaitAsync(ct);
            try { await SendBinaryAsync(ws, replay, ct); }
            finally { sendLock.Release(); }
        }

        // PTY -> WebSocket
        var pumpOut = Task.Run(async () =>
        {
            try
            {
                await foreach (var chunk in reader.ReadAllAsync(stop.Token))
                {
                    await sendLock.WaitAsync(stop.Token);
                    try
                    {
                        if (ws.State != WebSocketState.Open) break;
                        await SendBinaryAsync(ws, chunk, stop.Token);
                    }
                    finally { sendLock.Release(); }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "pty->ws ended for {Key}", session.Key);
            }
        }, CancellationToken.None);

        // WebSocket -> PTY
        try
        {
            var inBuf = new byte[4096];
            while (!stop.IsCancellationRequested && ws.State == WebSocketState.Open)
            {
                var recvTask = ws.ReceiveAsync(new ArraySegment<byte>(inBuf), stop.Token);
                var completed = await Task.WhenAny(recvTask, pumpOut);
                if (completed == pumpOut) break;

                var res = await recvTask;
                if (res.MessageType == WebSocketMessageType.Close) break;
                var text = Encoding.UTF8.GetString(inBuf, 0, res.Count);
                if (res.MessageType == WebSocketMessageType.Text
                    && text.StartsWith('{') && TryHandleControl(text, session)) continue;
                await session.WriteAsync(inBuf.AsMemory(0, res.Count), stop.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { _logger.LogDebug(ex, "ws->pty ended for {Key}", session.Key); }
        finally
        {
            stop.Cancel();
            try { await pumpOut; } catch { }
            if (ws.State == WebSocketState.Open)
            {
                if (session.Exited)
                {
                    await SendTextAsync(ws,
                        "\r\n\x1b[2m[ClaudeDash] session ended\x1b[0m\r\n",
                        CancellationToken.None);
                }
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "detached", CancellationToken.None);
            }
            // Drop the registry entry when the process is gone; a still-running PTY
            // stays put with zero viewers until it exits or is killed explicitly.
            _sessions.ReapIfExited(session.Key);
        }
    }

    /// <summary>
    /// Collapses a command line's leading (possibly quoted) executable path to its file name,
    /// keeping any arguments, so the banner never prints a path through the user's profile.
    /// </summary>
    private static string ShortCommand(string commandLine)
    {
        if (commandLine.StartsWith('"'))
        {
            var end = commandLine.IndexOf('"', 1);
            if (end > 0)
            {
                var exe = Path.GetFileName(commandLine[1..end]);
                return (exe + commandLine[(end + 1)..]).Trim();
            }
        }
        var space = commandLine.IndexOf(' ');
        return space < 0
            ? Path.GetFileName(commandLine)
            : Path.GetFileName(commandLine[..space]) + commandLine[space..];
    }

    private static async Task SendBinaryAsync(WebSocket ws, byte[] bytes, CancellationToken ct)
    {
        if (ws.State != WebSocketState.Open) return;
        await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Binary, true, ct);
    }

    private static async Task SendTextAsync(WebSocket ws, string text, CancellationToken ct)
    {
        if (ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(text);
        await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Binary, true, ct);
    }

    private static bool TryHandleControl(string json, PtySession session)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            if (r.TryGetProperty("resize", out var rs)
                && rs.TryGetProperty("cols", out var c) && rs.TryGetProperty("rows", out var rw))
            {
                session.Resize(c.GetInt32(), rw.GetInt32());
                return true;
            }
        }
        catch (JsonException) { }
        return false;
    }

    private string BuildCommandLine(string mode, string? sessionId)
    {
        var claudeCli = _config["Terminal:ClaudeCli"];
        if (string.IsNullOrWhiteSpace(claudeCli)) claudeCli = "claude";

        // Resolve to a full path so CreateProcess doesn't depend on the search path.
        var resolved = ResolveOnPath(claudeCli) ?? claudeCli;

        // "continue" resumes the newest session in the cwd — used by the scratch pad
        // popup so it always lands back in the same conversation.
        if (mode == "continue") return $"\"{resolved}\" --continue";

        return mode == "resume" && !string.IsNullOrWhiteSpace(sessionId)
            ? $"\"{resolved}\" --resume {sessionId}"
            : $"\"{resolved}\"";
    }

    private static string? ResolveOnPath(string name)
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        if (path is null) return null;
        var pathExt = (Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT").Split(';');
        foreach (var dir in path.Split(';'))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            foreach (var ext in pathExt)
            {
                var candidate = Path.Combine(dir, name + ext);
                if (File.Exists(candidate)) return candidate;
            }
            var bare = Path.Combine(dir, name);
            if (File.Exists(bare)) return bare;
        }
        return null;
    }

    private string? ResolveCwd(string workspaceId)
    {
        var sessions = _data.ListSessions(workspaceId);
        var cwdFromSession = sessions.FirstOrDefault()?.Cwd;
        if (!string.IsNullOrWhiteSpace(cwdFromSession)) return cwdFromSession;
        return Decode(workspaceId);
    }

    private static string? Decode(string id)
    {
        if (id.Length >= 3 && id[1] == '-' && id[2] == '-' && char.IsLetter(id[0]))
            return $"{char.ToUpper(id[0])}:\\" + id[3..].Replace('-', '\\');
        return null;
    }
}
