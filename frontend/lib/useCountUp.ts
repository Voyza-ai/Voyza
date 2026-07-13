'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Animate a number toward `target` with an ease-out curve.
 *
 * Why this exists as its own hook, and the REAL bug it fixes:
 * the results header's total is fed by data that arrives ASYNCHRONOUSLY —
 * hotels stream in a moment after the page renders and each one bumps the
 * total, changing `target` several times in quick succession.
 *
 * The failure that produced a visibly-wrong total (e.g. "$89" or "$393" on a
 * ~$1,510 / ~$2,604 trip while the per-person figure was correct) was NOT a
 * stale frame — it was `requestAnimationFrame` being PAUSED. Browsers stop
 * firing rAF whenever `document.visibilityState === 'hidden'`: the results
 * tab is backgrounded, the window loses focus, or the page simply loads while
 * not in the foreground. With rAF paused, a pure-rAF count-up freezes at
 * whatever value it last reached and never recovers, so the total is left
 * stuck below the real number. (The per-person figure is unaffected only
 * because it isn't animated.)
 *
 * This version is correct-by-construction:
 *   - each effect run is fully isolated (closure-local `cancelled`/`raf`/
 *     `start`), so a superseded frame checks `cancelled` and bails;
 *   - it animates FROM the current displayed value TO the new target, so
 *     rapid retargets are smooth (no drop back to 0);
 *   - a `setTimeout` SAFETY NET guarantees the value lands on EXACTLY
 *     `target` even if rAF never fires. Unlike rAF, setTimeout still runs
 *     while the page is hidden (throttled, but it fires), so the total can
 *     never freeze below the real value — it snaps to the truth within
 *     ~`duration`. When rAF is healthy the animation completes first and the
 *     safety net is a redundant no-op.
 */
export function useCountUp(target: number, duration = 1200): number {
  const [value, setValue] = useState(0);
  // The last value we actually displayed — the animation continues from
  // here when the target changes mid-flight.
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    if (from === target) {
      setValue(target);
      return;
    }

    let cancelled = false;
    let raf = 0;
    let start: number | null = null;

    const settle = () => {
      if (cancelled) return;
      fromRef.current = target;
      setValue(target);
    };

    const step = (ts: number) => {
      if (cancelled) return; // superseded target — bail
      if (start === null) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const v = Math.round(from + (target - from) * eased);
      fromRef.current = v;
      setValue(v);
      if (progress < 1) {
        raf = requestAnimationFrame(step);
      } else {
        settle();
      }
    };

    raf = requestAnimationFrame(step);

    // Safety net for when rAF is paused (hidden/backgrounded tab): setTimeout
    // still fires, so we always land on the real number even with zero frames.
    // The small buffer past `duration` lets a healthy animation finish first.
    const safety = setTimeout(settle, duration + 200);

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(safety);
    };
  }, [target, duration]);

  return value;
}
