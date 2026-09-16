'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Users, TrendingDown, Sparkles, PenSquare, MessageSquare, ChevronDown } from 'lucide-react';
import { Trip } from '@/lib/types';
import { liveTripTotal } from '@/lib/tripTotals';
import { useCountUp } from '@/lib/useCountUp';
import {
  stashCanvasIntent,
  clearCanvasIntent,
  resolveCanvasTripId,
  type CanvasIntent,
} from '@/lib/canvasHandoff';
import { useAuthStore } from '@/store/authStore';
import { useTripStore } from '@/store/tripStore';
import LoginModal from '@/components/shared/LoginModal';
import TripNameEditor from '@/components/shared/TripNameEditor';
import { updateTrip } from '@/lib/api';

type ResultsHeaderProps = {
  trip: Trip;
};

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const parseLocal = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

export default function ResultsHeader({ trip }: ResultsHeaderProps) {
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

  // Captures the current "Edit in Canvas" request so it can be resumed after
  // sign-in — including across the Google OAuth full-page redirect, which
  // wipes in-memory trip state.
  const buildCanvasIntent = (): CanvasIntent => ({
    savedId: alreadySaved ? trip.id ?? null : null,
    // Pass the whole trip through so new fields (budget, vibe,
    // dateShiftSuggestion, etc.) flow to the backend.
    payload: alreadySaved ? null : { ...trip, totalCost: liveTripTotal(trip) },
    origin: trip.origin
      ? { origin: trip.origin, returnToHome: trip.returnToHome ?? true }
      : null,
    // Current cities (including any AI-chat edits) so the canvas reflects them.
    syncCities: trip.cities,
  });

  const handleEditInCanvas = async () => {
    if (!user) {
      // Persist the intent so it survives the OAuth redirect, then prompt
      // sign-in. The callback page (Google) or onSuccess below (password)
      // resumes it.
      stashCanvasIntent(buildCanvasIntent());
      setShowLoginModal(true);
      return;
    }

    // Already authenticated — save if needed and open canvas in a new tab.
    setSaving(true);
    try {
      const tripId = await resolveCanvasTripId(buildCanvasIntent());
      if (!tripId) return;

      if (!alreadySaved) {
        setTrip({ ...trip, id: tripId });
        // Update the browser URL so the trip is bookmarkable
        if (typeof window !== 'undefined') {
          const url = new URL(window.location.href);
          url.searchParams.set('tripId', tripId);
          window.history.replaceState({}, '', url.toString());
        }
      }
      window.open(`/canvas/${tripId}`, '_blank');
    } catch {
      // handle error silently
    } finally {
      setSaving(false);
    }
  };

  // Email/password sign-in completes in-place (no redirect), so the trip is
  // still in memory. Resume straight into canvas in the same tab — opening a
  // new tab here would be blocked since the user gesture was consumed by the
  // async sign-in.
  const handleLoginSuccess = async () => {
    setSaving(true);
    try {
      const tripId = await resolveCanvasTripId(buildCanvasIntent());
      clearCanvasIntent();
      if (!tripId) return;
      if (!alreadySaved) setTrip({ ...trip, id: tripId });
      router.push(`/canvas/${tripId}`);
    } catch {
      // handle error silently
    } finally {
      setSaving(false);
    }
  };
  const startDate = trip.cities[0]?.dates.arrival;
  const endDate = trip.cities[trip.cities.length - 1]?.dates.departure;
  const totalNights = startDate && endDate
    ? Math.round(
        (parseLocal(endDate).getTime() - parseLocal(startDate).getTime()) /
          (1000 * 60 * 60 * 24)
      )
    : 0;

  const liveTotal = liveTripTotal(trip);
  const travelers = Math.max(1, trip.travelers);
  // Savings tracks the delta vs the original baseline (totalCost - savings was the
  // pre-optimized baseline). When the user picks a more expensive hotel the
  // savings shrink in lockstep so the comparison stays honest.
  const baseline = trip.totalCost + trip.savings;
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

    if (!a.destinations?.length) {
      store.setAnswer('destinations', trip.cities.map((c) => c.name));
    }
    if (!a.travelers) store.setAnswer('travelers', trip.travelers);
    if (!a.origin && trip.origin?.city) {
      store.setAnswer('origin', trip.origin.city);
      store.setAnswer('originAirports', trip.origin.airports ?? []);
    }
    if (a.returnToHome == null && trip.returnToHome != null) {
      store.setAnswer('returnToHome', trip.returnToHome);
    }
    store.setAnswer('dateRange', { start: opt.newStartDate, end: endISO });
    store.setAnswer('planningMode', 'destination');
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
      {/* No flex-wrap here: long AI-built route titles ("Berlin → Florence →
          Barcelona → Madrid") used to widen the left block until the price
          pills + buttons wrapped onto a second row, breaking the header
          alignment. Instead the left column shrinks (flex-1 + min-w-0) and
          the title truncates within it, so the right cluster stays pinned
          top-right, aligned with the meta row. */}
      <div className="flex items-start justify-between gap-4">
        {/* Left: meta + title stacked tight */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap text-xs mb-0.5">
            <div className="flex items-center gap-2 text-[#2e6bc4] uppercase tracking-[0.18em] font-medium">
              <Sparkles size={12} />
              <span>Optimized itinerary</span>
            </div>
            <span className="text-gray-300">·</span>
            <div className="flex items-center gap-1.5 text-gray-600">
              <Calendar size={12} />
              <span>
                {startDate && formatDate(startDate)} – {endDate && formatDate(endDate)}
              </span>
              <span className="text-gray-500">· {totalNights} nights</span>
            </div>
            <span className="text-gray-400">·</span>
            <div className="flex items-center gap-1.5 text-gray-600">
              <Users size={12} />
              <span>
                {trip.travelers} {trip.travelers === 1 ? 'traveler' : 'travelers'}
              </span>
            </div>
            <span className="text-gray-400">·</span>
            <span className="text-gray-500">{trip.cities.length} stops</span>
          </div>
          <TripNameEditor
            value={trip.title ?? ''}
            canRename
            onRename={handleRename}
            placeholder="Name this trip"
            className="text-[22px] leading-tight font-semibold text-gray-900"
            inputClassName="text-[22px] leading-tight font-semibold text-gray-900 w-[380px] max-w-full"
          />
          {renameError && (
            <p className="text-[11px] mt-0.5" style={{ color: '#dc2626' }}>
              {renameError}
            </p>
          )}
        </div>

        {/* Right: toggle stacked above cost cards + save button. Never
            wraps below the title — the row above is no-wrap by design. */}
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          {/* Total / Per-person pill toggle — sits above the cards so it doesn't widen the row */}
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

          <div className="flex items-center gap-2">
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

          {/* Savings — clickable when date-shift options exist: opens a
              menu of alternative start dates with their real, re-priced
              savings (the optimizer scored each shifted date already). */}
          <div className="relative" ref={shiftMenuRef}>
            <button
              type="button"
              onClick={() => shiftOptions.length > 0 && setShiftMenuOpen((v) => !v)}
              disabled={shiftOptions.length === 0}
              title={
                shiftOptions.length > 0
                  ? 'See which start dates would save you money'
                  : undefined
              }
              className={`flex flex-col justify-center px-3 py-1.5 rounded-xl border min-w-[110px] text-left transition-all ${
                shiftOptions.length > 0 ? 'cursor-pointer hover:brightness-95' : 'cursor-default'
              }`}
              style={{
                background: 'linear-gradient(180deg, rgba(52,211,153,0.08) 0%, rgba(52,211,153,0.02) 100%)',
                borderColor: 'rgba(52,211,153,0.25)',
              }}
            >
              <div className="flex items-center gap-1 text-[#22c088]/70 text-[9px] uppercase tracking-wider">
                <TrendingDown size={9} />
                <span>You can save</span>
                {shiftOptions.length > 0 && (
                  <ChevronDown
                    size={9}
                    className={`transition-transform ${shiftMenuOpen ? 'rotate-180' : ''}`}
                  />
                )}
              </div>
              <div className="text-[#22c088] text-lg font-semibold leading-tight tabular-nums">
                ${animatedSavings.toLocaleString()}
              </div>
              <div className="text-[#22c088]/50 text-[9px]">
                {shiftIsBest ? `by starting ${shiftDateNice}` : 'vs default routing'}
              </div>
            </button>

            {shiftMenuOpen && shiftOptions.length > 0 && (
              <div
                className="absolute right-0 top-full mt-2 w-[264px] bg-white border rounded-xl shadow-lg z-50 overflow-hidden"
                style={{ borderColor: 'rgba(52,211,153,0.35)' }}
              >
                <div className="px-3 pt-2.5 pb-1.5 text-[10px] uppercase tracking-wider text-gray-400 font-medium">
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
              </div>
            )}
          </div>

          {/* Edit in Canvas — saves the trip first if needed and then
              opens the canvas. Replaces the standalone Save Trip button
              per the backend_gohiltalla UI consolidation: one button
              does both, branching internally on whether the trip is
              already persisted (`alreadySaved`). The save-only state of
              the previous button (Saved checkmark, etc.) is rolled into
              `handleEditInCanvas`'s flow. */}
          {/* Adjust trip — reopens the planning chat with everything
              filled in (resume=1 keeps the conversation + answers) so the
              user can change anything and search again. */}
          <button
            onClick={() => router.push('/plan?resume=1')}
            title="Reopen the planning chat with your trip loaded — change anything and search again"
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border text-[12px] font-medium transition-all hover:bg-blue-50"
            style={{ color: '#2e6bc4', borderColor: '#2e6bc4' }}
          >
            <MessageSquare size={13} />
            Adjust trip
          </button>

          <button
            onClick={handleEditInCanvas}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-60"
            style={{ background: '#2563eb', borderColor: '#2563eb' }}
          >
            <PenSquare size={13} />
            {saving ? 'Saving...' : 'Edit in Canvas'}
          </button>
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
