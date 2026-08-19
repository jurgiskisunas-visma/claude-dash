/**
 * Module-level store of live terminal WebSockets keyed by (workspaceId|sessionId|mode).
 * Survives React unmounts so switching the selected session doesn't kill running PTYs.
 *
 * Each entry buffers recent PTY output so a newly-mounted xterm can replay history
 * and pick up live updates seamlessly.
 *
 * The PTY itself lives on the backend under the same key (see PtySessionManager), so a
 * closed tab or a reload is only a detach: `restoreFromServer()` re-opens sockets for
 * everything still running, and killing a terminal is an explicit DELETE — never a side
 * effect of the socket going away.
 */

import { api } from "./api/client";

export type TermKey = string;

interface Entry {
  key: TermKey;
  ws: WebSocket;
  buffer: Uint8Array[];     // capped FIFO
  bufferBytes: number;
  listeners: Set<(data: Uint8Array) => void>;
  statusListeners: Set<(s: TermStatus) => void>;
  status: TermStatus;
}

export type TermStatus = "connecting" | "open" | "closed" | "error";

const MAX_BUFFER_BYTES = 256 * 1024;

const entries = new Map<TermKey, Entry>();
let restoring = true;
const restoreListeners = new Set<() => void>();
const globalListeners = new Set<() => void>();
let keysSnapshot: TermKey[] = [];

export type TermMode = "new" | "resume" | "continue";

export function makeKey(workspaceId: string, sessionId: string | undefined, mode: TermMode): TermKey {
  return `${workspaceId}|${sessionId ?? ""}|${mode}`;
}

// Returns a stable reference between mutations — required by useSyncExternalStore.
export function listKeys(): TermKey[] {
  return keysSnapshot;
}

export function getStatus(key: TermKey): TermStatus | null {
  return entries.get(key)?.status ?? null;
}

export function ensureTerminal(
  key: TermKey,
  url: string,
  opts?: { pendingInput?: string; pendingDelayMs?: number },
): Entry {
  const existing = entries.get(key);
  if (existing) return existing;

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const entry: Entry = {
    key,
    ws,
    buffer: [],
    bufferBytes: 0,
    listeners: new Set(),
    statusListeners: new Set(),
    status: "connecting",
  };
  entries.set(key, entry);
  notifyGlobal();

  let pending = opts?.pendingInput ?? null;
  const delayMs = opts?.pendingDelayMs ?? 3000;
  let sawData = false;

  function maybeSendPending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    // Write character-by-character so claude's TUI input handler treats it like typed input.
    setTimeout(() => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(p + "\r"); } catch { /* */ }
    }, delayMs);
  }

  ws.onopen = () => setStatus(entry, "open");
  ws.onclose = () => setStatus(entry, "closed");
  ws.onerror = () => setStatus(entry, "error");
  ws.onmessage = (ev) => {
    let bytes: Uint8Array;
    if (typeof ev.data === "string") {
      bytes = new TextEncoder().encode(ev.data);
    } else {
      bytes = new Uint8Array(ev.data as ArrayBuffer);
    }
    appendToBuffer(entry, bytes);
    for (const l of entry.listeners) l(bytes);
    if (!sawData) { sawData = true; maybeSendPending(); }
  };
  return entry;
}

function appendToBuffer(entry: Entry, bytes: Uint8Array) {
  entry.buffer.push(bytes);
  entry.bufferBytes += bytes.byteLength;
  while (entry.bufferBytes > MAX_BUFFER_BYTES && entry.buffer.length > 1) {
    const head = entry.buffer.shift()!;
    entry.bufferBytes -= head.byteLength;
  }
}

function setStatus(entry: Entry, status: TermStatus) {
  entry.status = status;
  for (const l of entry.statusListeners) l(status);
  notifyGlobal();
}

export interface Subscription {
  /** Concatenated replay of all buffered output up to the moment of subscription. */
  replay: Uint8Array;
  /** Send input bytes/text to the PTY. */
  send: (data: string | ArrayBufferLike) => void;
  /** Send a JSON control message (e.g. resize). */
  control: (msg: object) => void;
  /** Unsubscribe (does NOT close the WS). */
  unsubscribe: () => void;
  /** Current status snapshot. */
  status: TermStatus;
}

export function subscribe(
  key: TermKey,
  onData: (data: Uint8Array) => void,
  onStatus?: (s: TermStatus) => void,
): Subscription | null {
  const entry = entries.get(key);
  if (!entry) return null;

  // Build replay buffer (concat all chunks).
  let replayLen = entry.bufferBytes;
  const replay = new Uint8Array(replayLen);
  let off = 0;
  for (const chunk of entry.buffer) {
    replay.set(chunk, off);
    off += chunk.byteLength;
  }
  entry.listeners.add(onData);
  if (onStatus) entry.statusListeners.add(onStatus);

  return {
    replay,
    status: entry.status,
    send: (data) => {
      if (entry.ws.readyState !== WebSocket.OPEN) return;
      entry.ws.send(data as any);
    },
    control: (msg) => {
      if (entry.ws.readyState !== WebSocket.OPEN) return;
      entry.ws.send(JSON.stringify(msg));
    },
    unsubscribe: () => {
      entry.listeners.delete(onData);
      if (onStatus) entry.statusListeners.delete(onStatus);
    },
  };
}

/**
 * Move an existing entry to a new key. Used when a "new" terminal launched with
 * a placeholder key (e.g. `ws|launch-1234|new`) gets promoted to a real
 * sessionId-keyed entry (`ws|<sessionId>|new`) so SessionDetail can find it.
 * No-op if oldKey is missing or newKey already exists.
 */
export function renameTerminal(oldKey: TermKey, newKey: TermKey) {
  if (oldKey === newKey) return;
  const entry = entries.get(oldKey);
  if (!entry) return;
  if (entries.has(newKey)) return;
  // Keep the backend's key in sync, otherwise the next reattach wouldn't find it.
  void api.renameTerminal(oldKey, newKey).catch(() => { /* best effort */ });
  entries.delete(oldKey);
  entry.key = newKey;
  entries.set(newKey, entry);
  notifyGlobal();
}

/** True if any entry exists whose key matches workspaceId + given mode. */
export function hasModeInWorkspace(workspaceId: string, mode: "new" | "resume"): boolean {
  const prefix = `${workspaceId}|`;
  const suffix = `|${mode}`;
  for (const k of entries.keys()) {
    if (k.startsWith(prefix) && (k.endsWith(suffix) || k.includes(`${suffix}:`))) return true;
  }
  return false;
}

/**
 * Kills the PTY on the backend and drops the local entry. This is the only way a
 * terminal ends from the UI — closing the socket alone leaves it running.
 */
export function destroyTerminal(key: TermKey) {
  void api.killTerminal(key).catch(() => { /* backend may already have reaped it */ });
  const entry = entries.get(key);
  if (!entry) return;
  try { entry.ws.close(); } catch { /* */ }
  entries.delete(key);
  notifyGlobal();
}

/**
 * Re-opens a socket for every PTY the backend still has running. Called once on app
 * load, so reopening the dashboard picks the terminals back up where they were.
 * Returns the keys that were restored.
 */
export async function restoreFromServer(): Promise<TermKey[]> {
  let live;
  try {
    live = await api.liveTerminals();
  } catch {
    setRestoring(false);
    return [];
  }
  const restored: TermKey[] = [];
  for (const t of live) {
    if (t.exited || entries.has(t.key)) continue;
    const url = api.terminalWsUrl(t.workspaceId, {
      sessionId: t.sessionId ?? undefined,
      mode: (t.mode as TermMode) ?? "resume",
      cwd: t.cwd,
      key: t.key,
    });
    ensureTerminal(t.key, url);
    restored.push(t.key);
  }
  setRestoring(false);
  return restored;
}

/**
 * True until the first restoreFromServer() settles. The UI uses it to say
 * "reconnecting" instead of offering a launch button for a terminal that is about to
 * come back on its own.
 */
export function isRestoring(): boolean {
  return restoring;
}

export function subscribeRestoring(cb: () => void): () => void {
  restoreListeners.add(cb);
  return () => restoreListeners.delete(cb);
}

function setRestoring(v: boolean) {
  if (restoring === v) return;
  restoring = v;
  for (const l of restoreListeners) l();
}

export function subscribeToList(cb: () => void): () => void {
  globalListeners.add(cb);
  return () => globalListeners.delete(cb);
}

function notifyGlobal() {
  keysSnapshot = Array.from(entries.keys());
  for (const l of globalListeners) l();
}
