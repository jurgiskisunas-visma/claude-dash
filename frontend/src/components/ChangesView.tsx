import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "../api/client";
import type { ChangedFileSummary, RepoChanges, SessionSummary } from "../types/api";

interface Props {
  session: SessionSummary;
}

export function ChangesView({ session }: Props) {
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [split, setSplit] = useState(true);
  const [allExpanded, setAllExpanded] = useState(true);
  // Keyed by `${repoRoot}|${path}` so identical relative paths in two repos don't collide.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const changes = useQuery({
    queryKey: ["changes", session.workspaceId, session.sessionId, ignoreWs],
    queryFn: () => api.sessionChanges(session.workspaceId, session.sessionId, { ignoreWhitespace: ignoreWs }),
  });

  const repos = changes.data?.repos ?? [];

  // Repo filter: options are only the repos that actually have changes.
  // null = "all" (default); a Set = explicit selection of repoRoots.
  const [repoFilter, setRepoFilter] = useState<Set<string> | null>(null);
  const changedRepos = useMemo(() => repos.filter((r) => r.changes.files.length > 0), [repos]);
  const changedKey = changedRepos.map((r) => r.repoRoot).join("|");
  // New session / refetch with a different repo set → reset to "all".
  useEffect(() => { setRepoFilter(null); }, [changedKey]);

  const visibleRepos = useMemo(() => {
    if (repoFilter === null) return repos;
    // With an active filter only show the explicitly selected (changed) repos.
    return repos.filter((r) => repoFilter.has(r.repoRoot));
  }, [repos, repoFilter]);

  const fileKeys = useMemo(
    () => visibleRepos.flatMap((r) => r.changes.files.map((f) => `${r.repoRoot}|${f.path}`)),
    [visibleRepos],
  );

  // When the file list changes, reset expansion state to match allExpanded default.
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const k of fileKeys) next[k] = allExpanded;
    setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKeys.length]);

  function setOne(key: string, val: boolean) {
    setExpanded((m) => ({ ...m, [key]: val }));
  }
  function setAll(val: boolean) {
    const next: Record<string, boolean> = {};
    for (const k of fileKeys) next[k] = val;
    setExpanded(next);
    setAllExpanded(val);
  }

  if (changes.isLoading) return <div className="p-6 text-fg-muted text-sm">Loading diff…</div>;
  if (changes.error || !changes.data) return <div className="p-6 text-rose-500 dark:text-rose-400 text-sm">Failed to load: {String(changes.error)}</div>;
  if (!changes.data.ok) return <div className="p-6 text-amber-600 dark:text-amber-300 text-sm">⚠ {changes.data.error}</div>;

  const multiRepo = repos.length > 1 || (repos.length === 1 && repos[0].repoName !== ".");
  const totalAdd = visibleRepos.reduce((n, r) => n + r.changes.files.reduce((m, f) => m + f.additions, 0), 0);
  const totalDel = visibleRepos.reduce((n, r) => n + r.changes.files.reduce((m, f) => m + f.deletions, 0), 0);
  const totalFiles = visibleRepos.reduce((n, r) => n + r.changes.files.length, 0);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-3 border-b border-hairline bg-gradient-to-r from-violet-100/50 dark:from-violet-950/20 via-transparent to-transparent flex items-center gap-3 flex-wrap text-xs sticky top-0 bg-surface-solid z-10">
        {multiRepo ? (
          <span className="text-fg-muted">
            <span className="text-fg-muted">📦 {repos.length} repo{repos.length === 1 ? "" : "s"} in</span>{" "}
            <code className="text-violet-600 dark:text-violet-300">{changes.data.cwd}</code>
            {changes.data.discoveredVia === "scan" && (
              <span className="text-fg-muted" title="No edited files found in the transcript — showing every child repo instead">
                {" "}(scanned)
              </span>
            )}
          </span>
        ) : repos.length === 1 && (
          <span className="text-fg-muted">
            <span className="text-fg-muted">on</span> <code className="text-violet-600 dark:text-violet-300">⎇ {repos[0].changes.currentBranch}</code>
            <span className="text-fg-muted"> vs</span> <code className="text-sky-600 dark:text-sky-300">{repos[0].changes.resolvedBase?.slice(0, 12)}</code>
          </span>
        )}
        <span className="text-emerald-600 dark:text-emerald-300">+{totalAdd}</span>
        <span className="text-rose-600 dark:text-rose-300">-{totalDel}</span>
        <span className="text-fg-muted">· {totalFiles} file{totalFiles === 1 ? "" : "s"}</span>

        <div className="ml-auto flex items-center gap-2">
          {multiRepo && changedRepos.length > 1 && (
            <RepoFilterDropdown
              options={changedRepos}
              selected={repoFilter}
              onChange={setRepoFilter}
            />
          )}
          <label className="flex items-center gap-1 cursor-pointer text-fg-muted">
            <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} className="accent-violet-500" />
            ignore whitespace
          </label>
          <div className="flex rounded-full border border-hairline-strong overflow-hidden">
            <button onClick={() => setSplit(false)} className={clsx("px-2.5 py-0.5", !split ? "bg-violet-500/20 text-violet-700 dark:text-violet-200" : "text-fg-muted hover:text-fg dark:hover:text-fg")}>Unified</button>
            <button onClick={() => setSplit(true)} className={clsx("px-2.5 py-0.5", split ? "bg-violet-500/20 text-violet-700 dark:text-violet-200" : "text-fg-muted hover:text-fg dark:hover:text-fg")}>Split</button>
          </div>
          <button onClick={() => setAll(true)} className="px-2 py-0.5 text-fg-muted hover:text-fg dark:hover:text-fg border border-hairline-strong rounded-full">Expand all</button>
          <button onClick={() => setAll(false)} className="px-2 py-0.5 text-fg-muted hover:text-fg dark:hover:text-fg border border-hairline-strong rounded-full">Collapse all</button>
        </div>
      </div>

      <div className="px-6 py-4 space-y-5">
        {totalFiles === 0 && (
          <div className="text-fg-muted text-sm italic">
            No changes vs base{multiRepo ? " in any repo this session touched" : ""}.
          </div>
        )}
        {visibleRepos.map((repo) => (
          <RepoSection
            key={repo.repoRoot}
            session={session}
            repo={repo}
            showHeader={multiRepo}
            expanded={expanded}
            onToggle={setOne}
            split={split}
            ignoreWhitespace={ignoreWs}
          />
        ))}
      </div>
    </div>
  );
}

function RepoFilterDropdown({
  options, selected, onChange,
}: {
  options: RepoChanges[];
  selected: Set<string> | null; // null = all
  onChange: (s: Set<string> | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const allRoots = options.map((o) => o.repoRoot);
  const isChecked = (root: string) => selected === null || selected.has(root);
  const checkedCount = selected === null ? allRoots.length : allRoots.filter((r) => selected.has(r)).length;

  function toggle(root: string) {
    const next = new Set(selected === null ? allRoots : [...selected]);
    if (next.has(root)) next.delete(root);
    else next.add(root);
    // Everything back on → collapse to "all" so a refetch keeps showing new repos too.
    onChange(next.size === allRoots.length ? null : next);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "px-2 py-0.5 rounded-full border flex items-center gap-1",
          selected !== null
            ? "border-violet-400/50 bg-violet-500/15 text-violet-700 dark:text-violet-200"
            : "border-hairline-strong text-fg-muted hover:text-fg dark:hover:text-fg",
        )}
        title="Filter which repos' changes are shown"
      >
        📦 {checkedCount}/{allRoots.length} repos
        <span className="text-[9px]">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[16rem] max-w-[26rem] rounded-lg border border-hairline-strong bg-surface-solid shadow-xl p-1.5 space-y-0.5">
          {options.map((o) => (
            <label
              key={o.repoRoot}
              className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-surface-3"
              title={o.repoRoot}
            >
              <input
                type="checkbox"
                checked={isChecked(o.repoRoot)}
                onChange={() => toggle(o.repoRoot)}
                className="accent-violet-500"
              />
              <span className="text-fg font-medium truncate">{o.repoName}</span>
              <span className="ml-auto text-[10px] text-fg-muted tabular-nums shrink-0">
                {o.changes.files.length} file{o.changes.files.length === 1 ? "" : "s"}
              </span>
            </label>
          ))}
          <div className="flex items-center gap-2 border-t border-hairline pt-1 mt-1 px-2">
            <button onClick={() => onChange(null)} className="text-[10px] text-violet-600 dark:text-violet-300 hover:underline">all</button>
            <button onClick={() => onChange(new Set())} className="text-[10px] text-fg-muted hover:underline">none</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RepoSection({
  session, repo, showHeader, expanded, onToggle, split, ignoreWhitespace,
}: {
  session: SessionSummary;
  repo: RepoChanges;
  showHeader: boolean;
  expanded: Record<string, boolean>;
  onToggle: (key: string, val: boolean) => void;
  split: boolean;
  ignoreWhitespace: boolean;
}) {
  const c = repo.changes;
  const add = c.files.reduce((n, f) => n + f.additions, 0);
  const del = c.files.reduce((n, f) => n + f.deletions, 0);

  // In multi-repo view, hide repos without changes unless they errored.
  if (showHeader && c.ok && c.files.length === 0) {
    return (
      <section>
        <RepoHeader repo={repo} add={add} del={del} />
        <div className="text-fg-muted text-xs italic mt-1.5 ml-1">No changes vs base.</div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      {showHeader && <RepoHeader repo={repo} add={add} del={del} />}
      {!c.ok && (
        <div className="text-amber-600 dark:text-amber-300 text-xs">⚠ {c.error}</div>
      )}
      {c.files.map((f) => (
        <FileBlock
          key={`${repo.repoRoot}|${f.path}`}
          session={session}
          repoRoot={repo.repoRoot}
          file={f}
          expanded={!!expanded[`${repo.repoRoot}|${f.path}`]}
          onToggle={() => onToggle(`${repo.repoRoot}|${f.path}`, !expanded[`${repo.repoRoot}|${f.path}`])}
          split={split}
          ignoreWhitespace={ignoreWhitespace}
        />
      ))}
    </section>
  );
}

function RepoHeader({ repo, add, del }: { repo: RepoChanges; add: number; del: number }) {
  const c = repo.changes;
  return (
    <div className="flex items-center gap-3 flex-wrap text-xs border-b border-hairline-strong pb-1.5">
      <span className="text-sm font-semibold text-fg">📦 {repo.repoName}</span>
      {c.ok && (
        <span className="text-fg-muted">
          <code className="text-violet-600 dark:text-violet-300">⎇ {c.currentBranch}</code>
          <span className="text-fg-muted"> vs </span>
          <code className="text-sky-600 dark:text-sky-300">{c.resolvedBase?.slice(0, 12)}</code>
        </span>
      )}
      {c.files.length > 0 && (
        <>
          <span className="text-emerald-600 dark:text-emerald-300">+{add}</span>
          <span className="text-rose-600 dark:text-rose-300">-{del}</span>
          <span className="text-fg-muted">· {c.files.length} file{c.files.length === 1 ? "" : "s"}</span>
        </>
      )}
      <code className="ml-auto text-[10px] text-fg-dim truncate max-w-[24rem]" title={repo.repoRoot}>{repo.repoRoot}</code>
    </div>
  );
}

function FileBlock({
  session, repoRoot, file, expanded, onToggle, split, ignoreWhitespace,
}: {
  session: SessionSummary;
  repoRoot: string;
  file: ChangedFileSummary;
  expanded: boolean;
  onToggle: () => void;
  split: boolean;
  ignoreWhitespace: boolean;
}) {
  const diff = useQuery({
    queryKey: ["diff", session.workspaceId, session.sessionId, repoRoot, file.path, ignoreWhitespace],
    queryFn: () => api.sessionFileDiff(session.workspaceId, session.sessionId, file.path, { repo: repoRoot, ignoreWhitespace }),
    enabled: expanded && !file.isBinary,
  });

  const statusColor = {
    added: "text-emerald-600 dark:text-emerald-300",
    modified: "text-amber-600 dark:text-amber-300",
    deleted: "text-rose-600 dark:text-rose-300",
    renamed: "text-violet-600 dark:text-violet-300",
    copied: "text-violet-600 dark:text-violet-300",
  }[file.status] ?? "text-fg-muted";

  return (
    <section className="rounded-xl border border-hairline-strong bg-surface-2 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-3 hover:bg-surface-3 transition-colors text-left"
      >
        <span className="text-fg-muted">{expanded ? "▾" : "▸"}</span>
        <code className="text-xs text-fg font-mono truncate flex-1">{file.path}</code>
        <span className={clsx("text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border", `bg-${file.status === "added" ? "emerald" : file.status === "deleted" ? "rose" : "amber"}-500/10`, statusColor.split(" ")[0].replace("text-", "border-").replace("-600", "-400/40"), statusColor)}>
          {file.status}
        </span>
        <span className="text-xs text-emerald-600 dark:text-emerald-300 tabular-nums">+{file.additions}</span>
        <span className="text-xs text-rose-600 dark:text-rose-300 tabular-nums">-{file.deletions}</span>
      </button>

      {expanded && (
        <div className="border-t border-hairline">
          {file.isBinary && <div className="px-4 py-3 text-xs text-fg-muted italic">Binary file — no preview</div>}
          {!file.isBinary && diff.isLoading && <div className="px-4 py-3 text-xs text-fg-muted">Loading diff…</div>}
          {!file.isBinary && diff.error && <div className="px-4 py-3 text-xs text-rose-500 dark:text-rose-400">Failed to load diff</div>}
          {!file.isBinary && diff.data && (
            split
              ? <SplitDiff text={diff.data} />
              : <UnifiedDiff text={diff.data} />
          )}
        </div>
      )}
    </section>
  );
}

// ── Diff parsing ────────────────────────────────────────────────────────────

interface Hunk { header: string; lines: HunkLine[]; }
interface HunkLine { kind: " " | "+" | "-"; text: string; oldNo: number | null; newNo: number | null; }

function parseHunks(diffText: string): Hunk[] {
  const lines = diffText.split("\n");
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldNo = 0, newNo = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      cur = { header: l, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // diff header, file path, etc — skip until first hunk
    if (l.startsWith("\\")) continue; // "\ No newline at end of file"
    if (l.startsWith("+")) {
      cur.lines.push({ kind: "+", text: l.slice(1), oldNo: null, newNo: newNo++ });
    } else if (l.startsWith("-")) {
      cur.lines.push({ kind: "-", text: l.slice(1), oldNo: oldNo++, newNo: null });
    } else {
      // could be " " context, or empty diff line (no leading space) — treat blank as context
      cur.lines.push({ kind: " ", text: l.length > 0 ? l.slice(1) : "", oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return hunks;
}

// ── Unified renderer ────────────────────────────────────────────────────────

function UnifiedDiff({ text }: { text: string }) {
  const hunks = useMemo(() => parseHunks(text), [text]);
  if (hunks.length === 0) return <div className="px-4 py-3 text-xs text-fg-muted italic">(empty diff)</div>;
  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="bg-violet-500/10 dark:bg-violet-500/5 text-violet-700 dark:text-violet-300 px-3 py-0.5 text-[11px]">{h.header}</div>
          {h.lines.map((ln, li) => <UnifiedLine key={li} line={ln} />)}
        </div>
      ))}
    </div>
  );
}

function UnifiedLine({ line }: { line: HunkLine }) {
  const bg = line.kind === "+" ? "bg-emerald-500/15 dark:bg-emerald-500/10"
    : line.kind === "-" ? "bg-rose-500/15 dark:bg-rose-500/10"
    : "";
  const mark = line.kind === "+" ? "text-emerald-600 dark:text-emerald-300"
    : line.kind === "-" ? "text-rose-600 dark:text-rose-300"
    : "text-fg-dim";
  return (
    <div className={clsx("grid grid-cols-[3rem_3rem_1.5rem_1fr] gap-0 px-0 items-start", bg)}>
      <span className="text-right pr-2 text-fg-dim select-none">{line.oldNo ?? ""}</span>
      <span className="text-right pr-2 text-fg-dim select-none">{line.newNo ?? ""}</span>
      <span className={clsx("text-center select-none", mark)}>{line.kind === " " ? "" : line.kind}</span>
      <pre className="whitespace-pre-wrap break-words text-fg min-w-0">{line.text}</pre>
    </div>
  );
}

// ── Split renderer ──────────────────────────────────────────────────────────

interface SplitRow { left: HunkLine | null; right: HunkLine | null; }

function pairHunk(h: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < h.lines.length) {
    const ln = h.lines[i];
    if (ln.kind === " ") {
      rows.push({ left: ln, right: ln });
      i++;
      continue;
    }
    // Collect contiguous - and + run
    const rems: HunkLine[] = [];
    const adds: HunkLine[] = [];
    while (i < h.lines.length && h.lines[i].kind === "-") { rems.push(h.lines[i]); i++; }
    while (i < h.lines.length && h.lines[i].kind === "+") { adds.push(h.lines[i]); i++; }
    const n = Math.max(rems.length, adds.length);
    for (let k = 0; k < n; k++) {
      rows.push({ left: rems[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

function SplitDiff({ text }: { text: string }) {
  const hunks = useMemo(() => parseHunks(text), [text]);
  if (hunks.length === 0) return <div className="px-4 py-3 text-xs text-fg-muted italic">(empty diff)</div>;
  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="bg-violet-500/10 dark:bg-violet-500/5 text-violet-700 dark:text-violet-300 px-3 py-0.5 text-[11px]">{h.header}</div>
          {pairHunk(h).map((row, ri) => <SplitRowView key={ri} row={row} />)}
        </div>
      ))}
    </div>
  );
}

function SplitRowView({ row }: { row: SplitRow }) {
  return (
    <div className="grid grid-cols-2 gap-px bg-surface-3 items-stretch">
      <SplitCell side="left" line={row.left} />
      <SplitCell side="right" line={row.right} />
    </div>
  );
}

function SplitCell({ line, side }: { line: HunkLine | null; side: "left" | "right" }) {
  if (!line) {
    return <div className="bg-surface-3" />;
  }
  const bg = line.kind === "+" ? "bg-emerald-500/15 dark:bg-emerald-500/10"
    : line.kind === "-" ? "bg-rose-500/15 dark:bg-rose-500/10"
    : "bg-surface-2";
  const no = side === "left" ? line.oldNo : line.newNo;
  return (
    <div className={clsx("grid grid-cols-[3rem_1fr] gap-0 items-start min-w-0", bg)}>
      <span className="text-right pr-2 text-fg-dim select-none">{no ?? ""}</span>
      <pre className="whitespace-pre-wrap break-words text-fg pr-2 min-w-0">{line.text}</pre>
    </div>
  );
}
