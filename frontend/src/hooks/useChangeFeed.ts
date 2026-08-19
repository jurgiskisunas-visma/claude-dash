import { useEffect } from "react";
import * as signalR from "@microsoft/signalr";
import type { ChangeEvent } from "../types/api";

export function useChangeFeed(onChange: (e: ChangeEvent) => void) {
  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder()
      .withUrl("/hub")
      .withAutomaticReconnect()
      .build();
    conn.on("change", onChange);
    conn.start().catch((err) => console.warn("SignalR connect failed", err));
    return () => {
      conn.stop().catch(() => {});
    };
  }, [onChange]);
}
