'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Users, TrendingDown, Sparkles, PenSquare, MessageSquare } from 'lucide-react';
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
  const alreadySaved = !!trip.id && !trip.id.startsWith('mock');

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
  const liveSavings = Math.max(0, baseline - liveTotal);

  // "You can save" surfaces the single MOST valuable savings opportunity:
  // either the routing optimization we already applied, or the date-shift
  // suggestion (also delivered as a Voyza AI chat tip) — whichever is bigger.
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

  // Per-person vs total display toggle is global (read from tripStore) so
  // every price across the results page — flights, hotels, transit, savings —
  // flips together with the header pill.
  const priceMode = useTripStore((s) => s.priceMode);
  const setPriceMode = useTripStore((s) => s.setPriceMode);
  const displayedTotal =
    priceMode === 'total' ? liveTotal : Math.round(liveTotal / travelers);
  const displayedSavings =
    priceMode === 'total' ? bestSavings : Math.round(bestSavings / travelers);
  const animatedTotal = useCountUp(displayedTotal);
  const animatedSavings = useCountUp(displayedSavings);
  // Subtitle shows the alternate framing so both numbers are visible at a glance.
  const altTotal =
    priceMode === 'total' ? Math.round(liveTotal / travelers) : liveTotal;
  const showToggle = travelers > 1;

  return (
    <div className="px-4 pt-3 pb-0">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Left: meta + title stacked tight */}
        <div className="min-w-0">
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
          <h1 className="text-[22px] leading-tight font-semibold text-gray-900 truncate">
            {trip.title}
          </h1>
        </div>

        {/* Right: toggle stacked above cost cards + save button */}
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

          {/* Savings */}
          <div
            className="flex flex-col justify-center px-3 py-1.5 rounded-xl border min-w-[110px]"
            style={{
              background: 'linear-gradient(180deg, rgba(52,211,153,0.08) 0%, rgba(52,211,153,0.02) 100%)',
              borderColor: 'rgba(52,211,153,0.25)',
            }}
          >
            <div className="flex items-center gap-1 text-[#22c088]/70 text-[9px] uppercase tracking-wider">
              <TrendingDown size={9} />
              <span>You can save</span>
            </div>
            <div className="text-[#22c088] text-lg font-semibold leading-tight tabular-nums">
              ${animatedSavings.toLocaleString()}
            </div>
            <div className="text-[#22c088]/50 text-[9px]">
              {shiftIsBest ? `by starting ${shiftDateNice}` : 'vs default routing'}
            </div>
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
