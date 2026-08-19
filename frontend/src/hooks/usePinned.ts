import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe, togglePin } from "../lib/pinnedSessions";

export function usePinnedSet(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function usePinned(sessionId: string): [boolean, () => void] {
  const set = usePinnedSet();
  return [set.has(sessionId), () => togglePin(sessionId)];
}
