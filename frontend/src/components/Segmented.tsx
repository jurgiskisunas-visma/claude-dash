import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface Segment<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

/**
 * Segmented control whose active background is a single element that *slides* between
 * segments. Measured rather than CSS-only, because the segments have different widths
 * (a tab can be "Jira ×2" or "PR #481") and a transform is the only way to move a
 * background smoothly without animating layout.
 */
export function Segmented<T extends string>({
  segments, value, onChange, className,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  // First paint should place the indicator, not animate it in from nowhere.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = itemRefs.current.get(value);
    const track = trackRef.current;
    if (!el || !track) return;
    setBox({ x: el.offsetLeft - track.clientLeft, w: el.offsetWidth });
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [value, segments.length]);

  // Labels can change width (a terminal dot appears, a PR number arrives).
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const el = itemRefs.current.get(value);
      if (el) setBox({ x: el.offsetLeft - track.clientLeft, w: el.offsetWidth });
    });
    ro.observe(track);
    return () => ro.disconnect();
  }, [value]);

  return (
    <div ref={trackRef} className={className ? `segment ${className}` : "segment"}>
      {box && (
        <span
          aria-hidden
          className="segment-indicator"
          style={{
            transform: `translateX(${box.x}px)`,
            width: box.w,
            transition: ready ? undefined : "none",
          }}
        />
      )}
      {segments.map((s) => (
        <button
          key={s.value}
          ref={(el) => {
            if (el) itemRefs.current.set(s.value, el);
            else itemRefs.current.delete(s.value);
          }}
          onClick={() => onChange(s.value)}
          data-on={s.value === value}
          title={s.title}
          className="segment-item"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
