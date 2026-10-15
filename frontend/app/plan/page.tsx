'use client';

import PlanningChat from '@/components/planning/PlanningChat';

/**
 * Route shell for the planner — deliberately side-effect free.
 *
 * This component used to clear the planning store *during its own render*
 * (`useTripStore.getState().resetPlanning()` behind a `useRef` first-render
 * guard) so the reset would land before PlanningChat mounted. That was a
 * render-phase write to an external store, and it broke in a visible way: an
 * App Router navigation renders the incoming page while the outgoing one is
 * still mounted, so the store notification re-rendered /results in the middle
 * of this component's render and React logged
 *
 *   Warning: Cannot update a component (`ResultsPageInner`) while rendering
 *   a different component (`PlanPage`).
 *
 * The reset now lives in PlanningChat's own mount effect, which is the first
 * effect the planner runs — so it still happens before the planner reads any
 * planning state, but as a committed update rather than a side effect in the
 * render pass. See `components/planning/PlanningChat.tsx`.
 */
export default function PlanPage() {
  return <PlanningChat />;
}
