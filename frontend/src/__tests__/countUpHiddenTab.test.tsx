import React, { useState, useRef, useEffect } from 'react';
import { render, screen, act } from '@testing-library/react';
import { useCountUp as useCountUpNEW } from '@/lib/useCountUp';

// ── The OLD (buggy) pure-rAF implementation, kept verbatim so this regression
// proves the freeze existed AND that the safety net fixes it. ──
function useCountUpOLD(target: number, duration = 1000) {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    startRef.current = null;
    const animate = (ts: number) => {
      if (startRef.current === null) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(eased * target));
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);
  return value;
}

// Model a HIDDEN / backgrounded tab: browsers PAUSE requestAnimationFrame
// while document.visibilityState === 'hidden', so registered frames never
// fire. setTimeout keeps running (that's the whole point of the safety net),
// driven here by fake timers so we can advance it deterministically.
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1); // never calls back
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => {
  act(() => { jest.runOnlyPendingTimers(); });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const read = () => Number(screen.getByTestId('v').textContent);

function Probe({ hook, target }: { hook: typeof useCountUpNEW; target: number }) {
  return <span data-testid="v">{hook(target, 1000)}</span>;
}

describe('useCountUp with rAF paused (hidden/backgrounded tab — the real freeze)', () => {
  it('OLD pure-rAF implementation FREEZES below the real total when no frame fires', () => {
    render(<Probe hook={useCountUpOLD} target={1510} />);
    act(() => { jest.advanceTimersByTime(3000); }); // well past the animation
    expect(read()).toBe(0); // stuck at the initial value — this was the bug
  });

  it('NEW implementation SETTLES on the real total via the safety net with zero frames', () => {
    render(<Probe hook={useCountUpNEW} target={1510} />);
    act(() => { jest.advanceTimersByTime(3000); });
    expect(read()).toBe(1510); // safety net lands on the truth
  });

  it('NEW: a late target bump while hidden (a hotel streaming in) still lands on the FINAL total', () => {
    const { rerender } = render(<Probe hook={useCountUpNEW} target={920} />); // transport only
    act(() => { jest.advanceTimersByTime(300); }); // hidden — nothing has settled yet
    rerender(<Probe hook={useCountUpNEW} target={1510} />); // hotels arrive, bump the target
    act(() => { jest.advanceTimersByTime(3000); });
    expect(read()).toBe(1510); // the safety net for the LATEST target wins
  });
});
