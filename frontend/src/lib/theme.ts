// App-wide theme store. Tailwind runs in `darkMode: "class"` mode — the "dark"
// class on <html> switches every `dark:` variant; xterm terminals subscribe to
// this store to swap their own theme objects (CSS can't reach canvas colors).
//
// The default mode is "system": the effective theme tracks the OS setting
// (prefers-color-scheme) live. The toggle can pin an explicit light/dark
// override, persisted in localStorage.
export type Theme = "dark" | "light";
export type ThemeMode = "system" | "dark" | "light";

const KEY = "claudedash:theme";
const listeners = new Set<() => void>();
const osDark = window.matchMedia("(prefers-color-scheme: dark)");

function readMode(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

let mode: ThemeMode = readMode();

function effective(): Theme {
  return mode === "system" ? (osDark.matches ? "dark" : "light") : mode;
}

function apply() {
  document.documentElement.classList.toggle("dark", effective() === "dark");
}
apply();

osDark.addEventListener("change", () => {
  if (mode !== "system") return;
  apply();
  listeners.forEach((l) => l());
});

/** The effective theme ("dark" | "light") after resolving "system" against the OS. */
export function getTheme(): Theme {
  return effective();
}

export function getThemeMode(): ThemeMode {
  return mode;
}

export function setThemeMode(m: ThemeMode) {
  if (m === mode) return;
  mode = m;
  if (m === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, m);
  apply();
  listeners.forEach((l) => l());
}

/** system → light → dark → system */
export function cycleTheme() {
  setThemeMode(mode === "system" ? "light" : mode === "light" ? "dark" : "system");
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
