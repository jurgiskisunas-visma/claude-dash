/**
 * User-set display names for sessions. Browser-local (localStorage).
 * Not synced with Claude Code's own --name field — purely a dashboard convenience.
 */

const STORE_KEY = "claudedash:session-names";

type Names = Record<string, string>;

let cache: Names | null = null;
const listeners = new Set<() => void>();

function load(): Names {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    cache = raw ? (JSON.parse(raw) as Names) : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function save(next: Names) {
  cache = next;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
  for (const l of listeners) l();
}

export function getName(sessionId: string): string | undefined {
  const n = load()[sessionId];
  return n && n.trim() ? n : undefined;
}

export function setName(sessionId: string, name: string | null | undefined) {
  const next = { ...load() };
  if (!name || !name.trim()) delete next[sessionId];
  else next[sessionId] = name.trim();
  save(next);
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): Names {
  return load();
}

/**
 * "Pending" names keyed by workspaceId, waiting to be claimed by the first new
 * session that appears in that workspace. Used by the Jira launcher so the
 * name the user typed at session-create time follows the session once Claude
 * Code assigns its real sessionId.
 */

const PENDING_KEY = "claudedash:session-names-pending";
const PENDING_TTL_MS = 10 * 60_000;
interface Pending { name: string; createdAt: number; }
type PendingMap = Record<string, Pending>;

function loadPending(): PendingMap {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingMap) : {};
  } catch { return {}; }
}
function savePending(p: PendingMap) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export function setPendingName(workspaceId: string, name: string) {
  if (!workspaceId || !name.trim()) return;
  const next = loadPending();
  next[workspaceId] = { name: name.trim(), createdAt: Date.now() };
  savePending(next);
}

/**
 * Look for a pending name in `workspaceId`. If one exists and `sessionStartedAt`
 * is at-or-after it (or omitted), claim it: write the real session name and
 * clear the pending entry. Returns the name applied (or undefined).
 */
export function tryClaimPendingName(
  sessionId: string,
  workspaceId: string,
  sessionStartedAt?: Date,
): string | undefined {
  const pending = loadPending();
  // Drop expired entries.
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(pending)) {
    if (now - pending[k].createdAt > PENDING_TTL_MS) {
      delete pending[k];
      changed = true;
    }
  }
  const hit = pending[workspaceId];
  if (hit) {
    const startedMs = sessionStartedAt?.getTime() ?? now;
    // Allow a small clock-skew window so the pending entry can claim sessions
    // whose JSONL timestamp predates our set call by a few seconds.
    if (startedMs >= hit.createdAt - 5_000) {
      setName(sessionId, hit.name);
      delete pending[workspaceId];
      savePending(pending);
      return hit.name;
    }
  }
  if (changed) savePending(pending);
  return undefined;
}
