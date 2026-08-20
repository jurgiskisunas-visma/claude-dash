import type { Command } from "./commands";

/**
 * The shortcut table, and the "hint mode" store that makes the little key badges
 * legible while Alt is held.
 *
 * Two tiers, deliberately:
 *
 *   - **Bare keys** (`j`, `1`, `/`) work when you are not typing. They are ignored inside
 *     inputs and inside the terminal — xterm's helper element is a textarea, so typing in
 *     a PTY never triggers a shortcut.
 *   - **Alt + key** does the same thing and works *everywhere*, including while the
 *     terminal has focus. Handled in the capture phase and `preventDefault`ed, so xterm
 *     never sees it.
 *
 * Nothing uses Ctrl or Cmd — those belong to the browser. Alt+D/E/F/V and Alt+arrows are
 * avoided too (address bar, Chrome menus, back/forward).
 */

export interface Shortcut {
  /** Bare key as it arrives in `event.key` (lowercased for letters). */
  key: string;
  /** What to show in the UI. */
  label: string;
  command: Command;
  group: "Navigate" | "View" | "Session" | "App";
  description: string;
  /** Alternative bare keys (arrows for j/k, for example). */
  aliases?: string[];
  /** Skip the Alt+key variant (Alt+? is awkward to type). */
  noAlt?: boolean;
}

export const SHORTCUTS: Shortcut[] = [
  { key: "j", label: "J", command: "nav.next", group: "Navigate", description: "Next session", aliases: ["arrowdown"] },
  { key: "k", label: "K", command: "nav.prev", group: "Navigate", description: "Previous session", aliases: ["arrowup"] },
  { key: "/", label: "/", command: "list.search", group: "Navigate", description: "Search sessions" },

  { key: "1", label: "1", command: "tab.transcript", group: "View", description: "Transcript" },
  { key: "2", label: "2", command: "tab.changes", group: "View", description: "Changes" },
  { key: "3", label: "3", command: "tab.terminal", group: "View", description: "Terminal" },
  { key: "4", label: "4", command: "tab.jira", group: "View", description: "Jira (when the session has a key)" },
  { key: "5", label: "5", command: "tab.pr", group: "View", description: "Pull request (when one exists)" },

  { key: "t", label: "T", command: "terminal.toggle", group: "Session", description: "Resume in terminal / focus it" },
  { key: "i", label: "I", command: "terminal.focus.toggle", group: "Session", description: "Type in the terminal / hand the keyboard back" },
  { key: "p", label: "P", command: "session.pin", group: "Session", description: "Pin or unpin" },
  { key: "x", label: "X", command: "session.hide", group: "Session", description: "Hide from the list (reversible)" },

  { key: "n", label: "N", command: "session.new", group: "App", description: "New session" },
  { key: "s", label: "S", command: "scratch.toggle", group: "App", description: "Scratch pad" },
  { key: "?", label: "?", command: "help.toggle", group: "App", description: "This list", noAlt: true },
];

/** Bare key (or alias) → command. */
const BY_KEY = new Map<string, Command>();
/** Alt + key → command. */
const BY_ALT_KEY = new Map<string, Command>();
for (const s of SHORTCUTS) {
  BY_KEY.set(s.key, s.command);
  for (const a of s.aliases ?? []) BY_KEY.set(a, s.command);
  if (!s.noAlt) BY_ALT_KEY.set(s.key, s.command);
}

export function commandForKey(key: string, withAlt: boolean): Command | undefined {
  const k = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  return withAlt ? BY_ALT_KEY.get(k) : BY_KEY.get(k);
}

export function labelFor(command: Command): string | undefined {
  return SHORTCUTS.find((s) => s.command === command)?.label;
}

/* ------------------------------------------------------------------ hint mode */

let hinting = false;
const listeners = new Set<() => void>();

/** True while Alt is held: the key badges brighten so the whole map is readable at once. */
export function isHinting(): boolean {
  return hinting;
}

export function subscribeHints(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setHinting(v: boolean): void {
  if (hinting === v) return;
  hinting = v;
  for (const l of listeners) l();
}
