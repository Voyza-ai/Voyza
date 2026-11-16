'use client';

import { useEffect, useRef } from 'react';
import { useTripStore } from '@/store/tripStore';
import { useLeaveGuard, type LeaveGuardCopy } from '@/lib/leaveGuard';
import type { PlanningAnswers, Trip } from '@/lib/types';

const PLANNER: LeaveGuardCopy = {
  title: 'Leave the planner?',
  body: "You haven't found your trip yet, so your answers will be lost.",
};

/**
 * What the traveller has told the planner: the trip's own answers and how
 * many times they wrote in the AI chat. Not the mode picked on the first
 * question (one click), nor what the search derives (airports, vibe picks).
 */
function answersKey(a: Partial<PlanningAnswers>, userTurns: number): string {
  return JSON.stringify([
    a.destinations ?? [],
    a.vibe ?? null,
    a.dateRange ?? null,
    a.flexible ?? null,
    a.travelers ?? null,
    a.budget ?? null,
    a.budgetPerPerson ?? null,
    a.extraNotes ?? null,
    a.origin ?? null,
    a.returnToHome ?? null,
    userTurns,
  ]);
}

/**
 * Ask before the planner is left (Back, a swipe, the logo, closing the tab)
 * once the traveller has answered something, until "Find my trip" runs.
 *
 * The planner keeps its answers nowhere but this tab's memory, so a reload
 * loses them too. Not asked: while a search runs (`searching`, the planner's
 * own find-trip flag — that includes a one-click replan), and never for the
 * hand-over to /results, which is the app's own navigation.
 */
export function usePlannerLeaveGuard(searching: boolean): void {
  const answers = useTripStore((s) => s.answers);
  const userTurns = useTripStore((s) => s.chatHistory.filter((m) => m.role === 'user').length);
  const trip = useTripStore((s) => s.currentTrip);

  // The planner as it opened — after its mount effect has reset (or, for
  // "Adjust trip", kept) the planning state. This hook is called after that
  // effect is declared, so this effect runs after it.
  const opened = useRef<{ key: string; trip: Trip | null } | null>(null);
  useEffect(() => {
    if (opened.current) return;
    const s = useTripStore.getState();
    opened.current = {
      key: answersKey(s.answers, s.chatHistory.filter((m) => m.role === 'user').length),
      trip: s.currentTrip,
    };
  }, []);

  const answered = !!opened.current && answersKey(answers, userTurns) !== opened.current.key;
  // A search landed: its trip is in the store and /results is on its way.
  const handedOver = !!opened.current && !!trip && trip !== opened.current.trip;
  const unsaved = answered && !searching && !handedOver;
  useLeaveGuard({ inApp: unsaved, unload: unsaved, copy: PLANNER });
}
