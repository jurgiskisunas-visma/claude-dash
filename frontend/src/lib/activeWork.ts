/**
 * "Active work" tracker — the ordered strip of cubes in the header.
 *
 * A session enters the strip automatically (when it is live, or when the user
 * opens it) and leaves only when the user closes its cube. Closing records the
 * id in a `dismissed` set so the auto-add rule doesn't immediately bring it
 * back; re-adding it explicitly clears the dismissal.
 *
 * Browser-local (localStorage), same as pins and custom names.
 */

const STORE_KEY = "claudedash:active-work";

interface State {
  order: string[];
  dismissed: string[];
}

let cache: State | null = null;
const listeners = new Set<() => void>();
let snapshot: readonly string[] = [];

function load(): State {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<State>) : {};
    cache = {
      order: Array.isArray(parsed.order) ? parsed.order : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
    };
  } catch {
    cache = { order: [], dismissed: [] };
  }
  snapshot = [...cache.order];
  return cache;
}

function persist() {
  if (!cache) return;
  // Keep the dismissed list from growing forever — only the newest ones matter.
  if (cache.dismissed.length > 500) cache.dismissed = cache.dismissed.slice(-500);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cache)); } catch { /* */ }
  snapshot = [...cache.order];
  for (const l of listeners) l();
}

/** Append if not present and not dismissed. Returns true if it changed. */
export function trackSession(sessionId: string): boolean {
  const s = load();
  if (s.order.includes(sessionId) || s.dismissed.includes(sessionId)) return false;
  s.order.push(sessionId);
  persist();
  return true;
}

/** Append, overriding a previous dismissal (explicit user action). */
export function forceTrackSession(sessionId: string) {
  const s = load();
  s.dismissed = s.dismissed.filter((id) => id !== sessionId);
  if (!s.order.includes(sessionId)) s.order.push(sessionId);
  persist();
}

/** Close a cube: remove from the strip and remember the dismissal. */
export function untrackSession(sessionId: string) {
  const s = load();
  s.order = s.order.filter((id) => id !== sessionId);
  if (!s.dismissed.includes(sessionId)) s.dismissed.push(sessionId);
  persist();
}

export function isTracked(sessionId: string): boolean {
  return load().order.includes(sessionId);
}

export function clearTracked() {
  const s = load();
  for (const id of s.order) if (!s.dismissed.includes(id)) s.dismissed.push(id);
  s.order = [];
  persist();
}

export function subscribe(cb: () => void): () => void {
  load();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): readonly string[] {
  load();
  return snapshot;
}
