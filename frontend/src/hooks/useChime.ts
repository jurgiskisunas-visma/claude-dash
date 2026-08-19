import { useRef } from "react";

/**
 * Two-tone "ding" via Web Audio. No assets needed.
 * Audio context is lazily created on first call (browsers require a user gesture
 * first; if the user has clicked anything in the app, we're past that).
 */
export function useChime() {
  const ctxRef = useRef<AudioContext | null>(null);

  return () => {
    try {
      if (!ctxRef.current) ctxRef.current = new AudioContext();
      const ctx = ctxRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      const make = (freq: number, start: number, dur: number, vol = 0.08) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now + start);
        gain.gain.setValueAtTime(0, now + start);
        gain.gain.linearRampToValueAtTime(vol, now + start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + dur + 0.05);
      };
      make(880, 0, 0.18);
      make(1175, 0.14, 0.22);
    } catch {
      /* ignore — Audio not available */
    }
  };
}
