import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api/client";
import { useChangeFeed } from "./hooks/useChangeFeed";
import { useChime } from "./hooks/useChime";
import { SessionList } from "./components/SessionList";
import { SessionDetail } from "./components/SessionDetail";
import { NewSessionModal, encodeWorkspaceId } from "./components/NewSessionModal";
import { ActiveWorkBar } from "./components/ActiveWorkBar";
import { Kbd } from "./components/Kbd";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { useHotkeys } from "./hooks/useHotkeys";
import { subscribeCommands, type Command } from "./lib/commands";
import { togglePin } from "./lib/pinnedSessions";
import { hideSession, isHidden, unhideSession } from "./lib/hiddenSessions";
import { ScratchTerminal } from "./components/ScratchTerminal";
import {
  forceTrackSession,
  getSnapshot as getActiveWork,
  trackSession,
  untrackSession,
} from "./lib/activeWork";
import { rememberPath } from "./lib/recentPaths";
import {
  focusTerminal,
  getFocusScope,
  isTerminalFocused,
  releaseTerminalFocus,
  subscribeFocusScope,
  trackTerminalFocus,
} from "./lib/terminalFocus";
import { ensureTerminal, listKeys, makeKey, renameTerminal, restoreFromServer, subscribeToList } from "./terminalStore";
import { getSnapshot as getNameSnapshot, tryClaimPendingName } from "./lib/sessionNames";
import { cycleTheme, getThemeMode, subscribeTheme } from "./lib/theme";
import type { ChangeEvent } from "./types/api";

/** One header counter: a status dot and a number. Dimmed when it reads zero. */
function Stat({ dot, value, title }: { dot: string; value: number; title: string }) {
  return (
    <span
      title={title}
      className={clsx("flex items-center gap-1.5", value === 0 && "opacity-40")}
    >
      <span className={clsx("w-1.5 h-1.5 rounded-full", dot)} />
      {value}
    </span>
  );
}

/** Normalizes a host path for comparison (trailing separators + case). */
function normCwd(p: string | undefined | null): string | null {
  if (!p) return null;
  return p.replace(/[\\/]+$/, "").toLowerCase();
}

function parseHash(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/");
  return parts[0] === "sessions" && parts[1] ? decodeURIComponent(parts[1]) : null;
}

function writeHash(sessionId: string | null) {
  const target = sessionId ? `#/sessions/${encodeURIComponent(sessionId)}` : "#/sessions";
  if (window.location.hash !== target) {
    window.history.replaceState(null, "", target);
  }
}

export default function App() {
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(() => parseHash());
  const [showNewSession, setShowNewSession] = useState(false);
  // Tracks an in-flight "start new session" request: workspaceId + the wall-clock
  // time we kicked it off, so we can wait for a session created after that point
  // rather than grabbing whatever existing session happens to live in that workspace.
  const [pendingLaunch, setPendingLaunch] = useState<
    { workspaceId: string; at: number; launchKey: string } | null
  >(null);
  const chime = useChime();
  const [chimeEnabled, setChimeEnabled] = useState(true);
  const [scratchOpen, setScratchOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const themeMode = useSyncExternalStore(subscribeTheme, getThemeMode);

  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const sessions = useQuery({
    queryKey: ["all-sessions"],
    queryFn: () => api.allSessions(500),
    refetchInterval: 10_000,
  });
  // Polled more aggressively while a launch is pending so the placeholder
  // resolves quickly. /api/live picks up new claude.exe processes before they
  // write their first JSONL entry.
  const live = useQuery({
    queryKey: ["live"],
    queryFn: api.live,
    refetchInterval: 3_000,
  });
  // Dedicated cwd for the scratch-pad popup. Its sessions are filtered out of the
  // session list so "small talk" never shows up as real work.
  const scratch = useQuery({ queryKey: ["scratch"], queryFn: api.scratch, staleTime: Infinity });
  const scratchWs = scratch.data?.workspaceId ?? null;
  const scratchCwd = normCwd(scratch.data?.cwd);

  // Everything the session list, counters and auto-select see — scratch excluded.
  // Matched on both the encoded workspace id and the raw cwd so a change in
  // Claude Code's folder-encoding scheme can't leak scratch chatter into the list.
  const visibleSessions = useMemo(
    () => (sessions.data ?? []).filter((s) =>
      s.workspaceId !== scratchWs &&
      normCwd(s.cwd) !== scratchCwd),
    [sessions.data, scratchWs, scratchCwd],
  );

  // Global keyboard map. Bare keys when not typing, Alt+key everywhere — see lib/shortcuts.
  useHotkeys();
  useEffect(trackTerminalFocus, []);
  const focusScope = useSyncExternalStore(subscribeFocusScope, getFocusScope);
  useEffect(() => subscribeCommands((cmd: Command) => {
    switch (cmd) {
      case "session.new":
        setShowNewSession(true);
        break;
      case "scratch.toggle":
        setScratchOpen((v) => !v);
        break;
      case "help.toggle":
        setShowHelp((v) => !v);
        break;
      case "session.pin":
        if (sessionId) togglePin(sessionId);
        break;
      case "session.hide":
        if (sessionId) {
          if (isHidden(sessionId)) unhideSession(sessionId);
          else hideSession(sessionId);
        }
        break;
      case "terminal.focus.toggle":
        // One key both ways: out of a terminal, or back into the one last used.
        if (isTerminalFocused()) releaseTerminalFocus();
        else focusTerminal();
        break;
      case "escape":
        setShowHelp(false);
        setShowNewSession(false);
        break;
    }
  }), [sessionId]);

  // Backend PTYs outlive the browser, so pick up whatever is still running. Runs once
  // per page load — closing the tab or reloading no longer loses a terminal.
  useEffect(() => { void restoreFromServer(); }, []);

  // Mirror the selected session to the URL hash.
  useEffect(() => { writeHash(sessionId); }, [sessionId]);

  // React to manual hash changes (back/forward buttons or pasted URL).
  useEffect(() => {
    const onHash = () => {
      const sid = parseHash();
      if (sid) setSessionId(sid);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Use the backend-derived status, not an activity-recency heuristic — otherwise the
  // indicator flickers off during brief gaps between tool calls.
  const workingIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of visibleSessions) {
      if (s.status === "working") set.add(s.sessionId);
    }
    return set;
  }, [visibleSessions]);

  const termKeys = useSyncExternalStore(subscribeToList, listKeys);
  const terminalSessionIds = useMemo(() => {
    const out = new Set<string>();
    for (const k of termKeys) {
      const sid = k.split("|")[1];
      if (sid) out.add(sid);
    }
    return out;
  }, [termKeys]);

  // Prefer the rich session record from /api/sessions, but fall back to a
  // synthesized one from /api/live so a brand-new claude.exe — which has no
  // JSONL yet — can still render its SessionDetail (and its terminal).
  const selectedSession = useMemo(() => {
    const fromList = sessions.data?.find((s) => s.sessionId === sessionId) ?? null;
    if (fromList) return fromList;
    if (!sessionId) return null;
    const l = live.data?.find((x) => x.sessionId === sessionId);
    if (!l) return null;
    const norm = l.cwd.replace(/\//g, "\\").replace(/\\+$/, "");
    const m = /^([A-Za-z]):\\(.*)$/.exec(norm);
    const wsId = m ? `${m[1].toUpperCase()}--${m[2].replace(/\\/g, "-")}` : norm.replace(/\\/g, "-");
    const leaf = norm.split("\\").pop() ?? norm;
    return {
      sessionId: l.sessionId,
      workspaceId: wsId,
      cwd: l.cwd,
      dirLabel: leaf,
      startedAt: l.startedAt,
      lastActivity: l.startedAt,
      messageCount: 0,
      agentColor: null,
      permissionMode: null,
      gitBranch: null,
      isWorktree: false,
      firstUserPrompt: null,
      isLive: true,
      pid: l.pid,
      jiraKeys: [],
      status: "working" as const,
    };
  }, [sessions.data, live.data, sessionId]);

  // Claim pending session names for any new session that just appeared.
  useEffect(() => {
    if (!sessions.data) return;
    const existing = getNameSnapshot();
    for (const s of sessions.data) {
      if (existing[s.sessionId]) continue;
      const started = s.startedAt ? new Date(s.startedAt) : undefined;
      tryClaimPendingName(s.sessionId, s.workspaceId, started);
    }
  }, [sessions.data]);

  // Auto-populate the active-work strip: any live session, plus whatever the user
  // opens. Cubes only leave the strip when the user closes them.
  //
  // Both effects wait for /api/scratch. Until it resolves, `visibleSessions` cannot exclude the
  // scratch workspace, and a scratch session that happened to be live would be tracked — which
  // then sticks, because the strip is persisted.
  useEffect(() => {
    if (!scratch.data) return;
    for (const s of visibleSessions) {
      if (s.isLive) trackSession(s.sessionId);
    }
  }, [visibleSessions, scratch.data]);
  useEffect(() => {
    if (!scratch.data) return;
    if (sessionId && visibleSessions.some((s) => s.sessionId === sessionId)) {
      trackSession(sessionId);
    }
  }, [sessionId, visibleSessions, scratch.data]);

  // The scratch pad is deliberately not work: drop it from the strip if it ever got in (an
  // older build, or the race above). untrackSession also records the dismissal, so the
  // auto-add rules leave it alone from here on.
  useEffect(() => {
    if (!scratch.data) return;
    for (const s of sessions.data ?? []) {
      if (s.workspaceId === scratchWs || normCwd(s.cwd) === scratchCwd) {
        untrackSession(s.sessionId);
      }
    }
    // Terminal keys carry a session id, except the two that aren't one: the scratch pad uses
    // the literal "scratch", and a session started from "+ New" uses a `launch-…` placeholder
    // until /api/live reveals its real id. Older builds tracked those verbatim.
    for (const id of getActiveWork()) {
      if (id === "scratch" || id.startsWith("launch-")) untrackSession(id);
    }
    // Cubes for sessions that no longer exist (transcript deleted, directory gone) would
    // otherwise sit there forever showing a bare id. Skipped while a launch is in flight,
    // since that session legitimately isn't in the list yet.
    if (sessions.data && !pendingLaunch) {
      const known = new Set(sessions.data.map((s) => s.sessionId));
      for (const id of getActiveWork()) {
        if (!known.has(id)) untrackSession(id);
      }
    }
  }, [sessions.data, scratch.data, scratchWs, scratchCwd, pendingLaunch]);

  // Opening a terminal is a deliberate act, so it re-adds the session even if its cube was
  // closed earlier. Only on the transition, though: re-applying it on every render would make
  // the cube's × do nothing for as long as the terminal stayed open. Restricted to ids that
  // are real sessions, which keeps the scratch pad and unpromoted launch keys out of the strip.
  const seenTerminalIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!scratch.data) return;
    const known = seenTerminalIds.current;
    for (const id of terminalSessionIds) {
      if (known.has(id)) continue;
      known.add(id);
      if (visibleSessions.some((s) => s.sessionId === id)) forceTrackSession(id);
    }
    for (const id of [...known]) {
      if (!terminalSessionIds.has(id)) known.delete(id);
    }
  }, [terminalSessionIds, visibleSessions, scratch.data]);

  // Promote the user to the new session's panel when its JSONL first arrives.
  // Give up after 60s.
  useEffect(() => {
    if (!pendingLaunch) return;
    const since = pendingLaunch.at - 5_000;
    const newSession = sessions.data
      ?.filter((s) => s.workspaceId === pendingLaunch.workspaceId)
      .find((s) => s.startedAt && new Date(s.startedAt).getTime() >= since);
    if (newSession) {
      setSessionId(newSession.sessionId);
      setPendingLaunch(null);
      return;
    }
    // Also check live processes — claude.exe spawns and reports a live pid
    // before it writes its first JSONL entry, so /api/sessions can lag by a
    // few seconds. Encode the cwd to match our workspaceId format.
    const encWs = (cwd: string) => {
      const norm = cwd.replace(/\//g, "\\").replace(/\\+$/, "");
      const m = /^([A-Za-z]):\\(.*)$/.exec(norm);
      return m ? `${m[1].toUpperCase()}--${m[2].replace(/\\/g, "-")}` : norm.replace(/\\/g, "-");
    };
    const newLive = live.data?.find((l) =>
      encWs(l.cwd) === pendingLaunch.workspaceId &&
      l.startedAt && new Date(l.startedAt).getTime() >= since);
    if (newLive) {
      // Migrate the launch-keyed terminal to a sessionId-keyed one so
      // SessionDetail can find it (it looks up by `ws|sessionId|new`).
      renameTerminal(pendingLaunch.launchKey, makeKey(pendingLaunch.workspaceId, newLive.sessionId, "new"));
      setSessionId(newLive.sessionId);
      setPendingLaunch(null);
      return;
    }
    if (Date.now() - pendingLaunch.at > 60_000) {
      setPendingLaunch(null);
    }
  }, [pendingLaunch, sessions.data, live.data]);

  // Fire chime only on real status transitions:
  //   "working" → "done"            (assistant ended turn cleanly)
  //   anything  → "awaiting_input"  (AskUserQuestion is pending)
  // Skip the first observation for each session (so opening the app doesn't chime).
  const prevStatusRef = useRef<Map<string, "working" | "awaiting_input" | "done">>(new Map());
  useEffect(() => {
    if (!selectedSession) return;
    const id = selectedSession.sessionId;
    const prev = prevStatusRef.current.get(id);
    const cur = selectedSession.status;
    if (prev && prev !== cur && chimeEnabled) {
      if (cur === "done" && prev === "working") chime();
      else if (cur === "awaiting_input" && prev !== "awaiting_input") chime();
    }
    prevStatusRef.current.set(id, cur);
  }, [selectedSession?.sessionId, selectedSession?.status, chime, chimeEnabled]);

  const onChange = useCallback(
    (e: ChangeEvent) => {
      if (e.kind === "live" || e.kind === "session") {
        qc.invalidateQueries({ queryKey: ["all-sessions"] });
      }
      if (e.kind === "session" && e.sessionId === sessionId && selectedSession) {
        qc.invalidateQueries({ queryKey: ["transcript", selectedSession.workspaceId, sessionId] });
      }
    },
    [qc, sessionId, selectedSession],
  );
  useChangeFeed(onChange);

  useEffect(() => {
    // Don't auto-grab the newest session while we're waiting on a launch — the
    // launch effect will pick the correct (just-started) one.
    if (pendingLaunch) return;
    if (!sessionId && visibleSessions.length > 0) {
      setSessionId(visibleSessions[0].sessionId);
    }
  }, [visibleSessions, sessionId, pendingLaunch]);

  function startNewSessionAt(cwd: string) {
    const workspaceId = encodeWorkspaceId(cwd);
    rememberPath(cwd);
    // Several sessions in one directory is normal, so there is no "are you sure" here.
    // Use a per-launch nonce so multiple new sessions in the same workspace
    // each get their own entry. We rename to the real sessionId-keyed entry
    // once /api/live reveals it.
    const launchKey = makeKey(workspaceId, `launch-${Date.now()}`, "new");
    const url = api.terminalWsUrl(workspaceId, { mode: "new", cwd, key: launchKey });
    ensureTerminal(launchKey, url);
    setShowNewSession(false);
    setSessionId(null);
    setPendingLaunch({ workspaceId, at: Date.now(), launchKey });
  }

  return (
    <div id="app-root" tabIndex={-1} className="flex flex-col h-full gap-2 p-2 text-fg outline-none">
      <header className="tile relative flex items-center shrink-0 pl-3 pr-2.5 py-2 gap-3">
        <div className="flex items-center gap-2.5 shrink-0">
          <span
            className="grid place-items-center w-6 h-6 rounded-lg text-[13px] shadow-accent"
            style={{ backgroundImage: "var(--grad-accent)" }}
          >
            <span className="animate-float">✦</span>
          </span>
          <span className="text-sm font-semibold tracking-tight text-fg">ClaudeDash</span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0 text-xs text-fg-muted tabular-nums">
          <Stat dot="bg-accent" value={visibleSessions.length} title="sessions" />
          <Stat dot="bg-amber-400" value={workingIds.size} title="working now" />
          <Stat dot="bg-sky-400" value={terminalSessionIds.size} title="live terminals" />
        </div>

        <div className="w-px self-stretch my-0.5 bg-hairline shrink-0" />

        <div className="flex-1 min-w-0">
          <ActiveWorkBar
            sessions={visibleSessions}
            selectedId={sessionId}
            onSelect={setSessionId}
          />
        </div>

        <div className="flex items-center gap-1.5 text-xs shrink-0">
          {/* Where the keystrokes are going — and a click does the same as Alt+I. */}
          <button
            onClick={() => (isTerminalFocused() ? releaseTerminalFocus() : focusTerminal())}
            title={focusScope === "app"
              ? "Keys go to the dashboard. Click (or Alt+I) to type in the terminal."
              : `Keys go to the ${focusScope} terminal. Click (or Alt+I) to hand them back.`}
            className={clsx("press flex items-center gap-1.5 px-2.5 py-1",
              focusScope === "app" ? "pill" : "pill pill-on")}
          >
            <span className={clsx(
              "w-1.5 h-1.5 rounded-full",
              focusScope === "app" ? "bg-fg-dim" : "bg-emerald-400",
            )} />
            {focusScope === "app" ? "app" : focusScope === "scratch" ? "scratch" : "terminal"}
            <Kbd>Alt+I</Kbd>
          </button>
          <button
            onClick={() => setScratchOpen((v) => !v)}
            title="Scratch pad — one always-on claude session for quick questions. Never enters the session list."
            className={clsx("press px-2.5 py-1 flex items-center gap-1.5", scratchOpen ? "pill pill-on" : "pill")}
          >
            Scratch <Kbd>S</Kbd>
          </button>
          <button
            onClick={() => setChimeEnabled((v) => !v)}
            title={chimeEnabled
              ? "Chime on: sounds when the selected session finishes or asks something"
              : "Chime muted"}
            className={clsx("press px-2 py-1 w-8 grid place-items-center", chimeEnabled ? "pill pill-on" : "pill")}
          >
            {chimeEnabled ? "🔔" : "🔕"}
          </button>
          <button
            onClick={() => setShowHelp(true)}
            title="Keyboard shortcuts (?)"
            className="pill press w-8 py-1 grid place-items-center"
          >
            <Kbd>?</Kbd>
          </button>
          <button
            onClick={cycleTheme}
            title="Theme: auto follows the OS setting. Click to cycle auto → light → dark."
            className="pill press px-2.5 py-1"
          >
            {themeMode === "system" ? "Auto" : themeMode === "light" ? "Light" : "Dark"}
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 flex gap-2">
        <SessionList
          sessions={visibleSessions}
          selectedId={sessionId}
          onSelect={setSessionId}
          workingIds={workingIds}
          terminalKeys={terminalSessionIds}
          onNewSession={() => setShowNewSession(true)}
        />
        {selectedSession ? (
          <SessionDetail
            key={selectedSession.sessionId}
            session={selectedSession}
            terminalEnabled={!!health.data?.terminalEnabled}
          />
        ) : pendingLaunch ? (
          <div className="tile flex-1 flex flex-col items-center justify-center text-sm gap-2 px-8 text-center">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse mb-1" />
            <span className="text-fg">Starting a session in {pendingLaunch.workspaceId}</span>
            <span className="text-xs text-fg-dim max-w-sm">
              Waiting for Claude Code to write its first entry. The terminal is already live in
              the background.
            </span>
          </div>
        ) : (
          <div className="tile flex-1 flex items-center justify-center text-fg-dim text-sm">
            Select a session
          </div>
        )}
      </div>
      {showHelp && <ShortcutsOverlay onClose={() => setShowHelp(false)} />}
      <ScratchTerminal
        scratch={scratch.data ?? null}
        open={scratchOpen}
        onClose={() => setScratchOpen(false)}
      />
      {showNewSession && (
        <NewSessionModal
          onCancel={() => setShowNewSession(false)}
          onStart={startNewSessionAt}
        />
      )}
    </div>
  );
}
