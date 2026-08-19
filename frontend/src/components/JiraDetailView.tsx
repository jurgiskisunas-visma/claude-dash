import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "../api/client";
import type { JiraIssueDetail } from "../types/api";

// Workflow statuses in order — position drives the back/forward transition buttons.
// Jira workflows differ per install, so this comes from config (`Jira__StatusLadder` /
// `JIRA_STATUS_LADDER` in .env) with a generic default.
const DEFAULT_STATUS_LADDER = ["To Do", "In Progress", "In Review", "Done"];

function useStatusLadder(): string[] {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: Infinity });
  const configured = health.data?.jiraStatusLadder;
  return configured && configured.length > 0 ? configured : DEFAULT_STATUS_LADDER;
}

function ladderIndex(ladder: string[], status: string | null | undefined): number {
  if (!status) return -1;
  return ladder.findIndex(s => s.toLowerCase() === status.toLowerCase());
}

interface Props {
  jiraKeys: string[];
}

export function JiraDetailView({ jiraKeys }: Props) {
  if (jiraKeys.length === 0) {
    return <div className="p-6 text-fg-muted text-sm italic">No Jira keys detected for this session.</div>;
  }
  return (
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
      {jiraKeys.map((k) => <IssueCard key={k} issueKey={k} />)}
    </div>
  );
}

function IssueCard({ issueKey }: { issueKey: string }) {
  const q = useQuery({
    queryKey: ["jira-issue", issueKey],
    queryFn: () => api.jiraIssue(issueKey),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
  const [showComments, setShowComments] = useState(true);
  const [showDescription, setShowDescription] = useState(true);
  const qc = useQueryClient();
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [transitionErr, setTransitionErr] = useState<string | null>(null);

  async function transition(target: string) {
    const clearAssignee = target.toLowerCase() === "closed";
    setTransitioning(target);
    setTransitionErr(null);
    try {
      const res = await api.jiraTransition(issueKey, target, clearAssignee);
      if (res.warning) setTransitionErr(res.warning);
      await qc.invalidateQueries({ queryKey: ["jira-issue", issueKey] });
    } catch (e) {
      setTransitionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTransitioning(null);
    }
  }

  if (q.isLoading) {
    return (
      <div className="rounded-2xl border border-hairline-strong bg-surface-2 p-4 animate-pulse">
        <div className="text-xs text-fg-muted">Loading {issueKey}…</div>
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className="rounded-xl border border-rose-400/30 bg-rose-500/5 p-4">
        <div className="text-xs text-rose-600 dark:text-rose-300">
          Failed to load {issueKey}. {q.error ? String(q.error) : "Check the Jira credentials — and any VPN the host requires."}
        </div>
      </div>
    );
  }
  const d: JiraIssueDetail = q.data;
  const sc = (d.statusCategory ?? "").toLowerCase();
  const statusClass = sc.includes("done")
    ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-700 dark:text-emerald-200"
    : sc.includes("indeterminate")
      ? "bg-amber-500/15 border-amber-400/40 text-amber-700 dark:text-amber-200"
      : sc.includes("new") || sc.includes("undefined")
        ? "bg-sky-500/15 border-sky-400/40 text-sky-700 dark:text-sky-200"
        : "bg-surface-3 bg-surface-3 border-hairline-strong text-fg-muted";

  return (
    <section className="rounded-2xl border border-violet-400/20 bg-gradient-to-br from-violet-500/8 via-white/60  to-transparent p-4">
      <header className="flex items-start gap-3 flex-wrap mb-2">
        <a
          href={d.url}
          target="_blank"
          rel="noreferrer"
          className="text-rose-600 dark:text-rose-300 hover:text-rose-500 dark:hover:text-rose-200 font-mono font-semibold text-sm shrink-0"
          title={d.url}
        >{d.key} ↗</a>
        <h3 className="text-sm font-semibold text-fg flex-1">{d.summary}</h3>
        <span className={clsx("px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider border", statusClass)}>
          {d.status || "—"}
        </span>
      </header>

      <StatusChanger
        current={d.status}
        busy={transitioning}
        error={transitionErr}
        onPick={transition}
      />

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-muted mb-3">
        {d.priority && <span><span className="text-fg-muted">priority:</span> <span className="text-fg">{d.priority}</span></span>}
        {d.assignee && <span><span className="text-fg-muted">assignee:</span> <span className="text-fg">{d.assignee}</span></span>}
        {d.reporter && <span><span className="text-fg-muted">reporter:</span> <span className="text-fg">{d.reporter}</span></span>}
        {d.updated && <span><span className="text-fg-muted">updated:</span> <span className="text-fg">{relTime(d.updated)}</span></span>}
        {d.parent && <span><span className="text-fg-muted">parent:</span> <a className="text-rose-600 dark:text-rose-300 hover:text-rose-500 dark:hover:text-rose-200 font-mono" href={d.url.replace(d.key, d.parent)} target="_blank" rel="noreferrer">{d.parent}</a></span>}
      </div>

      {(d.labels.length > 0 || d.fixVersions.length > 0 || d.subtasks.length > 0) && (
        <div className="flex flex-wrap gap-1 mb-3">
          {d.labels.map((l) => (
            <span key={l} className="px-1.5 py-0.5 text-[10px] rounded-full border border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-200">🏷 {l}</span>
          ))}
          {d.fixVersions.map((v) => (
            <span key={v} className="px-1.5 py-0.5 text-[10px] rounded-full border border-sky-400/30 bg-sky-400/10 text-sky-700 dark:text-sky-200">🚢 {v}</span>
          ))}
          {d.subtasks.map((s) => (
            <span key={s} className="px-1.5 py-0.5 text-[10px] rounded-full border border-violet-400/30 bg-violet-400/10 text-violet-700 dark:text-violet-200 font-mono">↳ {s}</span>
          ))}
        </div>
      )}

      {(d.descriptionHtml || (d.description && d.description.trim())) && (
        <div className="mb-3">
          <button
            onClick={() => setShowDescription(v => !v)}
            className="text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg dark:hover:text-fg mb-1.5"
          >
            {showDescription ? "▾" : "▸"} Description
          </button>
          {showDescription && (
            d.descriptionHtml
              ? <RenderedHtml html={d.descriptionHtml} maxHeightClass="max-h-[32rem]" />
              : <pre className="text-xs text-fg whitespace-pre-wrap font-sans leading-relaxed bg-surface-3 border border-hairline rounded-md p-3 max-h-96 overflow-y-auto">
                  {d.description}
                </pre>
          )}
        </div>
      )}

      {d.attachments.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-1.5">
            📎 Attachments ({d.attachments.length})
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {d.attachments.map((a, i) => (
              <li key={i}>
                <a
                  href={a.contentUrl ?? d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-md border border-hairline-strong bg-surface-3 text-fg hover:bg-violet-500/10 hover:border-violet-400/40 transition-colors"
                  title={`${a.filename}  ·  ${formatBytes(a.size)}${a.author ? `  ·  by ${a.author}` : ""}`}
                >
                  <span>{fileIcon(a.mimeType, a.filename)}</span>
                  <span className="truncate max-w-[16rem]">{a.filename}</span>
                  <span className="text-fg-muted font-mono text-[10px]">{formatBytes(a.size)}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.comments.length > 0 && (
        <div>
          <button
            onClick={() => setShowComments(v => !v)}
            className="text-[10px] uppercase tracking-wider text-fg-muted hover:text-fg dark:hover:text-fg mb-1.5"
          >
            {showComments ? "▾" : "▸"} Comments ({d.comments.length})
          </button>
          {showComments && (
            <ul className="space-y-2">
              {d.comments.map((c, i) => (
                <li key={i} className="rounded-md border border-hairline bg-surface-3 p-2.5">
                  <div className="flex items-baseline gap-2 mb-1 text-[11px]">
                    <span className="font-medium text-fg">{c.author}</span>
                    {c.created && <span className="text-fg-muted">{relTime(c.created)}</span>}
                    {c.updated && c.updated !== c.created && (
                      <span className="text-fg-dim">(edited {relTime(c.updated)})</span>
                    )}
                  </div>
                  {c.bodyHtml
                    ? <RenderedHtml html={c.bodyHtml} />
                    : <pre className="text-xs text-fg whitespace-pre-wrap font-sans leading-relaxed">{c.body}</pre>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function StatusChanger({
  current, busy, error, onPick,
}: {
  current: string;
  busy: string | null;
  error: string | null;
  onPick: (target: string) => void;
}) {
  const ladder = useStatusLadder();
  const idx = ladderIndex(ladder, current);
  const prev = idx > 0 ? ladder[idx - 1] : null;
  const next = idx >= 0 && idx < ladder.length - 1 ? ladder[idx + 1] : null;
  return (
    <div className="mb-3 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">Move</span>
        <button
          disabled={!prev || busy !== null}
          onClick={() => prev && onPick(prev)}
          title={prev ? `Move back to ${prev}` : "Already at the start"}
          className="pill press px-2 py-0.5 text-xs disabled:opacity-30"
        >← {prev ?? "—"}</button>
        <button
          disabled={!next || busy !== null}
          onClick={() => next && onPick(next)}
          title={next ? (next.toLowerCase() === "closed" ? `Close (also clears assignee)` : `Move forward to ${next}`) : "Already at the end"}
          className="pill pill-on press px-2 py-0.5 text-xs disabled:opacity-30"
        >{next ?? "—"} →</button>
        <span className="text-2xs text-fg-dim">or</span>
        <select
          disabled={busy !== null}
          value=""
          onChange={(e) => { if (e.target.value) onPick(e.target.value); }}
          className="field px-1.5 py-0.5 text-xs"
        >
          <option value="">jump to…</option>
          {ladder.filter((s) => s.toLowerCase() !== current.toLowerCase()).map((s) => (
            <option key={s} value={s}>{s}{s.toLowerCase() === "closed" ? " (clears assignee)" : ""}</option>
          ))}
        </select>
        {busy && <span className="text-[10px] text-amber-600 dark:text-amber-300 animate-pulse">transitioning → {busy}…</span>}
      </div>
      {error && (
        <div className="text-[11px] text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-400/30 rounded px-2 py-1">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Renders Jira-provided HTML. The HTML comes from our own server which trusts the
 * configured Jira instance — we're not displaying arbitrary user content from the
 * open web. We strip <script> tags as a defence-in-depth precaution. For full XSS
 * protection a real sanitizer (DOMPurify) would be needed, but this is a local
 * single-user tool.
 */
function RenderedHtml({ html, maxHeightClass = "max-h-96" }: { html: string; maxHeightClass?: string }) {
  const clean = useMemo(() => stripScripts(html), [html]);
  return (
    <div
      className={clsx(
        "jira-html text-sm leading-relaxed bg-surface-3 border border-hairline rounded-md p-3 overflow-y-auto",
        maxHeightClass,
      )}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

function stripScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+="[^"]*"/gi, "")
    .replace(/\son[a-z]+='[^']*'/gi, "");
}

function fileIcon(mime: string | null, filename: string): string {
  const m = (mime ?? "").toLowerCase();
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (m.startsWith("image/")) return "🖼️";
  if (m.startsWith("video/")) return "🎬";
  if (m.startsWith("audio/")) return "🎵";
  if (m.includes("pdf") || ext === "pdf") return "📕";
  if (m.includes("zip") || m.includes("compressed") || ["zip","tar","gz","7z","rar"].includes(ext)) return "🗜️";
  if (m.includes("word") || ["doc","docx"].includes(ext)) return "📄";
  if (m.includes("excel") || m.includes("spreadsheet") || ["xls","xlsx","csv"].includes(ext)) return "📊";
  if (m.includes("powerpoint") || m.includes("presentation") || ["ppt","pptx"].includes(ext)) return "📽️";
  if (m.startsWith("text/") || ["md","log","json","xml","yml","yaml","ini","cfg"].includes(ext)) return "📝";
  if (["cs","ts","tsx","js","jsx","py","go","rs","java","cpp","c","h","sh","ps1"].includes(ext)) return "🧾";
  return "📎";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
