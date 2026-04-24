'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Users, TrendingDown, Sparkles, PenSquare } from 'lucide-react';
import { Trip } from '@/lib/types';
import { liveTripTotal } from '@/lib/tripTotals';
import { saveTrip } from '@/lib/api';
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

function useCountUp(target: number, duration = 1200) {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    startRef.current = null;
    const animate = (ts: number) => {
      if (startRef.current === null) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(eased * target));
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return value;
}

export default function ResultsHeader({ trip }: ResultsHeaderProps) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const setTrip = useTripStore((s) => s.setTrip);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const alreadySaved = !!trip.id && !trip.id.startsWith('mock');

  const handleEditInCanvas = async () => {
    if (!user) {
      setShowLoginModal(true);
      return;
    }

    // If already saved, go straight to canvas
    if (alreadySaved) {
      window.open(`/canvas/${trip.id}`, '_blank');
      return;
    }

    // Save first, then open canvas
    setSaving(true);
    try {
      // Pass the whole trip through so new fields (budget, vibe,
      // dateShiftSuggestion, etc.) flow to the backend.
      const result = await saveTrip({ ...trip, totalCost: liveTripTotal(trip) });

      setTrip({ ...trip, id: result.tripId });

      // Update the browser URL so the trip is bookmarkable
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('tripId', result.tripId);
        window.history.replaceState({}, '', url.toString());
      }

      // Open canvas after saving
      window.open(`/canvas/${result.tripId}`, '_blank');
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
  const perPerson = Math.round(liveTotal / Math.max(1, trip.travelers));
  // Savings tracks the delta vs the original baseline (totalCost - savings was the
  // pre-optimized baseline). When the user picks a more expensive hotel the
  // savings shrink in lockstep so the comparison stays honest.
  const baseline = trip.totalCost + trip.savings;
  const liveSavings = Math.max(0, baseline - liveTotal);
  const animatedSavings = useCountUp(liveSavings);
  const animatedTotal = useCountUp(liveTotal);

  return (
    <div className="px-8 pt-3 pb-0">
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

        {/* Right: cost cards + save button */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Total cost */}
          <div
            className="flex flex-col justify-center px-3 py-1.5 rounded-xl border min-w-[110px]"
            style={{
              background: 'linear-gradient(180deg, rgba(79,142,247,0.12) 0%, rgba(79,142,247,0.04) 100%)',
              borderColor: 'rgba(79,142,247,0.30)',
            }}
          >
            <div className="text-[#4f8ef7]/70 text-[9px] uppercase tracking-wider">
              Total trip
            </div>
            <div className="text-[#4f8ef7] text-lg font-semibold leading-tight tabular-nums">
              ${animatedTotal.toLocaleString()}
            </div>
            <div className="text-[#4f8ef7]/55 text-[9px]">
              ${perPerson.toLocaleString()} /person
            </div>
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
              <span>You save</span>
            </div>
            <div className="text-[#22c088] text-lg font-semibold leading-tight tabular-nums">
              ${animatedSavings.toLocaleString()}
            </div>
            <div className="text-[#22c088]/50 text-[9px]">
              vs default routing
            </div>
          </div>

          {/* Edit in Canvas — saves trip first if needed */}
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

      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={handleEditInCanvas}
      />
    </div>
  );
}
