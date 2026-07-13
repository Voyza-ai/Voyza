import React, { useState, useRef, useEffect } from 'react';
import { render, screen, act } from '@testing-library/react';
import { useCountUp as useCountUpNEW } from '@/lib/useCountUp';

// ── The OLD (buggy) implementation, kept verbatim so this regression
// proves the freeze existed AND that our fix prevents it. ──
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

// rAF mock that keeps each frame addressable so we can fire a STALE frame
// (one scheduled by a now-superseded target) late — the real freeze cause.
let frames: Map<number, (ts: number) => void>;
let nextId: number;
let cancelled: Set<number>;
beforeEach(() => {
  frames = new Map();
  cancelled = new Set();
  nextId = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: any) => {
    const id = ++nextId;
    frames.set(id, cb);
    return id;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    cancelled.add(id);
    frames.delete(id);
  });
});
afterEach(() => jest.restoreAllMocks());

let clock = 0;
function fire(id: number, ms: number) {
  clock += ms;
  const cb = frames.get(id);
  frames.delete(id);
  if (cb) act(() => cb(clock));
}
function fireAllPending(ms: number) {
  clock += ms;
  const batch = Array.from(frames.entries());
  frames.clear();
  act(() => batch.forEach(([, cb]) => cb(clock)));
}

const read = () => Number(screen.getByTestId('v').textContent);

function makeProbe(hook: typeof useCountUpNEW) {
  return function Probe({ target }: { target: number }) {
    return <span data-testid="v">{hook(target, 1000)}</span>;
  };
}

// Drive a scenario where a frame from the FIRST target is captured but not
// fired until AFTER a new target's animation has fully settled — the stale
// frame then tries to write its old value.
function runStaleScenario(hook: typeof useCountUpNEW) {
  const Probe = makeProbe(hook);
  clock = 0;
  const { rerender } = render(<Probe target={100} />);
  // Capture the callback scheduled for target=100 and hold it aside so the
  // normal flush below can't run it — it's our "already-committed" stale frame.
  const staleId = nextId;
  const staleCb = frames.get(staleId)!;
  frames.delete(staleId);

  // retarget to 5000 (a big late hotel bump) and let it fully settle
  rerender(<Probe target={5000} />);
  fireAllPending(1); // first frame of the new animation
  fireAllPending(1200); // complete → should settle at 5000
  const settled = read();

  // The stale frame fires LATE — the browser had already committed it to the
  // tick, so cancelAnimationFrame couldn't stop it. It runs after cleanup.
  clock += 1;
  act(() => staleCb(clock));

  return { settled, afterStale: read() };
}

describe('useCountUp stale-frame clobber (the real $393 freeze)', () => {
  it('OLD implementation gets clobbered by the stale frame', () => {
    const r = runStaleScenario(useCountUpOLD);
    expect(r.settled).toBe(5000);
    // the stale frame drags it back down — the frozen-below-real-total bug
    expect(r.afterStale).not.toBe(5000);
  });

  it('NEW implementation ignores the stale frame and stays on target', () => {
    const r = runStaleScenario(useCountUpNEW);
    expect(r.settled).toBe(5000);
    expect(r.afterStale).toBe(5000); // stale frame cannot clobber
  });
});
