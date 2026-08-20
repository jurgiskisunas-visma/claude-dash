/**
 * Tiny command bus.
 *
 * Keyboard handling lives in one place (App), but the things it drives are spread out —
 * the tab lives in SessionDetail, the search box and row order live in SessionList. Rather
 * than lift all that state or drill props through, App dispatches a command and whoever
 * owns the state subscribes. Keeps the hotkey table readable and the components decoupled.
 */

export type Command =
  | "nav.next"
  | "nav.prev"
  | "tab.transcript"
  | "tab.changes"
  | "tab.terminal"
  | "tab.jira"
  | "tab.pr"
  | "terminal.toggle"
  | "terminal.focus.toggle"
  | "list.search"
  | "session.pin"
  | "session.hide"
  | "session.new"
  | "scratch.toggle"
  | "help.toggle"
  | "escape";

type Handler = (cmd: Command) => void;

const handlers = new Set<Handler>();

export function dispatch(cmd: Command): void {
  for (const h of handlers) h(cmd);
}

export function subscribeCommands(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
