'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Animate a number toward `target` with an ease-out curve.
 *
 * Why this exists as its own hook (and why the previous inline version was
 * buggy): the results header's total is fed by data that arrives
 * ASYNCHRONOUSLY — hotels stream in a moment after the page renders and
 * each one bumps the total, changing `target` several times in quick
 * succession. The old implementation:
 *   - restarted from 0 on every target change (visually dropping to $0), and
 *   - shared a single `rafRef` across effect runs with no per-run guard, so
 *     an orphaned frame from a STALE target could fire after cleanup and
 *     `setValue` a stale/intermediate number — leaving the total frozen
 *     below the real value (e.g. "$393" on a ~$2,600 trip). The per-person
 *     figure was unaffected only because it isn't animated.
 *
 * This version is correct-by-construction:
 *   - each effect run is fully isolated (closure-local `cancelled`/`raf`/
 *     `start`), so a stale frame checks `cancelled` and bails — it can never
 *     clobber the current value;
 *   - it animates FROM the current displayed value TO the new target, so
 *     rapid retargets are smooth (no drop to 0);
 *   - on completion it sets the value to EXACTLY `target`, so it always
 *     settles on the real number and can never freeze partway.
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

    const step = (ts: number) => {
      if (cancelled) return; // orphaned frame from a superseded target — bail
      if (start === null) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const v = Math.round(from + (target - from) * eased);
      fromRef.current = v;
      setValue(v);
      if (progress < 1) {
        raf = requestAnimationFrame(step);
      } else {
        // Guarantee the final value is EXACTLY the target.
        fromRef.current = target;
        setValue(target);
      }
    };

    raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [target, duration]);

  return value;
}
