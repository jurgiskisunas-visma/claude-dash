import { useEffect, useRef, useState } from "react";
import { TerminalPane } from "./TerminalPane";
import { makeKey } from "../terminalStore";
import { api } from "../api/client";

interface Props {
  /** Scratch workspace (from /api/scratch) — null until it resolves. */
  scratch: { cwd: string; workspaceId: string } | null;
  open: boolean;
  onClose: () => void;
}

const SIZE_KEY = "claudedash:scratch-size";

/**
 * Floating "small talk" terminal. Always the same claude conversation
 * (`claude --continue` in a dedicated scratch cwd), so it never shows up as a
 * new row in the session list. Hiding the popup only unmounts the xterm — the
 * PTY WebSocket lives in terminalStore, so the conversation keeps running.
 */
export function ScratchTerminal({ scratch, open, onClose }: Props) {
  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    try {
      const raw = localStorage.getItem(SIZE_KEY);
      const v = raw ? JSON.parse(raw) : null;
      if (v && typeof v.w === "number" && typeof v.h === "number") return v;
    } catch { /* */ }
    return { w: 620, h: 460 };
  });
  useEffect(() => {
    localStorage.setItem(SIZE_KEY, JSON.stringify(size));
  }, [size]);

  // Drag the top-left corner to resize (the panel is anchored bottom-right).
  const dragRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setSize({
        w: Math.max(360, Math.min(window.innerWidth - 40, d.w - (e.clientX - d.x))),
        h: Math.max(240, Math.min(window.innerHeight - 80, d.h - (e.clientY - d.y))),
      });
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (!open || !scratch) return null;

  const termKey = makeKey(scratch.workspaceId, "scratch", "continue");
  const wsUrl = api.terminalWsUrl(scratch.workspaceId, {
    mode: "continue",
    cwd: scratch.cwd,
    key: termKey,
  });

  return (
    <div
      className="dialog-in fixed bottom-4 right-4 z-40 flex flex-col rounded-tile overflow-hidden
                 border border-hairline bg-surface-solid shadow-pop"
      style={{ width: size.w, height: size.h }}
    >
      <div
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
          document.body.style.cursor = "nwse-resize";
          document.body.style.userSelect = "none";
        }}
        title="Drag to resize"
        className="absolute top-0 left-0 w-4 h-4 cursor-nwse-resize z-10"
      />
      <div className="flex items-center gap-2 px-3 py-2 text-xs seam bg-surface-2">
        <span className="w-1.5 h-1.5 rounded-full bg-accent" />
        <span className="font-semibold text-fg">Scratch</span>
        <span className="text-fg-dim font-mono truncate">{scratch.cwd}</span>
        <button
          onClick={onClose}
          title="Hide (the conversation keeps running)"
          className="ml-auto px-2 rounded text-fg-dim hover:text-rose-500 dark:hover:text-rose-400"
        >
          ×
        </button>
      </div>
      <TerminalPane termKey={termKey} wsUrl={wsUrl} scope="scratch" />
    </div>
  );
}
