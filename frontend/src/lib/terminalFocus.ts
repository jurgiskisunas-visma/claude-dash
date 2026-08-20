/**
 * Who owns the keyboard: the app, or one of the terminals.
 *
 * Two things need this. `Alt+I` has to toggle back into *the terminal you were last using* —
 * with a scratch window open, always targeting "the last pane in the DOM" made the session's
 * own terminal unreachable. And the UI should be able to say where keystrokes are going, since
 * that decides whether the bare-key shortcuts do anything.
 */

export type FocusScope = "app" | "session" | "scratch";

const SELECTOR = ".xterm-helper-textarea";

let scope: FocusScope = "app";
let lastTerminal: HTMLTextAreaElement | null = null;
const listeners = new Set<() => void>();

function set(next: FocusScope) {
  if (scope === next) return;
  scope = next;
  for (const l of listeners) l();
}

/** Reads the scope a pane declares (`data-terminal-scope` on the pane container). */
function scopeOf(el: Element | null): FocusScope {
  const host = el?.closest<HTMLElement>("[data-terminal-scope]");
  const value = host?.dataset.terminalScope;
  return value === "scratch" || value === "session" ? value : "app";
}

/** Installs the focus tracking. Call once, from the app shell. */
export function trackTerminalFocus(): () => void {
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.matches?.(SELECTOR)) {
      lastTerminal = target as HTMLTextAreaElement;
      set(scopeOf(target));
    } else {
      set("app");
    }
  };
  const onFocusOut = () => {
    // Focus moving to nothing (blur to body) counts as the app having the keyboard.
    setTimeout(() => {
      if (!document.activeElement?.matches?.(SELECTOR)) set("app");
    }, 0);
  };
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  return () => {
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
  };
}

export function subscribeFocusScope(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getFocusScope(): FocusScope {
  return scope;
}

/** Hands the keyboard back to the app. Parks it on the shell, never on a bare `<body>`. */
export function releaseTerminalFocus(): void {
  (document.activeElement as HTMLElement | null)?.blur();
  document.getElementById("app-root")?.focus();
  set("app");
}

/**
 * Puts the cursor in a terminal and reports whether it worked.
 *
 * With no `want`, it returns to the terminal last used — falling back to the scratch window if
 * it is open, then to any pane on screen.
 */
export function focusTerminal(want?: FocusScope): boolean {
  const pick = (): HTMLTextAreaElement | null => {
    if (want && want !== "app") {
      return document.querySelector<HTMLTextAreaElement>(
        `[data-terminal-scope="${want}"] ${SELECTOR}`,
      );
    }
    if (lastTerminal?.isConnected) return lastTerminal;
    return document.querySelector<HTMLTextAreaElement>(`[data-terminal-scope="scratch"] ${SELECTOR}`)
      ?? document.querySelector<HTMLTextAreaElement>(SELECTOR);
  };

  const el = pick();
  if (!el) return false;
  el.focus();
  return document.activeElement === el;
}

/**
 * Focuses a terminal that may still be mounting — pressing `T` can switch to the Terminal tab
 * and needs the pane to exist before it can take the keyboard.
 */
export function focusTerminalWhenReady(want?: FocusScope, attempts = 8): void {
  let n = 0;
  const tick = () => {
    if (focusTerminal(want) || ++n >= attempts) return;
    window.setTimeout(tick, 60);
  };
  requestAnimationFrame(tick);
}

/** True when keystrokes are going to a shell rather than the app. */
export function isTerminalFocused(): boolean {
  return scope !== "app";
}
