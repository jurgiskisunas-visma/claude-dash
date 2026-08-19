import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  ensureTerminal,
  subscribe,
  type TermKey,
  type TermStatus,
} from "../terminalStore";
import { getTheme, subscribeTheme, type Theme } from "../lib/theme";
import { Kbd } from "./Kbd";

interface Props {
  termKey: TermKey;
  wsUrl: string;
  /** Grab keyboard focus on mount. Default true. */
  autoFocus?: boolean;
}

// Matched to the app's glass surfaces (see index.css tokens) with a Rider-ish
// syntax palette: muted violet, salmon, teal, gold.
const XTERM_THEMES: Record<Theme, ITheme> = {
  dark: {
    background: "#1d1a24",
    foreground: "#ddd8e6",
    cursor: "#a78bfa",
    cursorAccent: "#1d1a24",
    selectionBackground: "rgba(167,139,250,0.25)",
    black: "#2b2733",
    red: "#e5989b",
    green: "#8fd0a8",
    yellow: "#e0b872",
    blue: "#8ab4f8",
    magenta: "#c3a0f7",
    cyan: "#7fd0c0",
    white: "#ddd8e6",
    brightBlack: "#7b7488",
    brightRed: "#f0aeb0",
    brightGreen: "#a6e0bd",
    brightYellow: "#f0cd8e",
    brightBlue: "#a6c8ff",
    brightMagenta: "#d4b8ff",
    brightCyan: "#9ce0d3",
    brightWhite: "#f2eefa",
  },
  light: {
    background: "#fbfaff",
    foreground: "#221d2c",
    cursor: "#6f4df3",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(111,77,243,0.18)",
    black: "#3b3547",
    red: "#c0475c",
    green: "#3f8f63",
    yellow: "#a1701c",
    blue: "#3260c9",
    magenta: "#7b46c9",
    cyan: "#1c7f88",
    white: "#e6e2ee",
    brightBlack: "#8a8398",
    brightRed: "#d4566c",
    brightGreen: "#4da375",
    brightYellow: "#b6832a",
    brightBlue: "#4472dc",
    brightMagenta: "#8e58dc",
    brightCyan: "#26949e",
    brightWhite: "#151021",
  },
};

export function TerminalPane({ termKey, wsUrl, autoFocus = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<TermStatus>("connecting");
  // Whether keystrokes are currently going to the shell. Worth showing, because it decides
  // whether the app's bare-key shortcuts do anything.
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    // Ensure the underlying WS exists (no-op if already there).
    ensureTerminal(termKey, wsUrl);

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: XTERM_THEMES[getTheme()],
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
      // Tells xterm the backend is ConPTY so it applies Windows-specific reflow
      // (otherwise scrolling inside a TUI like Claude Code ghosts/duplicates lines
      // because ConPTY pushes the viewport up rather than emitting scrollback).
      windowsPty: { backend: "conpty", buildNumber: 26200 },
      scrollOnUserInput: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;

    // xterm has no focus/blur events of its own; its helper textarea is the real target.
    const textarea = term.textarea;
    const onTaFocus = () => setTyping(true);
    const onTaBlur = () => setTyping(false);
    textarea?.addEventListener("focus", onTaFocus);
    textarea?.addEventListener("blur", onTaBlur);
    if (textarea && document.activeElement === textarea) setTyping(true);

    // Swap the canvas colors live when the app theme flips.
    const unsubTheme = subscribeTheme(() => {
      term.options.theme = XTERM_THEMES[getTheme()];
    });

    const decoder = new TextDecoder("utf-8");

    const sub = subscribe(
      termKey,
      (data) => term.write(decoder.decode(data, { stream: true })),
      (s) => setStatus(s),
    );

    if (!sub) {
      term.write("\x1b[31m[ClaudeDash] no terminal entry — internal error\x1b[0m\r\n");
      return () => { unsubTheme(); term.dispose(); };
    }

    let disposed = false;

    if (sub.replay.byteLength > 0) {
      term.write(decoder.decode(sub.replay));
    }
    setStatus(sub.status);

    let lastSized = false;

    const sendResize = () => {
      if (disposed) return false;
      const el = containerRef.current;
      if (!el || el.clientWidth < 20 || el.clientHeight < 20) {
        lastSized = false;
        return false;                                   // not laid out yet
      }
      try {
        fit.fit();
        sub.control({ resize: { cols: term.cols, rows: term.rows } });
        lastSized = true;
        return true;
      } catch {
        return false;                                   // xterm renderer not ready yet
      }
    };

    /**
     * Force the child TUI to repaint at the current size.
     *
     * A full-screen TUI like claude only redraws when the console tells it the window
     * changed. On a fresh attach it has already drawn its frame for whatever size the PTY
     * had before (the 140x36 spawn default, or the size of a previous viewer), and the
     * replayed buffer is that old frame — so it looks mangled until something resizes.
     * Sending a one-row-smaller size and then the real one is the same signal the user was
     * producing by hand when they zoomed or resized the window.
     */
    const nudge = () => {
      if (disposed || !lastSized) return;
      const { cols, rows } = term;
      if (!cols || rows < 2) return;
      sub.control({ resize: { cols, rows: rows - 1 } });
      window.setTimeout(() => {
        if (disposed) return;
        sub.control({ resize: { cols, rows } });
        try { term.refresh(0, term.rows - 1); } catch { /* renderer torn down */ }
      }, 70);
    };

    // Fit, then nudge. Waits for fonts because xterm derives its cell size from the font:
    // measuring before the font is ready yields the wrong cell metrics, which is the other
    // way this pane comes up looking broken.
    const settle = () => {
      if (disposed) return;
      if (!sendResize()) return;
      if (autoFocus !== false) term.focus();
      nudge();
    };

    let raf1 = requestAnimationFrame(() => {
      let raf2 = requestAnimationFrame(() => {
        settle();
        const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
        if (fonts && fonts.status !== "loaded") {
          fonts.ready.then(() => { if (!disposed) settle(); });
        }
      });
      void raf2;
    });

    const dataDisp = term.onData((d) => sub.send(d));

    const ro = new ResizeObserver(() => {
      const wasSized = lastSized;
      const nowSized = sendResize();
      if (nowSized && !wasSized) nudge();
    });
    ro.observe(containerRef.current);
    const onWinResize = () => sendResize();
    window.addEventListener("resize", onWinResize);
    const onVisible = () => { if (document.visibilityState === "visible") settle(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf1);
      window.removeEventListener("resize", onWinResize);
      document.removeEventListener("visibilitychange", onVisible);
      ro.disconnect();
      dataDisp.dispose();
      textarea?.removeEventListener("focus", onTaFocus);
      textarea?.removeEventListener("blur", onTaBlur);
      unsubTheme();
      sub.unsubscribe();
      termRef.current = null;
      term.dispose();
    };
  }, [termKey, wsUrl, autoFocus]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-surface-solid">
      <div className="px-3 py-1 text-[10px] text-fg-dim seam flex items-center gap-2 font-mono">
        <span className={
          status === "open" ? "text-emerald-500 dark:text-emerald-400" :
          status === "connecting" ? "text-amber-500 dark:text-amber-400" :
          status === "closed" ? "text-fg-dim" :
          "text-rose-500 dark:text-rose-400"
        }>●</span>
        <span>{status}</span>
        <span className="truncate opacity-60">{termKey}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0 font-sans">
          {typing ? (
            <>
              <span>keys go to the shell</span>
              <Kbd>Alt+B</Kbd>
              <span className="opacity-70">to leave</span>
            </>
          ) : (
            <span className="opacity-70">click to type</span>
          )}
        </span>
      </div>
      <div
        ref={containerRef}
        onMouseDown={() => termRef.current?.focus()}
        className="flex-1 p-2 overflow-hidden"
      />
    </div>
  );
}
