import type {
  Workspace,
  SessionSummary,
  TranscriptEntry,
  LiveSession,
  Health,
  JiraIssueDetail,
  MultiChangesResult,
  LiveTerminal,
} from "../types/api";

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${url}`);
  return r.json();
}

export const api = {
  health: () => getJson<Health>("/api/health"),
  workspaces: () => getJson<Workspace[]>("/api/workspaces"),
  allSessions: (limit = 500) => getJson<SessionSummary[]>(`/api/sessions?limit=${limit}`),
  transcript: (ws: string, sid: string, limit = 500) =>
    getJson<TranscriptEntry[]>(
      `/api/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sid)}/transcript?limit=${limit}`,
    ),
  live: () => getJson<LiveSession[]>("/api/live"),
  scratch: () => getJson<{ cwd: string; workspaceId: string }>("/api/scratch"),
  jiraIssue: (key: string) =>
    getJson<JiraIssueDetail>(`/api/jira/issue/${encodeURIComponent(key)}`),
  async jiraTransition(key: string, status: string, clearAssignee: boolean) {
    const r = await fetch(`/api/jira/issue/${encodeURIComponent(key)}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, clearAssignee }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as any).error ?? `HTTP ${r.status}`);
    return data as { ok: boolean; warning?: string };
  },

  sessionChanges: (ws: string, sid: string, opts: { baseRef?: string; ignoreWhitespace?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.baseRef) params.set("baseRef", opts.baseRef);
    if (opts.ignoreWhitespace) params.set("ignoreWhitespace", "true");
    return getJson<MultiChangesResult>(
      `/api/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sid)}/changes?${params}`,
    );
  },
  async sessionFileDiff(ws: string, sid: string, path: string,
      opts: { repo?: string; baseRef?: string; ignoreWhitespace?: boolean } = {}): Promise<string> {
    const params = new URLSearchParams({ path });
    if (opts.repo) params.set("repo", opts.repo);
    if (opts.baseRef) params.set("baseRef", opts.baseRef);
    if (opts.ignoreWhitespace) params.set("ignoreWhitespace", "true");
    const r = await fetch(
      `/api/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sid)}/changes/file?${params}`,
    );
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.text();
  },

  async sessionPr(ws: string, sid: string): Promise<unknown> {
    const r = await fetch(`/api/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sid)}/pr`);
    if (!r.ok) return null;
    const j = await r.json();
    return j; // null when no PR
  },

  terminalWsUrl(
    workspaceId: string,
    opts: { sessionId?: string; mode: "new" | "resume" | "continue"; cwd?: string; key?: string },
  ) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ workspaceId, mode: opts.mode });
    if (opts.sessionId) params.set("sessionId", opts.sessionId);
    if (opts.cwd) params.set("cwd", opts.cwd);
    // Sending our own terminal key lets the backend hand back the PTY it already has
    // under that key instead of spawning a second process.
    if (opts.key) params.set("key", opts.key);
    return `${proto}//${window.location.host}/ws/terminal?${params}`;
  },

  /**
   * Opens the host's native folder dialog (the backend runs on the same machine) and
   * resolves with the chosen absolute path, or null if the user cancelled.
   */
  async pickFolder(start?: string): Promise<string | null> {
    const qs = start ? `?start=${encodeURIComponent(start)}` : "";
    const r = await fetch(`/api/pick-folder${qs}`, { method: "POST" });
    if (!r.ok) throw new Error(`Folder picker failed (${r.status})`);
    const data = await r.json() as { path: string | null; error?: string | null };
    // A null path with no error is a plain cancel, which is not worth reporting.
    if (data.error) throw new Error(data.error);
    return data.path ?? null;
  },

  /** PTY sessions alive on the backend right now (they outlive this browser tab). */
  liveTerminals: () => getJson<LiveTerminal[]>("/api/terminals"),

  async killTerminal(key: string) {
    await fetch(`/api/terminals?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  },

  async renameTerminal(from: string, to: string) {
    await fetch(
      `/api/terminals/rename?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { method: "POST" },
    );
  },
};
