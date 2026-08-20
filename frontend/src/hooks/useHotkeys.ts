import { useEffect } from "react";
import { dispatch } from "../lib/commands";
import { commandForKey, setHinting } from "../lib/shortcuts";

/** True when the event came from somewhere the user is typing (including a PTY). */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||          // xterm's helper element is a textarea
    tag === "SELECT" ||
    el.isContentEditable ||
    !!el.closest?.(".xterm")
  );
}

/**
 * Installs the global keyboard map. Bare keys are ignored while typing; Alt+key works
 * everywhere and is swallowed in the capture phase so xterm never receives it.
 */
export function useHotkeys(): void {
  useEffect(() => {
    // Set when we consume an Alt combo, so the matching Alt *keyup* can be swallowed too.
    // Chrome treats a bare Alt press-and-release as "focus the menu bar", which takes the
    // keyboard away from the page entirely — after that no shortcut works and the only way
    // back is a mouse click.
    let handledAltCombo = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey) setHinting(true);

      // Escape is the one key that must work while typing (blur the search box, close a
      // dialog), so it is handled before the typing check.
      if (e.key === "Escape") {
        dispatch("escape");
        return;
      }

      // Never fight the browser or the OS.
      if (e.ctrlKey || e.metaKey) return;

      const alt = e.altKey;
      if (!alt && isTyping(e.target)) return;

      const cmd = commandForKey(e.key, alt);
      if (!cmd) return;

      if (alt) handledAltCombo = true;
      e.preventDefault();
      e.stopPropagation();
      dispatch(cmd);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.altKey) setHinting(false);
      if (e.key === "Alt" && handledAltCombo) {
        handledAltCombo = false;
        e.preventDefault();      // keep Chrome's menu bar out of it
        e.stopPropagation();
      }
    };
    const clearHints = () => setHinting(false);

    // Capture phase: xterm listens on its textarea, so we have to get there first.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", clearHints);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", clearHints);
      setHinting(false);
    };
  }, []);
}
