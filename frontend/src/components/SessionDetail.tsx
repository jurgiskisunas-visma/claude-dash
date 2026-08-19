import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "../api/client";
import {
  destroyTerminal,
  listKeys,
  makeKey,
  subscribeToList,
  ensureTerminal,
  isRestoring,
  subscribeRestoring,
} from "../terminalStore";
import type { SessionSummary } from "../types/api";
import { Transcript } from "./Transcript";
import { TerminalPane } from "./TerminalPane";
import { CommandSnippet } from "./CommandSnippet";
import { ChangesView } from "./ChangesView";
import { JiraDetailView } from "./JiraDetailView";
import { useSessionName } from "../hooks/useSessionName";
import { usePinned } from "../hooks/usePinned";
import { Kbd } from "./Kbd";
import { Segmented } from "./Segmented";
import { subscribeCommands, type Command } from "../lib/commands";

type Tab = "transcript" | "terminal" | "changes" | "pr" | "jira";

interface PrMeta {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED" | string;
  url: string;
  isDraft: boolean;
  author?: string;
  baseRefName?: string;
  headRefName?: string;
  body?: string | null;
  updatedAt?: string;
  mergeable?: string | null;
  checksStatus?: string | null;
}
interface Props {
  session: SessionSummary;
  terminalEnabled: boolean;
}

export function SessionDetail({ session, terminalEnabled }: Props) {
  const [tab, setTab] = useState<Tab>("transcript");

  // Subscribe to the global terminal-list snapshot so the tab badge reflects WS state.
  const termKeys = useSyncExternalStore(subscribeToList, listKeys);
  // True until the backend's running-terminal list has been fetched once.
  const restoring = useSyncExternalStore(subscribeRestoring, isRestoring);
  const resumeKey = makeKey(session.workspaceId, session.sessionId, "resume");
  // Terminals started from "+ New session" live under a "new" key (created by
  // promoting a launch key through renameTerminal); fall back to the legacy
  // ws||new key. We still show those, but launching from here always resumes.
  const newKeyById = makeKey(session.workspaceId, session.sessionId, "new");
  const newKeyLegacy = makeKey(session.workspaceId, undefined, "new");
  const newKey = termKeys.includes(newKeyById) ? newKeyById : newKeyLegacy;

  const hasResume = termKeys.includes(resumeKey);
  const hasNew = termKeys.includes(newKey);
  // Prefer an existing terminal (resume-keyed, else new-keyed); otherwise the
  // resume key is what a fresh launch will create.
  const activeKey = hasResume ? resumeKey : hasNew ? newKey : resumeKey;
  const hasActive = hasResume || hasNew;

  // Whether the user picked the current tab themselves. Two consequences: we stop
  // auto-switching under them, and the terminal only grabs the keyboard when they actually
  // asked for it — otherwise j/k navigation onto a session with a live terminal would steal
  // focus and silently kill the bare-key shortcuts.
  const [tabChosenByUser, setTabChosenByUser] = useState(false);
  const chooseTab = (t: Tab) => { setTabChosenByUser(true); setTab(t); };

  // When the user switches to a different session, default tab back to transcript
  // unless that session already has a running terminal.
  useEffect(() => {
    setTabChosenByUser(false);
    setTab(hasResume || hasNew ? "terminal" : "transcript");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  // Terminals are restored from the backend a moment after page load, so a session that
  // looked terminal-less at mount can gain one. Jump to it rather than leaving the user
  // on the transcript wondering why they have to "launch" a terminal that's still running.
  useEffect(() => {
    if (hasActive && !tabChosenByUser) setTab("terminal");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive]);

  const transcript = useQuery({
    queryKey: ["transcript", session.workspaceId, session.sessionId],
    queryFn: () => api.transcript(session.workspaceId, session.sessionId),
    enabled: tab === "transcript",
  });

  const pr = useQuery({
    queryKey: ["pr", session.workspaceId, session.sessionId],
    queryFn: () => api.sessionPr(session.workspaceId, session.sessionId) as Promise<PrMeta | null>,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const wsUrl = useMemo(
    () => api.terminalWsUrl(session.workspaceId, {
      sessionId: session.sessionId,
      mode: "resume",
      key: activeKey,
    }),
    [session.workspaceId, session.sessionId, activeKey],
  );

  function launch() {
    ensureTerminal(activeKey, wsUrl);
    setTab("terminal");
  }
  function kill() {
    destroyTerminal(activeKey);
    setTab("transcript");
  }

  // Tab and terminal commands: the pane owns which tabs exist, so it decides whether a
  // given shortcut is a no-op (no Jira key, no PR).
  useEffect(() => subscribeCommands((cmd: Command) => {
    const go = (t: Tab) => { setTabChosenByUser(true); setTab(t); };
    switch (cmd) {
      case "tab.transcript": go("transcript"); break;
      case "tab.changes": go("changes"); break;
      case "tab.terminal": go("terminal"); break;
      case "tab.jira": if (session.jiraKeys.length > 0) go("jira"); break;
      case "tab.pr": if (pr.data) go("pr"); break;
      case "terminal.toggle":
        go("terminal");
        if (!hasActive && terminalEnabled) launch();
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [session.jiraKeys.length, hasActive, terminalEnabled, wsUrl, activeKey]);

  return (
    <div className="tile pane-in flex-1 flex flex-col min-w-0 overflow-hidden">
      <Header session={session} />
      <TabBar
        tab={tab}
        setTab={chooseTab}
        hasActive={hasActive}
        terminalEnabled={terminalEnabled}
        onLaunch={launch}
        onKill={kill}
        prMeta={pr.data ?? null}
        jiraKeys={session.jiraKeys}
      />
      {/* Keyed so switching tabs replays the lift-in; the terminal is excluded because
          re-mounting its xterm would throw away the rendered buffer. */}
      <div
        key={tab === "terminal" ? "terminal" : tab}
        className={clsx("flex-1 min-h-0 flex flex-col", tab !== "terminal" && "pane-in")}
      >
        {tab === "transcript" && (
          <Transcript entries={transcript.data ?? []} isLoading={transcript.isLoading} />
        )}
        {tab === "changes" && <ChangesView session={session} />}
        {tab === "pr" && pr.data && <PrView pr={pr.data} />}
        {tab === "jira" && <JiraDetailView jiraKeys={session.jiraKeys} />}
        {tab === "terminal" && (
          hasActive
            ? <TerminalPane termKey={activeKey} wsUrl={wsUrl} autoFocus={tabChosenByUser} />
            : restoring
            ? <TerminalReconnecting />
            : <TerminalLauncher
                onLaunch={launch}
                terminalEnabled={terminalEnabled}
                cwd={session.cwd}
                sessionId={session.sessionId}
                liveBlocksResume={session.isLive}
              />
        )}
      </div>
    </div>
  );
}

function Header({ session }: { session: SessionSummary }) {
  const [name, setName] = useSessionName(session.sessionId);
  const [pinned, togglePin] = usePinned(session.sessionId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");

  function save() {
    setName(draft.trim() ? draft : null);
    setEditing(false);
  }

  return (
    <div className="px-5 pt-3 pb-2.5">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={togglePin}
          title={pinned ? "Unpin session" : "Pin session"}
          className={clsx(
            "press text-sm leading-none",
            pinned
              ? "text-amber-500 dark:text-amber-300 hover:text-amber-600 dark:hover:text-amber-200"
              : "text-fg-dim hover:text-amber-500 dark:hover:text-amber-300",
          )}
        >{pinned ? "★" : "☆"}</button>

        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") { setDraft(name ?? ""); setEditing(false); }
            }}
            placeholder="Give this session a name…"
            className="field flex-1 max-w-md px-2 py-1 text-base"
          />
        ) : name ? (
          <button
            onClick={() => { setDraft(name); setEditing(true); }}
            className="text-lg font-semibold tracking-tight text-fg hover:text-accent transition-colors truncate"
            title="Click to rename"
          >
            {name}
          </button>
        ) : (
          <button
            onClick={() => { setDraft(""); setEditing(true); }}
            className="text-base text-fg-dim hover:text-accent transition-colors"
            title="Give this session a memorable name"
          >
            Name this session
          </button>
        )}

        {/* Session identity, right-aligned so the title line stays the title line. */}
        <div className="ml-auto flex items-center gap-3 shrink-0 pl-3">
          {session.jiraKeys.map((k) => (
            <code key={k} className="text-xs text-rose-500 dark:text-rose-300">{k}</code>
          ))}
          {session.gitBranch && (
            <code className={clsx(
              "text-xs",
              session.gitBranch === "HEAD" ? "text-fg-dim" : "text-accent",
            )}>⎇ {session.gitBranch}</code>
          )}
          {session.isLive && (
            <span
              title={`Live claude process, pid ${session.pid}`}
              className="flex items-center gap-1.5 text-2xs font-medium text-emerald-600 dark:text-emerald-300"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Live · {session.pid}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-baseline gap-3 mt-1">
        <p className="text-xs text-fg-dim font-mono truncate">{session.cwd}</p>
        <code className="ml-auto text-2xs text-fg-dim shrink-0" title="Session id">
          {session.sessionId}
        </code>
      </div>
    </div>
  );
}

function TabBar({
  tab, setTab, hasActive, terminalEnabled, onLaunch, onKill, prMeta, jiraKeys,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  prMeta: PrMeta | null;
  jiraKeys: string[];
  hasActive: boolean;
  terminalEnabled: boolean;
  onLaunch: () => void;
  onKill: () => void;
}) {
  // py tuned so this seam lands on the same pixel row as the session list's header seam.
  return (
    <div className="flex items-center gap-2 px-5 py-2.5 seam">
      <Segmented
        value={tab}
        onChange={setTab}
        segments={[
          {
            value: "transcript" as Tab,
            label: <span className="flex items-center gap-1.5">Transcript <Kbd>1</Kbd></span>,
          },
          {
            value: "changes" as Tab,
            label: <span className="flex items-center gap-1.5">Changes <Kbd>2</Kbd></span>,
          },
          {
            value: "terminal" as Tab,
            label: (
              <span className="flex items-center gap-1.5">
                Terminal
                {hasActive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                <Kbd>3</Kbd>
              </span>
            ),
          },
          ...(jiraKeys.length > 0 ? [{
            value: "jira" as Tab,
            label: (
              <span className="flex items-center gap-1.5">
                {jiraKeys.length > 1 ? `Jira ×${jiraKeys.length}` : `Jira ${jiraKeys[0]}`}
                <Kbd>4</Kbd>
              </span>
            ),
          }] : []),
          ...(prMeta ? [{
            value: "pr" as Tab,
            label: (
              <span className="flex items-center gap-1.5">
                PR #{prMeta.number}
                <Kbd>5</Kbd>
                <span className={clsx(
                  "w-1.5 h-1.5 rounded-full",
                  prMeta.state === "OPEN" ? "bg-emerald-400"
                    : prMeta.state === "MERGED" ? "bg-accent" : "bg-fg-dim",
                )} />
              </span>
            ),
          }] : []),
        ]}
      />

      <div className="ml-auto flex items-center gap-1 text-xs">
        {hasActive ? (
          <button
            onClick={onKill}
            title="Kill the PTY on the backend"
            className="pill press px-2.5 py-1 hover:!text-rose-500 dark:hover:!text-rose-300"
          >
            Close terminal
          </button>
        ) : (
          <button
            disabled={!terminalEnabled}
            onClick={onLaunch}
            title="Resume this session in a terminal"
            className="btn-accent press flex items-center gap-1.5 px-3 py-1 disabled:opacity-40"
          >
            Resume <Kbd>T</Kbd>
          </button>
        )}
      </div>
    </div>
  );
}

function PrView({ pr }: { pr: PrMeta }) {
  const stateColor = pr.state === "OPEN" ? "emerald" : pr.state === "MERGED" ? "violet" : "zinc";
  const stateClass = {
    emerald: "bg-emerald-400/12 text-emerald-700 dark:text-emerald-300 border-emerald-400/30",
    violet: "bg-accent-soft text-accent border-accent-ring",
    zinc: "bg-surface-3 text-fg-muted border-hairline-strong",
  }[stateColor];
  return (
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-fg">
          <span className="text-fg-dim mr-2">#{pr.number}</span>
          {pr.title}
        </h1>
        <span className={clsx("px-2 py-0.5 rounded-full text-2xs uppercase tracking-[0.11em] border", stateClass)}>
          {pr.isDraft ? "DRAFT" : pr.state}
        </span>
        {pr.checksStatus && (
          <span className="px-2 py-0.5 rounded-full text-2xs uppercase tracking-[0.11em] border border-hairline text-fg-muted">
            checks: {pr.checksStatus.toLowerCase()}
          </span>
        )}
      </div>
      <div className="text-xs text-fg-muted flex flex-wrap gap-x-4 gap-y-1">
        {pr.author && <span><span className="text-fg-dim">by</span> {pr.author}</span>}
        {pr.headRefName && pr.baseRefName && (
          <span>
            <code className="text-accent">⎇ {pr.headRefName}</code>
            <span className="text-fg-dim"> → </span>
            <code className="text-sky-600 dark:text-sky-300">⎇ {pr.baseRefName}</code>
          </span>
        )}
        {pr.mergeable && (
          <span><span className="text-fg-dim">mergeable:</span> {pr.mergeable.toLowerCase()}</span>
        )}
        {pr.updatedAt && (
          <span><span className="text-fg-dim">updated:</span> {new Date(pr.updatedAt).toLocaleString()}</span>
        )}
      </div>
      <div className="flex gap-2">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="btn-accent press px-3 py-1.5 text-xs"
        >Open on GitHub ↗</a>
        <code className="text-[11px] text-fg-dim self-center truncate" title={pr.url}>{pr.url}</code>
      </div>
      {pr.body && (
        <article className="card p-4">
          <div className="label mb-2">Description</div>
          <pre className="text-sm text-fg whitespace-pre-wrap font-sans leading-relaxed">{pr.body}</pre>
        </article>
      )}
      <div className="card p-3 text-xs text-fg-dim">
        GitHub blocks embedding via iframe, so PR diffs / comments / reviews aren't shown inline.
        Use the <strong className="text-fg-muted">Changes</strong> tab for the diff, or open the PR
        on GitHub for the full experience.
      </div>
    </div>
  );
}

function TerminalReconnecting() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2.5 text-sm text-fg-muted">
      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
      <span>Reconnecting to running terminals…</span>
    </div>
  );
}

function TerminalLauncher({
  onLaunch, terminalEnabled, cwd, sessionId, liveBlocksResume,
}: {
  onLaunch: () => void;
  terminalEnabled: boolean;
  cwd: string;
  sessionId: string;
  liveBlocksResume: boolean;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      <div className="text-center space-y-4 max-w-md w-full">
        <div className="text-fg-muted text-sm">
          Spawn <code className="text-accent">claude --resume</code> in this session's working directory.
        </div>
        <code className="block text-xs text-fg-dim font-mono">{cwd}</code>
        {liveBlocksResume && (
          <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2">
            ⚠ This session is currently <strong>live</strong> in another Claude process. <code>--resume</code> will be refused until that process exits.
          </div>
        )}
        <button
          disabled={!terminalEnabled}
          onClick={onLaunch}
          className="btn-accent px-4 py-2 text-sm disabled:opacity-40"
        >
          Resume in terminal
        </button>
        {!terminalEnabled && (
          <div className="text-xs text-fg-dim">Terminal not available on this backend.</div>
        )}

        <div className="flex items-center gap-3 pt-2 text-[10px] uppercase tracking-[0.14em] text-fg-dim">
          <div className="flex-1 h-px bg-hairline" />
          <span>or</span>
          <div className="flex-1 h-px bg-hairline" />
        </div>
      </div>

      <div className="w-full max-w-3xl mt-3">
        <CommandSnippet cwd={cwd} sessionId={sessionId} mode="resume" />
      </div>
    </div>
  );
}
