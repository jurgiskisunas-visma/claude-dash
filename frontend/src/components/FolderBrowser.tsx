import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api } from "../api/client";
import type { BrowseResult } from "../types/api";

/**
 * Folder picker drawn inside the page.
 *
 * The native dialog this replaced was spawned by the backend — a background web server — and
 * Windows will not reliably let such a process take the foreground, so it opened behind the
 * browser. A panel in the page is always visible, needs no OS cooperation, and works the same
 * everywhere.
 */
export function FolderBrowser({
  startPath, onPick, onClose,
}: {
  startPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | undefined>(startPath || undefined);
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.browse(path)
      .then((d) => { if (!cancelled) { setData(d); listRef.current?.scrollTo({ top: 0 }); } })
      .catch((e) => { if (!cancelled) setData({ path: path ?? null, parent: null, directories: [], drives: [], error: String(e) }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  const here = data?.path ?? null;

  return (
    <div className="card p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setPath(data?.parent ?? undefined)}
          disabled={!data?.parent}
          title="Up one level"
          className="pill press px-2 py-1 text-2xs disabled:opacity-40"
        >↑ Up</button>
        <code className="text-xs text-fg-muted font-mono truncate flex-1" title={here ?? undefined}>
          {here ?? "Pick a drive"}
        </code>
        <button onClick={onClose} className="pill press px-2 py-1 text-2xs">Close</button>
      </div>

      {(data?.drives.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1">
          {data!.drives.map((d) => (
            <button
              key={d.path}
              onClick={() => setPath(d.path)}
              className={clsx(
                "press px-2 py-0.5 text-2xs font-mono",
                here?.toLowerCase().startsWith(d.path.toLowerCase()) ? "pill pill-on" : "pill",
              )}
            >{d.name}</button>
          ))}
        </div>
      )}

      <div ref={listRef} className="h-52 overflow-y-auto rounded-lg bg-surface-solid p-1">
        {loading && <div className="text-xs text-fg-dim px-2 py-1.5">Loading…</div>}
        {!loading && data?.error && (
          <div className="text-xs text-rose-600 dark:text-rose-300 px-2 py-1.5">{data.error}</div>
        )}
        {!loading && !data?.error && data?.directories.length === 0 && (
          <div className="text-xs text-fg-dim px-2 py-1.5">No sub-folders here.</div>
        )}
        {data?.directories.map((d) => (
          <button
            key={d.path}
            onClick={() => setPath(d.path)}
            onDoubleClick={() => onPick(d.path)}
            title={`${d.path}\n(double-click to use this folder)`}
            className="w-full text-left px-2 py-1 rounded-md text-xs text-fg-muted hover:bg-surface-3 hover:text-fg transition-colors truncate"
          >
            {d.name}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-2xs text-fg-dim">Click to open, double-click to choose.</span>
        <button
          onClick={() => here && onPick(here)}
          disabled={!here}
          className="btn-accent press ml-auto px-3 py-1 text-xs disabled:opacity-40"
        >Use this folder</button>
      </div>
    </div>
  );
}
