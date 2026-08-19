import { useMemo, useSyncExternalStore } from "react";
import clsx from "clsx";
import type { SessionSummary } from "../types/api";
import { useSessionName } from "../hooks/useSessionName";
import { getSnapshot, subscribe, untrackSession } from "../lib/activeWork";

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * The row of small cubes just under/inside the header: one per session the user
 * is actively working on. Click a cube to jump to it, click its × to close it
 * out. Order is the order sessions were picked up.
 */
export function ActiveWorkBar({ sessions, selectedId, onSelect }: Props) {
  const tracked = useSyncExternalStore(subscribe, getSnapshot);

  const byId = useMemo(() => {
    const m = new Map<string, SessionSummary>();
    for (const s of sessions) m.set(s.sessionId, s);
    return m;
  }, [sessions]);

  const rows = useMemo(
    () => tracked.map((id) => ({ id, session: byId.get(id) })),
    [tracked, byId],
  );

  if (rows.length === 0) {
    return (
      <span className="text-2xs text-fg-dim">
        No active work — open a session to start tracking it
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
      {rows.map(({ id, session }) => (
        <WorkCube
          key={id}
          sessionId={id}
          session={session}
          selected={id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

const STATUS_DOT: Record<SessionSummary["status"], string> = {
  working: "bg-amber-400 animate-pulse",
  awaiting_input: "bg-rose-400 animate-pulse",
  done: "bg-emerald-400",
};

function WorkCube({
  sessionId,
  session,
  selected,
  onSelect,
}: {
  sessionId: string;
  session: SessionSummary | undefined;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const [name] = useSessionName(sessionId);
  const label = name ?? session?.dirLabel ?? sessionId.slice(0, 6);
  const status = session?.status ?? "done";

  return (
    <div
      className={clsx(
        "group cube pop-in shrink-0 flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg text-xs",
        selected
          ? "bg-accent-soft text-accent ring-1 ring-inset ring-accent-ring"
          : "bg-surface-3 text-fg-muted hover:text-fg",
      )}
      title={session ? `${label} — ${session.cwd}${session.gitBranch ? ` (${session.gitBranch})` : ""}` : `${label} (session not in list)`}
    >
      <span className={clsx("w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[status])} />
      <button
        onClick={() => onSelect(sessionId)}
        className="max-w-[130px] truncate font-medium"
      >
        {label}
      </button>
      <button
        onClick={() => untrackSession(sessionId)}
        title="Done with this one — close it"
        className="px-1 rounded row-action hover:!text-rose-500 dark:hover:!text-rose-400"
      >
        ×
      </button>
    </div>
  );
}
