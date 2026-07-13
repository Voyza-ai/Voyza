import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { useCountUp } from '@/lib/useCountUp';

// Controllable requestAnimationFrame: callbacks queue, and tick(ms) fires
// them with an advancing timestamp — lets us drive the animation frame by
// frame and, crucially, retarget MID-animation the way async hotel loads do.
let rafQueue: Array<(ts: number) => void> = [];
let now = 0;
let rafId = 0;

beforeEach(() => {
  rafQueue = [];
  now = 0;
  rafId = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    rafQueue.push(cb as any);
    return ++rafId;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

/** Advance time by `ms` and flush whatever frames are queued at that point. */
function tick(ms: number) {
  now += ms;
  const batch = rafQueue;
  rafQueue = [];
  act(() => {
    batch.forEach((cb) => cb(now));
  });
}

function Probe({ target }: { target: number }) {
  const v = useCountUp(target, 1000);
  return <span data-testid="v">{v}</span>;
}

const read = () => Number(screen.getByTestId('v').textContent);

describe('useCountUp', () => {
  it('animates toward the target and settles EXACTLY on it', () => {
    render(<Probe target={1000} />);
    tick(0); // first frame establishes start
    expect(read()).toBe(0);
    tick(500); // half way (ease-out → past 50%)
    expect(read()).toBeGreaterThan(0);
    expect(read()).toBeLessThan(1000);
    tick(600); // past duration → settle
    expect(read()).toBe(1000);
  });

  it('REGRESSION: rapid mid-flight retargets settle on the LAST target, never frozen partway', () => {
    // Mirrors the results page: the total gets bumped several times as
    // hotels stream in. The old count-up could freeze at an intermediate
    // value (e.g. "$393" on a ~$2,604 trip). It must end on the final target.
    const { rerender } = render(<Probe target={920} />); // transport only
    tick(0);
    tick(200); // partway to 920

    rerender(<Probe target={1500} />); // Lisbon hotel arrives
    tick(200); // partway to 1500

    rerender(<Probe target={2604} />); // Porto hotel arrives (final)
    tick(200);
    tick(1200); // let the final animation complete

    expect(read()).toBe(2604); // settles on the real total — not frozen
  });

  it('continues from the current value on retarget (no drop back to 0)', () => {
    const { rerender } = render(<Probe target={2000} />);
    tick(0);
    tick(1200); // settle at 2000
    expect(read()).toBe(2000);

    rerender(<Probe target={2200} />); // small bump (a late hotel)
    tick(0);
    // First frame of the new animation must NOT reset to ~0.
    expect(read()).toBeGreaterThanOrEqual(2000);
    tick(1200);
    expect(read()).toBe(2200);
  });
});
