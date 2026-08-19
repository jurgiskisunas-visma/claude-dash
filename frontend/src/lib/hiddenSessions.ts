/**
 * UI-only "hide from session list" filter. Browser-local (localStorage).
 * The JSONL on disk is untouched — the session can be unhidden at any time
 * from the "Show hidden" toggle in the session list.
 */

const STORE_KEY = "claudedash:hidden-sessions";
let cache: Set<string> | null = null;
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function load(): Set<string> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    cache = new Set(arr);
  } catch {
    cache = new Set();
  }
  snapshot = new Set(cache);
  return cache!;
}

function persist() {
  if (!cache) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(Array.from(cache))); } catch { /* */ }
  snapshot = new Set(cache);
  for (const l of listeners) l();
}

export function hideSession(sessionId: string) {
  load().add(sessionId);
  persist();
}

export function unhideSession(sessionId: string) {
  load().delete(sessionId);
  persist();
}

export function isHidden(sessionId: string): boolean {
  return load().has(sessionId);
}

export function subscribe(cb: () => void): () => void {
  load();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): ReadonlySet<string> {
  load();
  return snapshot;
}
