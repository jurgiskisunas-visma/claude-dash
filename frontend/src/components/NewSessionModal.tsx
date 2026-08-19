import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "../api/client";
import { getRecentPaths, subscribeRecentPaths } from "../lib/recentPaths";

interface Props {
  onCancel: () => void;
  onStart: (cwd: string) => void;
}

export function NewSessionModal({ onCancel, onStart }: Props) {
  // Starts empty: pre-filling one machine's project folder is wrong for everyone else, and
  // the recent list below is a better answer anyway.
  const [cwd, setCwd] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const recent = useSyncExternalStore(subscribeRecentPaths, getRecentPaths);
  // Workspaces Claude Code already knows about — a useful fallback the first time round,
  // and filtered so it doesn't just repeat the recent list.
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const recentLower = new Set(recent.map((p) => p.toLowerCase()));
  const known = (workspaces.data ?? [])
    .map((w) => w.displayPath)
    .filter((p) => p && !recentLower.has(p.toLowerCase()))
    .slice(0, 12);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const trimmed = cwd.trim().replace(/[\\/]+$/, "");

  function start(path = trimmed) {
    if (!path) return;
    onStart(path);
  }

  async function browse() {
    setPicking(true);
    setPickError(null);
    try {
      const picked = await api.pickFolder(trimmed || recent[0]);
      if (picked) {
        setCwd(picked);
        inputRef.current?.focus();
      }
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  }

  return (
    <div
      className="backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/55 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="dialog-in w-full max-w-xl rounded-tile border border-hairline bg-surface-solid shadow-pop"
      >
        <div className="px-5 py-3 seam flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-fg">Start a new session</h2>
          <button onClick={onCancel} className="press text-fg-dim hover:text-fg px-2" title="Esc">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <span className="label">Working directory</span>
            <div className="mt-1.5 flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") start(); }}
                spellCheck={false}
                className="field flex-1 px-3 py-2 text-sm font-mono"
                placeholder="Pick a folder, or paste a path"
              />
              <button
                onClick={browse}
                disabled={picking}
                title="Open the system folder picker on this machine"
                className="pill press px-3 py-2 text-xs shrink-0 disabled:opacity-50"
              >
                {picking ? "Waiting…" : "Browse…"}
              </button>
            </div>
            {picking && (
              <span className="text-xs text-fg-dim mt-1.5 block">
                The folder dialog is open on your desktop — it may be behind this window.
              </span>
            )}
            {pickError && (
              <span className="text-xs text-rose-600 dark:text-rose-300 mt-1.5 block">{pickError}</span>
            )}
          </div>

          {recent.length > 0 && (
            <PathGroup
              label="Recent"
              paths={recent}
              current={trimmed}
              onPick={setCwd}
              onUse={start}
            />
          )}

          {known.length > 0 && (
            <PathGroup
              label="Known workspaces"
              paths={known}
              current={trimmed}
              onPick={setCwd}
              onUse={start}
            />
          )}
        </div>

        <div className="px-5 py-3 seam-t flex items-center gap-2">
          <span className="text-2xs text-fg-dim">Click a folder to fill it in, double-click to start.</span>
          <button onClick={onCancel} className="pill press ml-auto px-3 py-1.5 text-xs">Cancel</button>
          <button
            onClick={() => start()}
            disabled={!trimmed}
            className="btn-accent press px-4 py-1.5 text-xs disabled:opacity-40"
          >Start session</button>
        </div>
      </div>
    </div>
  );
}

function PathGroup({
  label, paths, current, onPick, onUse,
}: {
  label: string;
  paths: readonly string[];
  current: string;
  onPick: (p: string) => void;
  onUse: (p: string) => void;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="mt-1.5 flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
        {paths.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            onDoubleClick={() => onUse(p)}
            title={`${p}\n(double-click to start here)`}
            className={clsx(
              "press px-2.5 py-1 text-xs font-mono",
              p.toLowerCase() === current.toLowerCase() ? "pill pill-on" : "pill",
            )}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Encode a Windows path into the workspaceId format claude uses (e.g. C:\dev\app → C--dev-app). */
export function encodeWorkspaceId(cwd: string): string {
  const normalized = cwd.replace(/\//g, "\\").replace(/\\+$/, "");
  const m = /^([A-Za-z]):\\(.*)$/.exec(normalized);
  if (m) {
    return `${m[1].toUpperCase()}--` + m[2].replace(/\\/g, "-");
  }
  return normalized.replace(/\\/g, "-");
}
