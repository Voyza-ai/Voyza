'use client';

import { useState, useEffect, useRef } from 'react';
import { Calendar, Users, TrendingDown, Sparkles } from 'lucide-react';
import { Trip } from '@/lib/types';
import { liveTripTotal } from '@/lib/tripTotals';

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
    <div className="px-8 pt-5 pb-0">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        {/* Left: label + inline meta, then title below */}
        <div className="flex-1 min-w-[280px]">
          <div className="flex items-center gap-3 flex-wrap text-xs mb-2">
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
          <h1 className="text-[30px] leading-tight font-semibold text-gray-900">
            {trip.title}
          </h1>
        </div>

        {/* Right: cost summary */}
        <div className="flex items-stretch gap-3">
          {/* Total cost */}
          <div
            className="flex flex-col justify-center px-5 py-3 rounded-2xl border backdrop-blur-md min-w-[140px]"
            style={{
              background: 'linear-gradient(180deg, rgba(79,142,247,0.12) 0%, rgba(79,142,247,0.04) 100%)',
              borderColor: 'rgba(79,142,247,0.30)',
            }}
          >
            <div className="text-[#4f8ef7]/70 text-[10px] uppercase tracking-wider mb-1">
              Total trip
            </div>
            <div className="text-[#4f8ef7] text-2xl font-semibold leading-none tabular-nums">
              ${animatedTotal.toLocaleString()}
            </div>
            <div className="text-[#4f8ef7]/55 text-[11px] mt-1.5">
              ${perPerson.toLocaleString()} per person
            </div>
          </div>

          {/* Savings */}
          <div
            className="flex flex-col justify-center px-5 py-3 rounded-2xl border backdrop-blur-md min-w-[140px]"
            style={{
              background: 'linear-gradient(180deg, rgba(52,211,153,0.08) 0%, rgba(52,211,153,0.02) 100%)',
              borderColor: 'rgba(52,211,153,0.25)',
            }}
          >
            <div className="flex items-center gap-1.5 text-[#22c088]/70 text-[10px] uppercase tracking-wider mb-1">
              <TrendingDown size={10} />
              <span>You save</span>
            </div>
            <div className="text-[#22c088] text-2xl font-semibold leading-none tabular-nums">
              ${animatedSavings.toLocaleString()}
            </div>
            <div className="text-[#22c088]/50 text-[11px] mt-1.5">
              vs default routing
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
