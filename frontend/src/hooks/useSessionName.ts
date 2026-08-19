import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe, setName } from "../lib/sessionNames";

export function useSessionName(sessionId: string): [string | undefined, (n: string | null) => void] {
  const all = useSyncExternalStore(subscribe, getSnapshot);
  const current = all[sessionId];
  return [current && current.trim() ? current : undefined, (n) => setName(sessionId, n)];
}
