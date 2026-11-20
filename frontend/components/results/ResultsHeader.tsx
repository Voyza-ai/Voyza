'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Users, TrendingDown, Sparkles, Share2, ChevronDown, CheckCircle2, Send, Copy, Eye } from 'lucide-react';
import { Trip } from '@/lib/types';
import { liveTripTotal } from '@/lib/tripTotals';
import { vibeList } from '@/lib/vibes';
import { waysToSave, type SaveOption } from '@/lib/waysToSave';
import { tripSpan } from '@/lib/tripSpan';
import { useCountUp } from '@/lib/useCountUp';
import {
  stashCanvasIntent,
  readCanvasIntent,
  clearCanvasIntent,
  resolveCanvasTripId,
  type CanvasIntent,
} from '@/lib/canvasHandoff';
import { useAuthStore } from '@/store/authStore';
import { useTripStore, tripPicksSettled } from '@/store/tripStore';
import LoginModal from '@/components/shared/LoginModal';
import TripNameEditor from '@/components/shared/TripNameEditor';
import { updateTrip } from '@/lib/api';
import { useLeaveGuardSave } from '@/lib/leaveGuard';
import CollaboratorAvatars from './CollaboratorAvatars';
import type { TripCollaboration } from '@/hooks/useTripCollaboration';

type ResultsHeaderProps = {
  trip: Trip;
  /**
   * The trip the header PRICES and dates, while the results page re-prices
   * the one on screen: the last settled trip, so a half-searched trip never
   * reads as the total or a saving (audit D-09). Actions (rename, Edit in
   * Canvas) always use `trip`. Defaults to `trip`.
   */
  pricedTrip?: Trip;
  /** The shared-trip layer (roles, presence). Absent in isolated renders. */
  collab?: TripCollaboration;
  /** Open the share dialog — called once the trip is saved and signed in. */
  onOpenShare?: () => void;
  /** Bumped by the page when membership may have changed (avatars refetch). */
  membersKey?: number;
  /** This person can change the trip: the savings menu's switches apply. */
  canEdit?: boolean;
};

/**
 * A route name shortened for the header: past three cities, the first three
 * and "+N more" ("Lisbon → Porto → Madrid + 4 more"). Only route-style names
 * (cities joined by arrows) are shortened; a name someone typed is shown as
 * typed. Display only — the saved name is untouched.
 */
export function shortRouteTitle(title: string): string {
  const parts = title.split(' → ').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 3) return title;
  return `${parts.slice(0, 3).join(' → ')} + ${parts.length - 3} more`;
}

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function ResultsHeader({ trip, pricedTrip, collab, onOpenShare, membersKey = 0, canEdit = true }: ResultsHeaderProps) {
  const shown = pricedTrip ?? trip;
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const setTrip = useTripStore((s) => s.setTrip);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const alreadySaved = !!trip.id && !trip.id.startsWith('mock');

  // Rename the trip from the flowchart. An unsaved trip is renamed purely in
  // the store — the name then rides along into saveTrip, so a trip can be
  // named before it has ever been persisted. A saved trip is patched, and
  // rolls back if the server refuses (only its owner may rename it).
  const handleRename = async (name: string) => {
    const previous = trip.title;
    setTrip({ ...trip, title: name });
    setRenameError(null);
    if (!alreadySaved) return;

    try {
      await updateTrip(trip.id!, { title: name });
    } catch (err: any) {
      setTrip({ ...trip, title: previous });
      setRenameError(
        err?.status === 403
          ? 'Only the trip owner can rename this trip'
          : 'Could not rename this trip — try again',
      );
      setTimeout(() => setRenameError(null), 4000);
      throw err;
    }
  };

  // Captures the current Share (or Save) request so it can be resumed after
  // sign-in — including across the Google OAuth full-page redirect, which
  // wipes in-memory trip state. A trip has to be saved before it can be shared.
  const buildShareIntent = (t: Trip = trip, openShare = true): CanvasIntent => ({
    savedId: alreadySaved ? t.id ?? null : null,
    // Pass the whole trip through so new fields (budget, vibe,
    // dateShiftSuggestion, etc.) flow to the backend.
    payload: alreadySaved ? null : { ...t, totalCost: liveTripTotal(t) },
    origin: t.origin
      ? { origin: t.origin, returnToHome: t.returnToHome ?? true }
      : null,
    destination: 'results',
    openShare,
  });

  // The trip to save: the store's, which is this one plus anything that
  // landed since this render (the AI picks, while waiting for them below).
  const latestTrip = (): Trip => useTripStore.getState().currentTrip ?? trip;

  /**
   * Save the trip if it isn't yet (it gets an id and a shareable address),
   * then open the share dialog (Share) or not (the leave dialog's Save trip).
   * The save waits for the trip's AI picks (activities, restaurants) — saved
   * without them, the save would fill each city with generic placeholders
   * ("Explore Paris old town").
   */
  const saveThisTrip = async (thenShare: boolean) => {
    if (alreadySaved) {
      if (thenShare) onOpenShare?.();
      return;
    }
    setSaving(true);
    try {
      await tripPicksSettled();
      const tripId = await resolveCanvasTripId(buildShareIntent(latestTrip(), thenShare));
      clearCanvasIntent();
      if (!tripId) return;
      setTrip({ ...latestTrip(), id: tripId });
      // The trip now has an address: put it in the URL (bookmarkable, and
      // the page's shared-trip layer switches on for it).
      router.replace(`/results?tripId=${tripId}`);
      if (thenShare) onOpenShare?.();
    } catch {
      collab?.showToast('Could not save this trip — try again', 'error');
    } finally {
      setSaving(false);
    }
  };

  /** What the sign-in below was asked for: Share, or the leave dialog's Save trip. */
  const afterSignIn = useRef<'share' | 'save'>('share');
  const requestSave = (thenShare: boolean) => {
    if (!user) {
      // Persist the intent so it survives the OAuth redirect, then prompt
      // sign-in. The callback page (Google) or onSuccess below (password)
      // resumes it.
      afterSignIn.current = thenShare ? 'share' : 'save';
      stashCanvasIntent(buildShareIntent(trip, thenShare));
      setShowLoginModal(true);
      // The trip's AI picks may still be on their way. Signing in takes
      // longer than they do, so once they land the stashed trip is brought
      // up to date — unless the sign-in already used it.
      tripPicksSettled().then((waited) => {
        if (waited && readCanvasIntent()) stashCanvasIntent(buildShareIntent(latestTrip(), thenShare));
      });
      return;
    }
    saveThisTrip(thenShare);
  };
  const handleShare = () => requestSave(true);

  // Email/password sign-in completes in-place (no redirect): carry on.
  const handleLoginSuccess = () => {
    saveThisTrip(afterSignIn.current === 'share');
  };

  // What this person may do on a shared trip. An unsaved trip, or one whose
  // role is still loading, is the signed-in person's own.
  const role = collab?.active ? collab.role : 'owner';
  const canShare = role === 'owner' || role === 'editor';

  // "Save trip" in the leave dialog, for a trip never saved: the Share
  // button's save (sign-in first when signed out), without the share dialog.
  useLeaveGuardSave(!alreadySaved && canShare && !saving ? () => requestSave(false) : null);
  const canRename = !collab?.active || role === 'owner';
  // The TRIP's span — from the day the outbound leaves home — not the first
  // city's stay, which starts the day an overnight outbound lands.
  const { start: startDate, end: endDate, nights: totalNights } = tripSpan(shown);

  const liveTotal = liveTripTotal(shown);
  const travelers = Math.max(1, trip.travelers);
  // Savings tracks the delta vs the original baseline (totalCost - savings was the
  // pre-optimized baseline). When the user picks a more expensive hotel the
  // savings shrink in lockstep so the comparison stays honest.
  const baseline = shown.totalCost + shown.savings;
  // Rounded — raw floats (e.g. $3,213.72) widen the savings pill enough to
  // wrap the whole stats row below the title on narrower viewports.
  const liveSavings = Math.max(0, Math.round(baseline - liveTotal));

  // "You can save" surfaces the single MOST valuable savings opportunity:
  // either the routing optimization we already applied, or the date-shift
  // suggestion (also delivered as a BlueMurr AI chat tip) — whichever is bigger.
  // Fixes the deflating "You save $0" box when routing saved nothing but
  // shifting the start date would save real money.
  const shiftSavings = trip.dateShiftSuggestion?.savings ?? 0;
  const shiftIsBest = shiftSavings > liveSavings;
  const bestSavings = shiftIsBest ? shiftSavings : liveSavings;
  // Nothing to offer: no routing saving and no date-shift suggestion. Never
  // "You can save $0". "Best price for these dates" is said only when the
  // optimizer reports it really priced nearby dates and nothing cheaper held
  // up (`dateShiftChecked`). No suggestion alone can't say that: it is also
  // what a skipped or failed probe returns, and the probe never runs for a
  // saved Browse preset or after the dates change. Unchecked, the box makes
  // no claim at all — it isn't shown.
  const nothingToSave = Math.round(bestSavings) <= 0;
  const showPriceBox = !nothingToSave || trip.dateShiftChecked === true;
  const shiftDateNice = (() => {
    const iso = trip.dateShiftSuggestion?.newStartDate;
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  })();

  // Date-shift options menu on the savings pill. Newer trips carry an
  // options[] array (every shift that clears the savings thresholds);
  // older saved trips only have the flat headline suggestion, which we
  // treat as a one-entry menu so the pill stays clickable for them too.
  const shiftOptions = (() => {
    const s = trip.dateShiftSuggestion;
    if (!s) return [];
    return s.options && s.options.length > 0 ? s.options : [s];
  })();
  // Cheaper hotels / legs / flights the trip already holds prices for. On
  // the live trip: its indexes are what the switches apply to.
  const saveOptions = useMemo(() => waysToSave(trip), [trip]);
  const applySaveOption = (opt: SaveOption) => {
    const st = useTripStore.getState();
    const a = opt.action;
    if (a.kind === 'hotel') st.setSelectedHotel(a.cityIndex, a.hotelIndex);
    else if (a.kind === 'leg') st.setTransportOut(a.cityIndex, a.altIndex);
    else st.setHomeLegAlternative(a.direction, a.altIndex);
  };
  const [shiftMenuOpen, setShiftMenuOpen] = useState(false);
  const shiftMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shiftMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!shiftMenuRef.current?.contains(e.target as Node)) setShiftMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [shiftMenuOpen]);

  const offsetLabel = (dayOffset: number) => {
    const n = Math.abs(dayOffset);
    return `${n} day${n === 1 ? '' : 's'} ${dayOffset < 0 ? 'earlier' : 'later'}`;
  };

  const addDaysIso = (iso: string, days: number) => {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, (m || 1) - 1, (d || 1) + days);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${mm}-${dd}`;
  };

  // Clicking an option replans the SAME trip at the shifted dates: stage
  // the planner answers (from live answers when resuming, else rebuilt
  // from the trip itself so saved trips work in a fresh session), then
  // let /plan?resume=1&autorun=1 run the real search and land back on
  // results. Savings shown are from the optimizer's earlier re-pricing;
  // the replan fetches live prices, which is why we re-search rather
  // than just relabeling the dates on the current itinerary.
  const applyDateShift = (opt: { dayOffset: number; newStartDate: string }) => {
    const store = useTripStore.getState();
    const a = store.answers;

    let endISO: string | undefined;
    if (a.dateRange?.start && a.dateRange?.end) {
      endISO = addDaysIso(a.dateRange.end, opt.dayOffset);
    } else {
      const lastCity = trip.cities[trip.cities.length - 1];
      if (lastCity?.dates?.departure) {
        endISO = addDaysIso(lastCity.dates.departure, opt.dayOffset);
      }
    }
    if (!endISO) return;

    // The canvas origin handoff is a third source for the home city when
    // neither the planner answers nor the trip payload carry one.
    const storedOrigin = (() => {
      try {
        const id = (trip as any).id;
        if (!id) return null;
        const raw = localStorage.getItem(`voyza-origin-${id}`);
        return raw ? (JSON.parse(raw)?.origin ?? null) : null;
      } catch {
        return null;
      }
    })();

    // The vibes, from the answers when this session planned the trip, else
    // from the saved trip ("Culture, Food" — or an older trip's single
    // "Culture"), read back as the list the planner shows.
    const vibes = vibeList(a.vibe ? a : { vibe: trip.vibe });

    const staged = {
      destinations: a.destinations?.length
        ? a.destinations
        : trip.cities.map((c) => c.name),
      travelers: a.travelers || trip.travelers,
      origin: a.origin ?? trip.origin?.city ?? storedOrigin?.city ?? undefined,
      originAirports:
        (a.originAirports?.length ? a.originAirports : undefined) ??
        trip.origin?.airports ??
        storedOrigin?.airports ??
        [],
      returnToHome: a.returnToHome ?? trip.returnToHome ?? true,
      dateRange: { start: opt.newStartDate, end: endISO },
      planningMode: 'destination' as const,
      budget: a.budget,
      budgetPerPerson: a.budgetPerPerson,
      vibe: a.vibe ?? (trip.vibe || undefined),
      vibes: vibes.length > 0 ? vibes : undefined,
    };

    // Stage in the store AND snapshot to sessionStorage: the /plan page
    // wipes the store on entry whenever its reset check reads a stale
    // URL mid-navigation (client transitions can lag), so the planner's
    // autorun restores from this snapshot after any such wipe.
    for (const [key, value] of Object.entries(staged)) {
      if (value !== undefined) store.setAnswer(key as any, value as any);
    }
    try {
      sessionStorage.setItem('bluemurr-autorun', JSON.stringify(staged));
    } catch {
      // Storage blocked — the store staging still covers the normal case.
    }
    setShiftMenuOpen(false);
    router.push('/plan?resume=1&autorun=1');
  };
  const niceFullDate = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  };

  // Per-person vs total display toggle is global (read from tripStore) so
  // every price across the results page — flights, hotels, transit, savings —
  // flips together with the header pill.
  const priceMode = useTripStore((s) => s.priceMode);
  const setPriceMode = useTripStore((s) => s.setPriceMode);
  const displayedTotal =
    priceMode === 'total' ? liveTotal : Math.round(liveTotal / travelers);
  const displayedSavings =
    priceMode === 'total' ? Math.round(bestSavings) : Math.round(bestSavings / travelers);
  const animatedTotal = useCountUp(displayedTotal);
  const animatedSavings = useCountUp(displayedSavings);
  // Subtitle shows the alternate framing so both numbers are visible at a glance.
  const altTotal =
    priceMode === 'total' ? Math.round(liveTotal / travelers) : liveTotal;
  const showToggle = travelers > 1;

  return (
    <div className="px-4 pt-3 pb-0">
      {/* Left: meta, then the title with who's on the trip. Right: the
          price view switch, the trip's price boxes, and Share. The left column shrinks
          (flex-1 + min-w-0) so a long route title truncates instead of
          pushing the right cluster onto a second row. */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* One line. With a collaborator's buttons on the right the row is
              short of room: wrapping left "3 stops" alone on a second line,
              and clipping cut it to "3". Each fact is one unit (its dot
              included); a unit that doesn't fit drops to a second line that
              the fixed height hides, so it disappears whole. */}
          <div className="flex items-center gap-x-3 flex-wrap h-[18px] overflow-hidden whitespace-nowrap text-xs mb-0.5">
            <div className="flex items-center gap-2 text-[#2e6bc4] uppercase tracking-[0.18em] font-medium">
              <Sparkles size={12} />
              <span>Optimized itinerary</span>
            </div>
            <div className="flex items-center gap-1.5 text-gray-600">
              <span className="text-gray-300 mr-1.5">·</span>
              <Calendar size={12} />
              <span>
                {startDate && formatDate(startDate)} – {endDate && formatDate(endDate)}
              </span>
              <span className="text-gray-500">· {totalNights} nights</span>
            </div>
            <div className="flex items-center gap-1.5 text-gray-600">
              <span className="text-gray-400 mr-1.5">·</span>
              <Users size={12} />
              <span>
                {trip.travelers} {trip.travelers === 1 ? 'traveler' : 'travelers'}
              </span>
            </div>
            <div className="flex items-center text-gray-500">
              <span className="text-gray-400 mr-3">·</span>
              {trip.cities.length} {trip.cities.length === 1 ? 'stop' : 'stops'}
            </div>
          </div>
          {/* The trip's name, then who is on it. */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
            <TripNameEditor
              value={trip.title ?? ''}
              canRename={canRename}
              onRename={handleRename}
              onDenied={() => collab?.showToast('Only the trip owner can rename this trip', 'info')}
              placeholder="Name this trip"
              displayValue={shortRouteTitle(trip.title ?? '')}
              className="text-[22px] leading-tight font-semibold text-gray-900"
              inputClassName="text-[22px] leading-tight font-semibold text-gray-900 w-[380px] max-w-full"
            />
            </div>
            {collab?.active && trip.id && (
              <div className="flex-shrink-0">
              <CollaboratorAvatars
                tripId={trip.id}
                presence={collab.presence}
                selfId={collab.self?.id ?? null}
                refreshKey={membersKey}
                onClick={canShare ? handleShare : undefined}
              />
              </div>
            )}
          </div>
          {renameError && (
            <p className="text-[11px] mt-0.5" style={{ color: '#dc2626' }}>
              {renameError}
            </p>
          )}

        </div>

        {/* Right: collaborators + Share (and, for collaborators, their own
            actions). Share replaces "Edit in Canvas": the results page is
            the canvas now. */}
        <div className="flex items-center gap-2.5 flex-shrink-0 pt-1">
          {/* Prices, then Share — together on the right, under the account
              corner, so the left keeps the trip's name and facts. */}
            {showToggle && (
              <div
                className="flex items-center p-0.5 rounded-full border bg-white/80"
                style={{ borderColor: 'rgba(79,142,247,0.25)' }}
                role="tablist"
                aria-label="Price view"
              >
                <button
                  role="tab"
                  aria-selected={priceMode === 'total'}
                  onClick={() => setPriceMode('total')}
                  className="px-2 py-0.5 text-[9px] font-medium rounded-full transition-colors"
                  style={{
                    background: priceMode === 'total' ? '#4f8ef7' : 'transparent',
                    color: priceMode === 'total' ? '#ffffff' : '#4f8ef7',
                  }}
                >
                  Total
                </button>
                <button
                  role="tab"
                  aria-selected={priceMode === 'perPerson'}
                  onClick={() => setPriceMode('perPerson')}
                  className="px-2 py-0.5 text-[9px] font-medium rounded-full transition-colors"
                  style={{
                    background: priceMode === 'perPerson' ? '#4f8ef7' : 'transparent',
                    color: priceMode === 'perPerson' ? '#ffffff' : '#4f8ef7',
                  }}
                >
                  Per person
                </button>
              </div>
            )}
            {/* Savings — clickable when date-shift options exist: opens a
                menu of alternative start dates with their real, re-priced
                savings (the optimizer scored each shifted date already). */}
            {showPriceBox && (
            <div className="relative" ref={shiftMenuRef}>
              <button
                type="button"
                onClick={() => setShiftMenuOpen((v) => !v)}
                aria-expanded={shiftMenuOpen}
                aria-haspopup="dialog"
                title="See ways to save on this trip"
                className="flex flex-col justify-center px-3 py-1.5 rounded-xl border min-w-[110px] text-left transition-all cursor-pointer hover:brightness-95"
                style={{
                  background: 'linear-gradient(180deg, rgba(52,211,153,0.08) 0%, rgba(52,211,153,0.02) 100%)',
                  borderColor: 'rgba(52,211,153,0.25)',
                }}
              >
                <div className="flex items-center gap-1 text-[#22c088]/70 text-[9px] uppercase tracking-wider">
                  {nothingToSave ? <CheckCircle2 size={9} /> : <TrendingDown size={9} />}
                  <span>{nothingToSave ? 'Price check' : 'You can save'}</span>
                  {(
                    <ChevronDown
                      size={9}
                      className={`transition-transform ${shiftMenuOpen ? 'rotate-180' : ''}`}
                    />
                  )}
                </div>
                <div className="text-[#22c088] text-lg font-semibold leading-tight tabular-nums">
                  {nothingToSave ? 'Best price' : `$${animatedSavings.toLocaleString()}`}
                </div>
                <div className="text-[#22c088]/50 text-[9px]">
                  {nothingToSave
                    ? 'for these dates'
                    : shiftIsBest
                      ? `by starting ${shiftDateNice}`
                      : // The optimizer's baseline (savingsVsNaive) is the
                        // order the traveller typed — as the AI chat says it.
                        'vs your original city order'}
                </div>
              </button>

              {shiftMenuOpen && (
                <div
                  role="dialog"
                  aria-label="Ways to save"
                  className="absolute right-0 top-full mt-2 w-[300px] max-h-[70vh] overflow-y-auto bg-white border rounded-xl shadow-lg z-50"
                  style={{ borderColor: 'rgba(52,211,153,0.35)' }}
                >
                  <div className="px-3 pt-2.5 pb-1.5 text-[10px] uppercase tracking-wider text-gray-400 font-medium">
                    Ways to save
                  </div>
                  {!shiftIsBest && liveSavings > 0 && (
                    <div className="px-3 pb-2 flex items-start gap-1.5 text-[11px] text-gray-500">
                      <CheckCircle2 size={12} className="text-[#22c088] mt-px flex-shrink-0" />
                      <span>
                        Already saving $
                        {(priceMode === 'total' ? liveSavings : Math.round(liveSavings / travelers)).toLocaleString()}{' '}
                        by visiting your cities in this order.
                      </span>
                    </div>
                  )}
                  {saveOptions.map((opt) => {
                    const amt = priceMode === 'total' ? opt.savings : Math.round(opt.savings / travelers);
                    const body = (
                      <>
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium text-gray-800 truncate">{opt.title}</div>
                          <div className="text-[10px] text-gray-500 truncate">{opt.detail}</div>
                        </div>
                        <div className="text-[#22c088] text-[13px] font-semibold tabular-nums flex-shrink-0">
                          save ${amt.toLocaleString()}
                        </div>
                      </>
                    );
                    const cls = 'w-full px-3 py-2 border-t border-gray-100 flex items-center justify-between gap-2 text-left';
                    return canEdit ? (
                      <button
                        type="button"
                        key={opt.id}
                        data-testid="save-option"
                        onClick={() => {
                          applySaveOption(opt);
                          setShiftMenuOpen(false);
                        }}
                        title="Switch to this"
                        className={`${cls} transition-colors hover:bg-emerald-50/60 cursor-pointer`}
                      >
                        {body}
                      </button>
                    ) : (
                      <div key={opt.id} data-testid="save-option" className={cls}>
                        {body}
                      </div>
                    );
                  })}
                  {saveOptions.length === 0 && shiftOptions.length === 0 && (
                    <div className="px-3 py-2 border-t border-gray-100 text-[11px] text-gray-500">
                      No cheaper hotel, train or flight on this trip right now — you already have the lowest prices we found.
                    </div>
                  )}
                  {shiftOptions.length > 0 && (
                  <>
                  <div className="px-3 pt-2.5 pb-1.5 border-t border-gray-100 text-[10px] uppercase tracking-wider text-gray-400 font-medium">
                    Cheaper start dates
                  </div>
                  {shiftOptions.map((opt) => {
                    const optSavings =
                      priceMode === 'total'
                        ? Math.round(opt.savings)
                        : Math.round(opt.savings / travelers);
                    return (
                      <button
                        type="button"
                        key={opt.dayOffset}
                        onClick={() => applyDateShift(opt)}
                        title="Replan this trip starting on this date"
                        className="w-full px-3 py-2 border-t border-gray-100 flex items-center justify-between gap-2 text-left transition-colors hover:bg-emerald-50/60 cursor-pointer"
                      >
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium text-gray-800">
                            {offsetLabel(opt.dayOffset)}
                          </div>
                          <div className="text-[10px] text-gray-500">
                            starts {niceFullDate(opt.newStartDate)}
                          </div>
                        </div>
                        <div className="text-[#22c088] text-[13px] font-semibold tabular-nums flex-shrink-0">
                          save ${optSavings.toLocaleString()}
                        </div>
                      </button>
                    );
                  })}
                  <div className="px-3 py-2 border-t border-gray-100 text-[10px] text-gray-400">
                    Picking a date replans your trip with live prices — the
                    final savings can differ slightly.
                  </div>
                  </>
                  )}
                </div>
              )}
            </div>
            )}
            {/* Total cost */}
            <div
              className="flex flex-col justify-center px-3 py-1.5 rounded-xl border min-w-[110px]"
              style={{
                background: 'linear-gradient(180deg, rgba(79,142,247,0.12) 0%, rgba(79,142,247,0.04) 100%)',
                borderColor: 'rgba(79,142,247,0.30)',
              }}
            >
              <div className="text-[#4f8ef7]/70 text-[9px] uppercase tracking-wider">
                {priceMode === 'total' ? 'Total trip' : 'Per person'}
              </div>
              <div className="text-[#4f8ef7] text-lg font-semibold leading-tight tabular-nums">
                ${animatedTotal.toLocaleString()}
              </div>
              {showToggle && (
                <div className="text-[#4f8ef7]/55 text-[9px]">
                  ${altTotal.toLocaleString()} {priceMode === 'total' ? '/person' : 'total'}
                </div>
              )}
            </div>

          {/* The actions, a step apart from the prices: secondary ones
              first, the main one last — where Share sits for the owner. */}
          <div className="flex items-center gap-2 ml-3 pl-4 border-l border-gray-200 self-stretch">
            {role === 'viewer' && (
              <span
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] text-gray-500 bg-white/80 border border-gray-200"
                title="The owner shared this trip with you to view"
              >
                <Eye size={11} />
                View only
              </span>
            )}

            {(role === 'editor' || role === 'suggester') && (
              <button
                onClick={collab?.saveCopy}
                disabled={collab?.busy}
                title="Save the trip as it is now to your own trips — the shared trip is untouched"
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border text-[12px] font-medium transition-all hover:bg-blue-50 disabled:opacity-40"
                style={{ color: '#2563eb', borderColor: '#2563eb', background: '#ffffff' }}
              >
                <Copy size={13} />
                Save a copy
              </button>
            )}

            {role === 'suggester' && collab?.hasLocalChanges && (
              <>
                <button
                  onClick={collab.discard}
                  disabled={collab.busy}
                  title="Throw away your changes"
                  className="px-2.5 py-2 rounded-xl text-[12px] font-medium text-gray-500 transition-colors hover:text-gray-800 hover:bg-gray-100 disabled:opacity-40"
                >
                  Discard
                </button>
                <button
                  onClick={collab.propose}
                  disabled={collab.busy}
                  title="Your changes go to the owner for approval"
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
                  style={{ background: '#2563eb' }}
                >
                  <Send size={13} />
                  {collab.busy ? 'Sending…' : 'Propose changes'}
                </button>
              </>
            )}

            {canShare && (
              <button
                onClick={handleShare}
                disabled={saving}
                data-testid="share-button"
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl border text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-60"
                style={{ background: '#2563eb', borderColor: '#2563eb' }}
              >
                <Share2 size={13} />
                {saving ? 'Saving...' : 'Share'}
              </button>
            )}
          </div>
        </div>
      </div>

      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={handleLoginSuccess}
      />
    </div>
  );
}
