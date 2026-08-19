/**
 * The directories you actually start sessions in, most recent first. Browser-local, capped
 * at ten — long enough to cover a normal rotation of projects, short enough that the
 * capsules stay scannable.
 */

const STORE_KEY = "claudedash:recent-cwds";
const MAX = 10;

let cache: string[] | null = null;
const listeners = new Set<() => void>();
let snapshot: readonly string[] = [];

function normalize(p: string): string {
  return p.trim().replace(/[\\/]+$/, "");
}

function load(): string[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    cache = Array.isArray(arr) ? arr.filter((p) => typeof p === "string") : [];
  } catch {
    cache = [];
  }
  snapshot = [...cache];
  return cache;
}

function persist() {
  if (!cache) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cache)); } catch { /* */ }
  snapshot = [...cache];
  for (const l of listeners) l();
}

/** Records a directory as most-recently-used (case-insensitive de-dupe). */
export function rememberPath(path: string): void {
  const p = normalize(path);
  if (!p) return;
  const list = load();
  const idx = list.findIndex((x) => x.toLowerCase() === p.toLowerCase());
  if (idx !== -1) list.splice(idx, 1);
  list.unshift(p);
  if (list.length > MAX) list.length = MAX;
  persist();
}

export function forgetPath(path: string): void {
  const p = normalize(path).toLowerCase();
  const list = load();
  const idx = list.findIndex((x) => x.toLowerCase() === p);
  if (idx === -1) return;
  list.splice(idx, 1);
  persist();
}

export function subscribeRecentPaths(cb: () => void): () => void {
  load();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getRecentPaths(): readonly string[] {
  load();
  return snapshot;
}
