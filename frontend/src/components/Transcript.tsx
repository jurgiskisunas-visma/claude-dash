import { useMemo, useState } from "react";
import clsx from "clsx";
import type { TranscriptEntry, ContentBlock } from "../types/api";
import { Markdown } from "./Markdown";
import { Segmented } from "./Segmented";

interface Props {
  entries: TranscriptEntry[];
  isLoading: boolean;
}

/**
 * "Messages" hides thinking and tool traffic so a long session reads like a conversation;
 * "Everything" shows every block. Persisted, because it is a reading preference rather than
 * per-session state.
 */
type Mode = "messages" | "everything";
const MODE_KEY = "claudedash:transcript-mode";
const ORDER_KEY = "claudedash:transcript-order";

/** "newest" puts the end of the conversation at the top — where you usually want to start. */
type Order = "newest" | "oldest";

function loadOrder(): Order {
  return localStorage.getItem(ORDER_KEY) === "oldest" ? "oldest" : "newest";
}

function loadMode(): Mode {
  return localStorage.getItem(MODE_KEY) === "everything" ? "everything" : "messages";
}

const isProse = (b: ContentBlock) => b.type === "text" && !!b.text?.trim();

export function Transcript({ entries, isLoading }: Props) {
  const [mode, setMode] = useState<Mode>(loadMode);
  const choose = (m: Mode) => { setMode(m); localStorage.setItem(MODE_KEY, m); };
  const [order, setOrder] = useState<Order>(loadOrder);
  const flipOrder = () => {
    const next: Order = order === "newest" ? "oldest" : "newest";
    setOrder(next);
    localStorage.setItem(ORDER_KEY, next);
  };

  const visible = useMemo(
    () => entries.filter((e) => e.type === "user" || e.type === "assistant" || e.type === "system"),
    [entries],
  );

  // In Messages mode, turns that are pure tool traffic disappear entirely; the count is
  // still reported so nothing looks silently dropped.
  const shown = useMemo(() => {
    const kept = mode === "everything" ? visible : visible.filter((e) => e.blocks.some(isProse));
    return order === "newest" ? [...kept].reverse() : kept;
  }, [visible, mode, order]);
  const hiddenTurns = visible.length - shown.length;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-7 pt-3 pb-1">
        <Segmented
          value={mode}
          onChange={choose}
          segments={[
            { value: "messages" as Mode, label: "Messages", title: "Prose only — thinking and tool calls are folded away" },
            { value: "everything" as Mode, label: "Everything", title: "Every block, including thinking and tool calls" },
          ]}
        />
        <button
          onClick={flipOrder}
          title={order === "newest" ? "Newest first — click for chronological" : "Oldest first — click for newest first"}
          className="pill press px-2.5 py-1 text-2xs shrink-0"
        >
          {order === "newest" ? "Newest first" : "Oldest first"}
        </button>
        {mode === "messages" && hiddenTurns > 0 && (
          <span className="text-2xs text-fg-dim">
            {hiddenTurns} tool-only {hiddenTurns === 1 ? "turn" : "turns"} hidden
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-7 pb-5 pt-2">
        {isLoading && <div className="text-fg-dim text-sm">Loading…</div>}
        {!isLoading && shown.length === 0 && (
          <div className="text-fg-dim text-sm">
            {visible.length === 0
              ? "No conversation entries."
              : "No prose in this session — switch to Everything."}
          </div>
        )}
        <div className="space-y-5">
          {shown.map((e) => <Entry key={e.uuid} entry={e} mode={mode} />)}
        </div>
      </div>
    </div>
  );
}

/**
 * One turn. Deliberately not a bordered box — the role marker plus vertical rhythm carries
 * the structure, so a long transcript reads as a conversation rather than a stack of
 * rectangles.
 */
function Entry({ entry, mode }: { entry: TranscriptEntry; mode: Mode }) {
  const [revealed, setRevealed] = useState(false);
  const isUser = entry.type === "user" || entry.role === "user";
  const isAssistant = entry.type === "assistant" || entry.role === "assistant";
  const label = isUser ? "You" : isAssistant ? "Claude" : entry.subtype ?? "system";
  const dot = isUser ? "bg-sky-400" : isAssistant ? "bg-accent" : "bg-fg-dim";
  const ts = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  const prose = entry.blocks.filter(isProse);
  const rest = entry.blocks.filter((b) => !isProse(b));
  const folded = mode === "messages" && !revealed;
  const blocks = folded ? prose : entry.blocks;

  return (
    <div className="group/entry">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={clsx("w-1.5 h-1.5 rounded-full shrink-0", dot)} />
        <span className="text-xs font-medium text-fg">{label}</span>
        {entry.model && <span className="text-2xs text-fg-dim font-mono">{entry.model}</span>}
        <span className="ml-auto text-2xs text-fg-dim tabular-nums opacity-0 group-hover/entry:opacity-100 transition-opacity">
          {ts}
        </span>
      </div>
      <div className="pl-3.5 space-y-1.5 border-l border-hairline">
        {blocks.map((b, i) => <BlockView key={i} block={b} />)}
        {folded && rest.length > 0 && (
          <button
            onClick={() => setRevealed(true)}
            className="press text-2xs text-fg-dim hover:text-accent transition-colors"
            title="Show the thinking and tool calls from this turn"
          >
            + {rest.length} {rest.length === 1 ? "step" : "steps"}
          </button>
        )}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return <Markdown>{block.text ?? ""}</Markdown>;
  }
  if (block.type === "thinking") {
    return (
      <Collapsible label="Thinking" tone="violet" preview={block.text ?? ""}>
        <pre className="text-xs text-fg-muted whitespace-pre-wrap font-mono">{block.text}</pre>
      </Collapsible>
    );
  }
  if (block.type === "tool_use") {
    const input = tryParse(block.inputJson);
    return (
      <Collapsible
        label={block.toolName ?? "tool"}
        tone="amber"
        preview={summarizeInput(block.toolName ?? "", input)}
      >
        <pre className="text-xs text-fg-muted whitespace-pre-wrap font-mono">
          {block.inputJson ? prettyJson(block.inputJson) : ""}
        </pre>
      </Collapsible>
    );
  }
  if (block.type === "tool_result") {
    const preview = (block.outputJson ?? "").slice(0, 200).replace(/\s+/g, " ");
    return (
      <Collapsible
        label={block.isError ? "Error" : "Result"}
        tone={block.isError ? "rose" : "green"}
        preview={preview}
      >
        <pre className="text-xs text-fg-muted whitespace-pre-wrap font-mono">
          {block.outputJson ?? ""}
        </pre>
      </Collapsible>
    );
  }
  if (block.type === "system") {
    return <pre className="text-xs text-fg-dim whitespace-pre-wrap font-mono">{block.text}</pre>;
  }
  return <div className="text-xs text-fg-dim italic">[{block.type}]</div>;
}

const TONE_TEXT = {
  violet: "text-accent",
  amber: "text-amber-600 dark:text-amber-300",
  green: "text-emerald-600 dark:text-emerald-300",
  rose: "text-rose-600 dark:text-rose-300",
} as const;

/**
 * Collapsed tool/thinking line: label + one-line preview on the same baseline, so a run of
 * them scans like a log. Expanding drops the payload underneath on a tint.
 */
function Collapsible({
  label, tone, preview, children,
}: {
  label: string;
  tone: keyof typeof TONE_TEXT;
  preview: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={clsx("rounded-lg -mx-1.5", open && "card")}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-baseline gap-2 px-1.5 py-1 text-left rounded-lg hover:bg-surface-3 transition-colors"
      >
        <span className={clsx("text-2xs font-medium shrink-0", TONE_TEXT[tone])}>{label}</span>
        <span className={clsx("text-xs font-mono text-fg-dim truncate", open && "opacity-0")}>
          {preview}
        </span>
        <span className="ml-auto text-2xs text-fg-dim shrink-0">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="px-2.5 pb-2 max-h-96 overflow-auto">{children}</div>}
    </div>
  );
}

function tryParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}
function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
function summarizeInput(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  if (tool === "Bash") return pick("command").slice(0, 160);
  if (tool === "Read" || tool === "Write" || tool === "Edit") return pick("file_path");
  if (tool === "Glob" || tool === "Grep") return pick("pattern");
  if (tool.startsWith("mcp__")) return pick("query") || pick("path") || "";
  const firstStr = Object.values(o).find((v) => typeof v === "string") as string | undefined;
  return (firstStr ?? "").slice(0, 160);
}
