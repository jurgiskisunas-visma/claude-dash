import { useSyncExternalStore } from "react";
import clsx from "clsx";
import { isHinting, subscribeHints } from "../lib/shortcuts";

interface Props {
  /** What to print, e.g. "J" or "/". */
  children: string;
  className?: string;
}

/**
 * A key badge. Present but recessive: readable if you look for it, invisible if you don't.
 * Holding Alt brightens every badge at once, which is how the map gets discovered.
 */
export function Kbd({ children, className }: Props) {
  const hinting = useSyncExternalStore(subscribeHints, isHinting);
  return (
    <kbd
      aria-hidden
      className={clsx(
        "kbd",
        hinting && "kbd-hint",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
