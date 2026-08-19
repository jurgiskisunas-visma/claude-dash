using System.Collections.Concurrent;
using System.Threading.Channels;

namespace ClaudeDash.Api.Services;

/// <summary>
/// Server-side registry of long-lived PTY sessions, keyed the same way the frontend
/// keys them (<c>workspaceId|sessionId|mode</c>).
///
/// The point of this class is lifetime: a PTY belongs to the *backend*, not to the
/// browser WebSocket that happens to be looking at it. Closing the tab, reloading, or
/// losing the socket only detaches a viewer — the claude process keeps running and the
/// next attach replays the recent output and picks up live.
///
/// Sessions end only when the child process exits or the user explicitly kills them
/// (DELETE /api/terminals). Restarting the backend still takes every PTY down with it —
/// the pseudo-console handles die with the process.
/// </summary>
public sealed class PtySessionManager : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, PtySession> _sessions = new();

    public IReadOnlyList<PtySession> List() => _sessions.Values
        .OrderBy(s => s.StartedAtUtc)
        .ToList();

    public PtySession? Get(string key) => _sessions.TryGetValue(key, out var s) ? s : null;

    /// <summary>
    /// Returns the live session for <paramref name="key"/>, or creates one via
    /// <paramref name="factory"/>. An entry whose process already exited is replaced.
    /// </summary>
    public PtySession GetOrCreate(string key, Func<PtySession> factory)
    {
        while (true)
        {
            if (_sessions.TryGetValue(key, out var existing))
            {
                if (!existing.Exited) return existing;
                _sessions.TryRemove(new KeyValuePair<string, PtySession>(key, existing));
                existing.Dispose();
            }

            var created = factory();
            if (_sessions.TryAdd(key, created)) return created;
            // Lost a race — throw ours away and re-read.
            created.Dispose();
        }
    }

    /// <summary>
    /// Re-keys a session. Used when a "+ New session" terminal launched under a
    /// placeholder key gets promoted to its real sessionId-keyed name, so the server and
    /// the browser keep agreeing on keys (which is what makes reattach work).
    /// </summary>
    public bool Rename(string from, string to)
    {
        if (from == to) return true;
        if (_sessions.ContainsKey(to)) return false;
        if (!_sessions.TryRemove(from, out var s)) return false;
        s.Rekey(to);
        return _sessions.TryAdd(to, s);
    }

    public bool Kill(string key)
    {
        if (!_sessions.TryRemove(key, out var s)) return false;
        s.Dispose();
        return true;
    }

    /// <summary>Drops the entry if its process is gone. Called after a viewer detaches.</summary>
    public void ReapIfExited(string key)
    {
        if (_sessions.TryGetValue(key, out var s) && s.Exited)
        {
            _sessions.TryRemove(new KeyValuePair<string, PtySession>(key, s));
            s.Dispose();
        }
    }

    public ValueTask DisposeAsync()
    {
        foreach (var key in _sessions.Keys.ToList()) Kill(key);
        return ValueTask.CompletedTask;
    }
}

/// <summary>
/// One running PTY plus its output history and its set of attached viewers.
/// A single pump task drains the pseudo-console into the replay buffer and fans the
/// bytes out to every viewer channel, so output keeps flowing (and keeps being
/// recorded) even while nothing is attached.
/// </summary>
public sealed class PtySession : IDisposable
{
    private const int MaxBufferBytes = 512 * 1024;

    public string Key { get; private set; }
    public string WorkspaceId { get; }
    public string? SessionId { get; }
    public string Mode { get; }
    public string Cwd { get; }
    public string CommandLine { get; }
    public DateTime StartedAtUtc { get; } = DateTime.UtcNow;
    public int Pid { get; }

    public bool Exited { get; private set; }
    public int? ExitCode { get; private set; }
    public int AttachedCount { get { lock (_gate) return _viewers.Count; } }
    public int Cols { get; private set; }
    public int Rows { get; private set; }

    private readonly ConPtyConnection _pty;
    private readonly ILogger _logger;
    private readonly object _gate = new();
    private readonly List<Channel<byte[]>> _viewers = [];
    private readonly Queue<byte[]> _buffer = new();
    private int _bufferBytes;
    private readonly CancellationTokenSource _cts = new();
    private bool _disposed;

    public PtySession(
        string key,
        string workspaceId,
        string? sessionId,
        string mode,
        string cwd,
        string commandLine,
        int cols,
        int rows,
        ILogger logger)
    {
        Key = key;
        WorkspaceId = workspaceId;
        SessionId = sessionId;
        Mode = mode;
        Cwd = cwd;
        CommandLine = commandLine;
        Cols = cols;
        Rows = rows;
        _logger = logger;

        _pty = new ConPtyConnection(commandLine, cols, rows, cwd);
        Pid = _pty.Process.Id;
        _pty.Exited += (_, _) => MarkExited();

        _ = Task.Run(PumpAsync);
    }

    private async Task PumpAsync()
    {
        var buf = new byte[4096];
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                int n = await _pty.Output.ReadAsync(buf.AsMemory(), _cts.Token);
                if (n <= 0) break;
                var chunk = buf[..n];
                lock (_gate)
                {
                    Append(chunk);
                    foreach (var v in _viewers) v.Writer.TryWrite(chunk);
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "pty pump ended for {Key}", Key);
        }
        finally
        {
            MarkExited();
        }
    }

    private void Append(byte[] chunk)
    {
        _buffer.Enqueue(chunk);
        _bufferBytes += chunk.Length;
        while (_bufferBytes > MaxBufferBytes && _buffer.Count > 1)
            _bufferBytes -= _buffer.Dequeue().Length;
    }

    private void MarkExited()
    {
        lock (_gate)
        {
            if (Exited) return;
            Exited = true;
            try { ExitCode = _pty.Process.HasExited ? _pty.Process.ExitCode : null; } catch { }
            foreach (var v in _viewers) v.Writer.TryComplete();
        }
        _logger.LogInformation("PTY session ended: {Key} (pid={Pid}, code={Code})", Key, Pid, ExitCode);
    }

    /// <summary>
    /// Attaches a viewer. The returned replay is everything buffered up to this instant;
    /// the reader carries every chunk after it, with no gap and no duplication (both are
    /// taken under the same lock the pump writes under).
    /// </summary>
    public (byte[] Replay, ChannelReader<byte[]> Reader, IDisposable Lease) Attach()
    {
        var channel = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });

        byte[] replay;
        lock (_gate)
        {
            replay = new byte[_bufferBytes];
            int off = 0;
            foreach (var chunk in _buffer)
            {
                chunk.CopyTo(replay, off);
                off += chunk.Length;
            }
            _viewers.Add(channel);
            if (Exited) channel.Writer.TryComplete();
        }

        return (replay, channel.Reader, new Lease(this, channel));
    }

    private void Detach(Channel<byte[]> channel)
    {
        lock (_gate) _viewers.Remove(channel);
        channel.Writer.TryComplete();
    }

    private sealed class Lease(PtySession session, Channel<byte[]> channel) : IDisposable
    {
        private bool _done;
        public void Dispose()
        {
            if (_done) return;
            _done = true;
            session.Detach(channel);
        }
    }

    internal void Rekey(string key) => Key = key;

    public async Task WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        if (Exited) return;
        await _pty.Input.WriteAsync(data, ct);
        await _pty.Input.FlushAsync(ct);
    }

    public void Resize(int cols, int rows)
    {
        if (Exited || cols <= 0 || rows <= 0) return;
        // Viewers can have different window sizes; last one to resize wins, which is
        // also what happens with a real terminal being dragged around.
        Cols = cols;
        Rows = rows;
        try { _pty.Resize(cols, rows); } catch { /* console already gone */ }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _cts.Cancel(); } catch { }
        try { _pty.Dispose(); } catch { }
        MarkExited();
        _cts.Dispose();
    }
}
