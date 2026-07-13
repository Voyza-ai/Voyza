'use client';

import { useRef } from 'react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';

/**
 * Counter of distinct times PlanPage has *entered* — not counting React 18
 * StrictMode's double-invoke. Each genuine mount (fresh load, navigation
 * from /results back to /plan, etc.) increments this. The component
 * compares its captured entry count against the module's current count to
 * decide whether this is the first render for a new visit vs. a StrictMode
 * re-render of the same visit.
 */
let planPageEntryCount = 0;

export default function PlanPage() {
  // Why not `useEffect` for the reset?
  //   - Effect runs AFTER children mount, so PlanningChat would read the
  //     stale `answers.rawInput` from the previous trip and render
  //     "Love it — …" before the reset lands
  // Why not a `ready` gate + `return null`?
  //   - It creates a 0-frame flash where the intent picker's entrance
  //     animation starts from an unmounted state, producing the "weird
  //     half-rendered picker" the user was seeing on rapid interactions
  // Why `useRef` + module counter instead of just the module counter?
  //   - In StrictMode dev, the component mounts → unmounts → remounts for
  //     the same visit. Module counter would tick twice; we only want to
  //     reset once per visit. The ref captures the count at first render
  //     so the StrictMode re-mount sees the same value and skips reset
  const entryRef = useRef<number | null>(null);
  if (entryRef.current === null) {
    planPageEntryCount += 1;
    entryRef.current = planPageEntryCount;
    // ?resume=1 (the "Adjust trip" path from results) keeps the whole
    // planning session — answers AND the AI conversation — so the user
    // can change anything without starting over. Every other entry gets
    // the usual clean slate.
    const resume =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('resume') === '1';
    if (!resume) {
      // Zustand's `getState().setter()` is safe to call during render —
      // it queues a React update rather than mutating the in-flight render.
      // A landing-page rawInput seed (if present) survives the reset so
      // the conversation opens with the user's sentence.
      const heroSeed = useTripStore.getState().answers.rawInput;
      useTripStore.getState().resetPlanning();
      if (heroSeed) useTripStore.getState().setAnswer('rawInput', heroSeed);
    }
  }

  return <PlanningChat />;
}
