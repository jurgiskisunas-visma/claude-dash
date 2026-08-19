import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import type { SessionSummary } from "../types/api";
import { Chip } from "./Chip";
import { useSessionName } from "../hooks/useSessionName";
import { Kbd } from "./Kbd";
import { subscribeCommands, type Command } from "../lib/commands";
import { usePinnedSet } from "../hooks/usePinned";
import { togglePin } from "../lib/pinnedSessions";
import {
  getSnapshot as getHiddenSnapshot,
  hideSession,
  isHidden,
  subscribe as subscribeHidden,
  unhideSession,
} from "../lib/hiddenSessions";
import {
  getSnapshot as getActiveSnapshot,
  subscribe as subscribeActive,
} from "../lib/activeWork";

type ListMode = "panel" | "rail";
const MODE_KEY = "claudedash:session-list-mode";

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  workingIds: Set<string>;
  terminalKeys: Set<string>; // session IDs that have an open terminal
  onNewSession: () => void;
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  workingIds,
  terminalKeys,
  onNewSession,
}: Props) {
  const [query, setQuery] = useState("");
  const [liveOnly, setLiveOnly] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const hidden = useSyncExternalStore(subscribeHidden, getHiddenSnapshot);

  // Two layouts. "panel" is the resizable column; "rail" collapses to a strip of numbered
  // stops that expands *over* the detail pane while the pointer is on it — so a small screen
  // keeps the space but still switches sessions without a toggle.
  const [mode, setMode] = useState<ListMode>(
    () => (localStorage.getItem(MODE_KEY) === "rail" ? "rail" : "panel"),
  );
  const chooseMode = (m: ListMode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
    setPeeking(false);
    setLeaving(false);
  };

  // `peeking` keeps the overlay mounted; `leaving` plays the exit animation before unmount.
  const [peeking, setPeeking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const peekRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | null>(null);

  const openPeek = () => {
    if (leaveTimer.current !== null) { window.clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    setLeaving(false);
    setPeeking(true);
  };
  const closePeek = () => {
    if (leaveTimer.current !== null || !peeking) return;
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      setPeeking(false);
      setLeaving(false);
    }, 130);   // matches .peek-out
  };
  useEffect(() => () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
  }, []);

  // Closed by tracking what the pointer is actually over, rather than by mouseleave: the
  // overlay is an absolutely-positioned child extending far outside its 48px parent, and
  // boundary events there proved unreliable — an overlay stuck over the detail pane is the
  // worst failure this feature has. Containment covers the overlay's own edge grip too.
  useEffect(() => {
    if (!peeking || leaving) return;
    const onMove = (e: MouseEvent) => {
      const host = peekRef.current;
      if (!host) return;
      if (!host.contains(e.target as Node)) closePeek();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePeek(); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peeking, leaving]);

  // Pane width (px), persisted, drag-or-toggle. Compact layout kicks in below 340px.
  const [width, setWidth] = useState<number>(() => {
    const v = parseInt(localStorage.getItem("claudedash:session-list-width") ?? "", 10);
    return Number.isFinite(v) && v >= 200 && v <= 800 ? v : 460;
  });
  useEffect(() => {
    localStorage.setItem("claudedash:session-list-width", String(width));
  }, [width]);
  const compact = width < 340;

  // Drag-to-resize via the right edge.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onDragStart = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startW: width };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const next = Math.max(200, Math.min(800, dragRef.current.startW + dx));
      setWidth(next);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (isAutomationSession(s)) return false;
      if (!showHidden && hidden.has(s.sessionId)) return false;
      if (liveOnly && !s.isLive) return false;
      if (!q) return true;
      return (
        s.dirLabel.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        (s.gitBranch?.toLowerCase().includes(q) ?? false) ||
        (s.firstUserPrompt?.toLowerCase().includes(q) ?? false) ||
        s.jiraKeys.some((k) => k.toLowerCase().includes(q))
      );
    });
  }, [sessions, query, liveOnly, hidden, showHidden]);
  const hiddenCount = useMemo(
    () => sessions.reduce((n, s) => n + (hidden.has(s.sessionId) ? 1 : 0), 0),
    [sessions, hidden],
  );

  // The header's active-work strip is the source of truth for "am I working on this".
  // Rows for tracked sessions stay fully visible and float to the top of their group,
  // in the same order the cubes appear; everything else greys out.
  const activeWork = useSyncExternalStore(subscribeActive, getActiveSnapshot);
  const activeRank = useMemo(
    () => new Map(activeWork.map((id, i) => [id, i])),
    [activeWork],
  );
  // Array.sort is stable, so equal-rank rows keep their incoming (recency) order.
  const activeFirst = useMemo(
    () => (rows: SessionSummary[]) => [...rows].sort((a, b) => {
      const ra = activeRank.get(a.sessionId);
      const rb = activeRank.get(b.sessionId);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return 0;
    }),
    [activeRank],
  );

  const pinned = usePinnedSet();
  const pinnedRows = useMemo(
    () => activeFirst(filtered.filter(s => pinned.has(s.sessionId))),
    [filtered, pinned, activeFirst],
  );
  const withTerm = useMemo(
    () => activeFirst(filtered.filter(s => !pinned.has(s.sessionId) && terminalKeys.has(s.sessionId))),
    [filtered, pinned, terminalKeys, activeFirst],
  );
  const withoutTermAll = useMemo(
    () => activeFirst(filtered.filter(s => !pinned.has(s.sessionId) && !terminalKeys.has(s.sessionId))),
    [filtered, pinned, terminalKeys, activeFirst],
  );

  // Age-based visibility: >10d is hidden behind "Show older", unless the session is in
  // the active-work strip. Greying is driven by active-work membership, not age.
  // When a search query is active we ignore age and show everything matching.
  const now = Date.now();
  const isSearching = query.trim().length > 0;
  const ARCHIVE_DAYS = 10;
  const ageDays = (s: SessionSummary) =>
    (now - new Date(s.lastActivity).getTime()) / (1000 * 60 * 60 * 24);
  const visibleHistory = useMemo(() => {
    if (isSearching) return withoutTermAll;
    return withoutTermAll.filter(s =>
      showOld || activeRank.has(s.sessionId) || ageDays(s) <= ARCHIVE_DAYS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withoutTermAll, isSearching, showOld, now, activeRank]);
  const hiddenOldCount = withoutTermAll.length - visibleHistory.length;

  // Rows in the order they are actually rendered — j/k has to follow what the user sees,
  // not the raw session array.
  const orderedIds = useMemo(
    () => [...pinnedRows, ...withTerm, ...visibleHistory].map((s) => s.sessionId),
    [pinnedRows, withTerm, visibleHistory],
  );
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeCommands((cmd: Command) => {
    if (cmd === "list.search") {
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    if (cmd === "escape" && document.activeElement === searchRef.current) {
      searchRef.current?.blur();
      return;
    }
    if (cmd !== "nav.next" && cmd !== "nav.prev") return;
    if (orderedIds.length === 0) return;
    const at = selectedId ? orderedIds.indexOf(selectedId) : -1;
    const step = cmd === "nav.next" ? 1 : -1;
    const next = at === -1
      ? orderedIds[cmd === "nav.next" ? 0 : orderedIds.length - 1]
      : orderedIds[Math.min(orderedIds.length - 1, Math.max(0, at + step))];
    if (next) onSelect(next);
  }), [orderedIds, selectedId, onSelect]);

  // Keep the selected row in view when it moves under the keyboard.
  useEffect(() => {
    if (!selectedId) return;
    const el = document.querySelector(`[data-session-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const panel = (
    <>
      <div className="px-3.5 pt-3 pb-2.5 seam space-y-2.5">
        <div className="flex items-center gap-2">
          <h2 className="label">Sessions</h2>
          <span className="text-2xs text-fg-dim tabular-nums">{filtered.length} of {sessions.length}</span>
          <span className="ml-auto flex items-center gap-1 text-2xs text-fg-dim">
            <Kbd>J</Kbd><Kbd>K</Kbd>
          </span>
          <button
            onClick={onNewSession}
            className="btn-accent press flex items-center gap-1.5 text-xs px-3 py-1"
            title="Start a new claude session in a directory (N)"
          >New <Kbd>N</Kbd></button>
        </div>
        <div className="relative">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search directory, branch, prompt, key"
            className="field w-full text-xs pl-2.5 pr-7 py-1.5"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
            <Kbd>/</Kbd>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setLiveOnly((v) => !v)}
            className={clsx("px-2.5 py-0.5 text-2xs", liveOnly ? "pill pill-on" : "pill")}
          >
            Live only
          </button>
          <button
            onClick={() => setShowHidden((v) => !v)}
            className={clsx("px-2.5 py-0.5 text-2xs", showHidden ? "pill pill-on" : "pill")}
          >
            Hidden{hiddenCount > 0 ? ` ${hiddenCount}` : ""}
          </button>
        </div>
      </div>
      <ul className="overflow-y-auto flex-1 pb-2">
        {pinnedRows.length > 0 && (
          <li>
            <GroupHeader label="Pinned" tone="amber" count={pinnedRows.length} />
          </li>
        )}
        {pinnedRows.map((s) => (
          <SessionRow
            key={s.sessionId}
            session={s}
            selectedId={selectedId}
            workingIds={workingIds}
            onSelect={onSelect}
            hasTerm={terminalKeys.has(s.sessionId)}
            pinned
            faded={!activeRank.has(s.sessionId)}
            compact={compact}
          />
        ))}
        {withTerm.length > 0 && (
          <li>
            <GroupHeader label="Open terminals" tone="sky" count={withTerm.length} />
          </li>
        )}
        {withTerm.map((s) => (
          <SessionRow
            key={s.sessionId}
            session={s}
            selectedId={selectedId}
            workingIds={workingIds}
            onSelect={onSelect}
            hasTerm
            faded={!activeRank.has(s.sessionId)}
            compact={compact}
          />
        ))}
        {visibleHistory.length > 0 && (
          <li>
            <GroupHeader label={withTerm.length > 0 ? "History" : "All sessions"} tone="zinc" count={withoutTermAll.length} />
          </li>
        )}
        {visibleHistory.map((s) => (
          <SessionRow
            key={s.sessionId}
            session={s}
            selectedId={selectedId}
            workingIds={workingIds}
            onSelect={onSelect}
            hasTerm={false}
            faded={!activeRank.has(s.sessionId)}
            compact={compact}
          />
        ))}
        {!isSearching && hiddenOldCount > 0 && (
          <li className="px-4 py-3 text-center">
            <button
              onClick={() => setShowOld(true)}
              className="pill text-xs px-3 py-1.5"
            >
              📦 Show {hiddenOldCount} older session{hiddenOldCount === 1 ? "" : "s"} (&gt; {ARCHIVE_DAYS} days)
            </button>
          </li>
        )}
        {!isSearching && showOld && hiddenOldCount === 0 && withoutTermAll.length > 0 && (
          <li className="px-4 py-2 text-center">
            <button
              onClick={() => setShowOld(false)}
              className="text-[11px] text-fg-dim hover:text-fg"
            >
              ↑ Hide older sessions
            </button>
          </li>
        )}
      </ul>

    </>
  );

  if (mode === "rail") {
    return (
      <div
        ref={peekRef}
        className="shrink-0 relative"
        onMouseEnter={openPeek}
      >
        <Rail
          sessions={orderedIds.map((id) => filtered.find((s) => s.sessionId === id)!).filter(Boolean)}
          selectedId={selectedId}
          workingIds={workingIds}
          terminalKeys={terminalKeys}
          onSelect={onSelect}
          onExpand={() => chooseMode("panel")}
        />
        {peeking && (
          <div
            className={clsx(
              "tile absolute left-0 top-0 h-full z-30 flex flex-col shadow-pop",
              leaving ? "peek-out" : "peek-in",
            )}
            style={{ width: `${Math.max(width, 360)}px` }}
          >
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-tile">
              {panel}
            </div>
            {/* Mirrors the panel's grip, so expanding back is in the same place either way. */}
            <button
              onClick={() => chooseMode("panel")}
              title="Back to the full list"
              className="absolute top-1/2 -translate-y-1/2 -right-4 w-4 h-12 rounded-r-md bg-surface-solid border border-hairline border-l-0 text-fg-dim hover:text-accent text-xs flex items-center justify-center"
            >›</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="tile shrink-0 flex flex-col relative overflow-hidden"
      style={{ width: `${width}px` }}
    >
      {panel}

      {/* Right-edge drag handle + collapse toggle. */}
      <div
        onMouseDown={onDragStart}
        className="absolute top-0 right-0 h-full w-1.5 cursor-ew-resize group/grip hover:bg-accent-soft transition-colors"
        title="Drag to resize"
      >
        <button
          onClick={() => chooseMode("rail")}
          onMouseDown={(e) => e.stopPropagation()}
          title="Collapse to a rail — hover it to peek at the list"
          className="absolute top-1/2 -translate-y-1/2 right-0 w-4 h-12 rounded-l-md bg-surface-solid border border-hairline border-r-0 text-fg-dim hover:text-accent text-xs opacity-0 group-hover/grip:opacity-100 transition-opacity flex items-center justify-center"
        >‹</button>
      </div>
    </div>
  );
}

/**
 * The collapsed rail: one numbered stop per session, in list order, with the same status dot
 * the rows use. Clicking selects; hovering anywhere on the rail opens the full list as an
 * overlay (handled by the parent), so switching sessions never needs a toggle.
 */
function Rail({
  sessions, selectedId, workingIds, terminalKeys, onSelect, onExpand,
}: {
  sessions: SessionSummary[];
  selectedId: string | null;
  workingIds: Set<string>;
  terminalKeys: Set<string>;
  onSelect: (id: string) => void;
  onExpand: () => void;
}) {
  return (
    <div className="tile h-full w-12 flex flex-col items-center py-2 gap-1 overflow-hidden">
      <button
        onClick={onExpand}
        title="Back to the full list"
        className="pill press w-8 h-6 grid place-items-center text-2xs shrink-0"
      >›</button>
      <div className="w-full flex-1 overflow-y-auto no-scrollbar flex flex-col items-center gap-1 pt-1">
        {sessions.map((s, i) => (
          <RailStop
            key={s.sessionId}
            session={s}
            index={i + 1}
            selected={s.sessionId === selectedId}
            working={workingIds.has(s.sessionId)}
            hasTerm={terminalKeys.has(s.sessionId)}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function RailStop({
  session: s, index, selected, working, hasTerm, onSelect,
}: {
  session: SessionSummary;
  index: number;
  selected: boolean;
  working: boolean;
  hasTerm: boolean;
  onSelect: (id: string) => void;
}) {
  const [name] = useSessionName(s.sessionId);
  const dot = working ? "bg-amber-400 animate-pulse"
    : s.isLive ? "bg-emerald-400"
    : "bg-fg-dim/40";
  return (
    <button
      data-session-id={s.sessionId}
      onClick={() => onSelect(s.sessionId)}
      title={`${index}. ${name ?? s.dirLabel}${s.gitBranch ? ` (${s.gitBranch})` : ""}`}
      className={clsx(
        "press relative w-8 h-8 shrink-0 rounded-lg grid place-items-center text-2xs tabular-nums transition-colors",
        selected ? "bg-accent-soft text-accent ring-1 ring-inset ring-accent-ring" : "text-fg-dim hover:bg-surface-3 hover:text-fg",
      )}
    >
      {index}
      <span className={clsx("absolute top-1 right-1 w-1.5 h-1.5 rounded-full", dot)} />
      {hasTerm && <span className="absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full bg-sky-400/70" />}
    </button>
  );
}

// Sessions spawned by an automated pipeline (rather than by a person) open with prompts
// like "You are stage 3 of an automated pipeline." Matching the first user prompt is the
// only reliable signal — such runs share the cwd with the sessions you start by hand.
const AUTOMATION_PROMPT_RE = /^you are stage \d+\b|\bof an automated pipeline\b|# Output discipline \(applies to every stage\)/i;
function isAutomationSession(s: SessionSummary): boolean {
  const p = s.firstUserPrompt;
  if (!p) return false;
  return AUTOMATION_PROMPT_RE.test(p);
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function GroupHeader({ label, tone, count }: { label: string; tone: "sky" | "zinc" | "amber"; count: number }) {
  const dot = { sky: "bg-sky-400", amber: "bg-amber-400", zinc: "bg-fg-dim" }[tone];
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-3.5 pt-3 pb-1.5 bg-surface backdrop-blur-xl">
      <span className={clsx("w-1 h-1 rounded-full", dot)} />
      <span className="label">{label}</span>
      <span className="text-2xs text-fg-dim tabular-nums ml-auto">{count}</span>
    </div>
  );
}

function SessionRow({
  session: s, selectedId, workingIds, onSelect, hasTerm, faded = false, pinned = false,
  compact = false,
}: {
  session: SessionSummary;
  selectedId: string | null;
  workingIds: Set<string>;
  onSelect: (id: string) => void;
  hasTerm: boolean;
  faded?: boolean;
  pinned?: boolean;
  compact?: boolean;
}) {
  const active = s.sessionId === selectedId;
  const working = workingIds.has(s.sessionId);
  const [name] = useSessionName(s.sessionId);
  const hiddenRow = isHidden(s.sessionId);
  return (
    <li className={clsx(
      "px-2 py-px transition-opacity",
      faded && !active && "opacity-50 hover:opacity-100",
    )}>
      <button
        data-session-id={s.sessionId}
        onClick={() => onSelect(s.sessionId)}
        style={active
          ? { backgroundImage: "linear-gradient(100deg, var(--c-accent-soft), transparent 82%)" }
          : undefined}
        className={clsx(
          "group/row row-press relative w-full text-left pl-3 pr-2 py-2.5 rounded-xl block",
          active ? "bg-accent-soft" : "hover:bg-surface-3",
        )}
      >
        {/* Rail: accent when selected, a hint of tone for pinned / attached rows. */}
        <span
          aria-hidden
          className={clsx(
            "absolute left-0 top-2 bottom-2 w-[2px] rounded-full origin-center transition-all duration-200",
            active ? "bg-accent scale-y-100" : pinned ? "bg-amber-400/60 scale-y-100" : hasTerm ? "bg-sky-400/50 scale-y-100" : "bg-transparent scale-y-[0.35]",
          )}
        />
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            {working ? (
              <span
                title="Working — recent activity"
                className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0"
              />
            ) : s.isLive ? (
              <span
                title="Live Claude Code session (idle)"
                className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"
              />
            ) : (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-fg-dim/35 shrink-0" />
            )}
            {s.agentColor && (
              <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: s.agentColor }} />
            )}
            {name ? (
              <span className="text-sm font-semibold text-fg truncate" title={name}>{name}</span>
            ) : (
              <code className="text-xs text-fg-muted truncate">{s.sessionId.slice(0, 8)}</code>
            )}
            {hasTerm && (
              <span title="Terminal attached" className="text-2xs text-sky-600 dark:text-sky-300 shrink-0">
                TTY
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); togglePin(s.sessionId); }}
              title={pinned ? "Unpin" : "Pin"}
              className={clsx(
                "text-2xs leading-none px-1 py-1 rounded-md transition-colors",
                pinned
                  ? "text-amber-500 dark:text-amber-300"
                  : "row-action",
              )}
            >{pinned ? "★" : "☆"}</button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (hiddenRow) unhideSession(s.sessionId);
                else hideSession(s.sessionId);
              }}
              title={hiddenRow ? "Unhide from list" : "Hide from list (stays on disk)"}
              className={clsx(
                "text-2xs leading-none px-1 py-1 rounded-md transition-colors",
                hiddenRow ? "text-rose-500 dark:text-rose-300" : "row-action hover:!text-rose-500",
              )}
            >✕</button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1 mb-1">
          <Chip tone="blue" title={s.cwd}>{s.dirLabel}</Chip>
          {s.gitBranch && s.gitBranch !== "HEAD" && (
            <Chip tone="violet" title={`branch: ${s.gitBranch}`}>⎇ {s.gitBranch}</Chip>
          )}
          {s.isWorktree && <Chip tone="amber">worktree</Chip>}
          {s.jiraKeys.map((k) => <Chip key={k} tone="rose">{k}</Chip>)}
        </div>

        {!compact && s.firstUserPrompt && (
          <p className="text-xs text-fg-muted line-clamp-2 leading-snug">{s.firstUserPrompt}</p>
        )}
        <div className="text-2xs text-fg-dim mt-1.5 tabular-nums">
          {formatRelative(s.lastActivity)}
          {!compact && <span> · {s.messageCount} msg</span>}
        </div>
      </button>
    </li>
  );
}
