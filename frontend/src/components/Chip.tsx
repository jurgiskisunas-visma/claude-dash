import clsx from "clsx";
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  tone?: "neutral" | "blue" | "green" | "amber" | "rose" | "violet";
  title?: string;
}

// Quiet by default: a tint and coloured text, no outline. Chips are metadata, so they
// should never out-shout the row title they sit under.
const tones = {
  neutral: "bg-surface-3 text-fg-muted",
  blue: "bg-sky-400/10 text-sky-700 dark:text-sky-300",
  green: "bg-emerald-400/10 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-400/10 text-amber-700 dark:text-amber-300",
  rose: "bg-rose-400/10 text-rose-600 dark:text-rose-300",
  violet: "bg-accent-soft text-accent",
};

export function Chip({ children, tone = "neutral", title }: Props) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md text-2xs font-medium whitespace-nowrap",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}
