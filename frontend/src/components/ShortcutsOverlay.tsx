import { SHORTCUTS, type Shortcut } from "../lib/shortcuts";

const GROUPS: Shortcut["group"][] = ["Navigate", "View", "Session", "App"];

/**
 * The full map, on `?`. Every row also states the Alt variant once at the bottom rather
 * than repeating "Alt+" fifteen times.
 */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      className="backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/55 backdrop-blur-sm p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="dialog-in w-full max-w-2xl rounded-tile border border-hairline bg-surface-solid shadow-pop"
      >
        <div className="px-5 py-3 seam flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-fg">Keyboard shortcuts</h2>
          <button onClick={onClose} className="press text-fg-dim hover:text-fg px-2" title="Esc">✕</button>
        </div>

        <div className="px-5 py-4 grid grid-cols-2 gap-x-8 gap-y-5">
          {GROUPS.map((g) => (
            <section key={g}>
              <h3 className="label mb-2">{g}</h3>
              <ul className="space-y-1.5">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <li key={s.command} className="flex items-baseline gap-3 text-sm">
                    <span className="flex gap-1 shrink-0">
                      <kbd className="kbd kbd-hint">{s.label}</kbd>
                      {s.aliases?.includes("arrowdown") && <kbd className="kbd kbd-hint">↓</kbd>}
                      {s.aliases?.includes("arrowup") && <kbd className="kbd kbd-hint">↑</kbd>}
                    </span>
                    <span className="text-fg-muted">{s.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="px-5 py-3 seam-t text-xs text-fg-dim space-y-1">
          <p>
            Hold <kbd className="kbd kbd-hint">Alt</kbd> to light up the badges in the UI. Every
            shortcut also works as <kbd className="kbd kbd-hint">Alt</kbd> + the same key — use
            that while the terminal has focus, since bare keys go to the shell.
          </p>
          <p>Nothing is bound to Ctrl, so browser shortcuts keep working.</p>
        </div>
      </div>
    </div>
  );
}
