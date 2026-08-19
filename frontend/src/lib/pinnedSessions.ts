/**
 * User-pinned sessions. Browser-local (localStorage), same as session names.
 */

const STORE_KEY = "claudedash:pinned-sessions";

let cache: Set<string> | null = null;
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function load(): Set<string> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    cache = new Set(arr);
  } catch {
    cache = new Set();
  }
  snapshot = new Set(cache);
  return cache;
}

function save() {
  if (!cache) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(Array.from(cache))); } catch { /* */ }
  snapshot = new Set(cache);
  for (const l of listeners) l();
}

export function isPinned(sessionId: string): boolean {
  return load().has(sessionId);
}

export function togglePin(sessionId: string): void {
  const s = load();
  if (s.has(sessionId)) s.delete(sessionId);
  else s.add(sessionId);
  save();
}

export function setPinned(sessionId: string, pinned: boolean): void {
  const s = load();
  if (pinned) s.add(sessionId);
  else s.delete(sessionId);
  save();
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
