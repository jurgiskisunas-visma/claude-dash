import { useState } from "react";
import clsx from "clsx";

type Shell = "bash" | "pwsh" | "cmd";

interface Props {
  cwd: string;
  sessionId?: string;     // when omitted, launches a fresh `claude`
  mode: "resume" | "new";
}

const SHELLS: { id: Shell; label: string; emoji: string }[] = [
  { id: "bash", label: "bash", emoji: "🐚" },
  { id: "pwsh", label: "pwsh", emoji: "🔷" },
  { id: "cmd",  label: "cmd",  emoji: "🪟" },
];

export function CommandSnippet({ cwd, sessionId, mode }: Props) {
  const [shell, setShell] = useState<Shell>("bash");
  const [copied, setCopied] = useState(false);

  const cmd = buildCommand(shell, cwd, mode === "resume" ? sessionId : undefined);

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  }

  return (
    <div className="px-4 py-2 border-b border-hairline bg-gradient-to-r from-sky-100/40 dark:from-sky-950/20 via-transparent to-transparent">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-fg-muted">Copy &amp; paste into any terminal</span>
        <div className="flex gap-0.5 ml-1">
          {SHELLS.map((s) => (
            <button
              key={s.id}
              onClick={() => setShell(s.id)}
              className={clsx(
                "px-2 py-0.5 text-[10px] rounded-full border transition-colors",
                shell === s.id
                  ? "bg-sky-500/15 border-sky-400/40 text-sky-700 dark:text-sky-200"
                  : "border-transparent text-fg-muted hover:text-fg dark:hover:text-fg hover:bg-surface-3",
              )}
              title={s.label}
            >
              <span className="mr-1">{s.emoji}</span>{s.label}
            </button>
          ))}
        </div>
        <button
          onClick={copy}
          className={clsx(
            "ml-auto px-2 py-0.5 text-[10px] rounded-full border transition-colors",
            copied
              ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-700 dark:text-emerald-200"
              : "border-hairline-strong text-fg-muted hover:bg-surface-3",
          )}
        >
          {copied ? "✓ Copied" : "📋 Copy"}
        </button>
      </div>
      <code
        onClick={copy}
        className="block text-xs font-mono text-fg bg-surface-2 border border-hairline rounded-md px-3 py-2 overflow-x-auto whitespace-nowrap cursor-pointer hover:bg-surface-3"
        title="Click to copy"
      >
        <span className="text-fg-muted">$ </span>{cmd}
      </code>
    </div>
  );
}

function buildCommand(shell: Shell, cwd: string, sessionId?: string): string {
  const resumePart = sessionId ? ` --resume ${sessionId}` : "";
  // For bash/POSIX, convert Windows path to forward slashes (works in Git Bash / WSL).
  const cwdPosix = cwd.replace(/\\/g, "/");
  switch (shell) {
    case "bash": return `cd "${cwdPosix}" && claude${resumePart}`;
    case "pwsh": return `Set-Location "${cwd}"; claude${resumePart}`;
    case "cmd":  return `cd /d "${cwd}" && claude${resumePart}`;
  }
}
