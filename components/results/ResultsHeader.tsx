'use client';

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

  return (
    <div className="px-8 pt-5 pb-0">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        {/* Left: label + inline meta, then title below */}
        <div className="flex-1 min-w-[280px]">
          <div className="flex items-center gap-3 flex-wrap text-xs mb-2">
            <div className="flex items-center gap-2 text-[#4f8ef7] uppercase tracking-[0.18em] font-medium">
              <Sparkles size={12} />
              <span>Optimized itinerary</span>
            </div>
            <span className="text-white/20">·</span>
            <div className="flex items-center gap-1.5 text-white/50">
              <Calendar size={12} />
              <span>
                {startDate && formatDate(startDate)} – {endDate && formatDate(endDate)}
              </span>
              <span className="text-white/30">· {totalNights} nights</span>
            </div>
            <span className="text-white/20">·</span>
            <div className="flex items-center gap-1.5 text-white/50">
              <Users size={12} />
              <span>
                {trip.travelers} {trip.travelers === 1 ? 'traveler' : 'travelers'}
              </span>
            </div>
            <span className="text-white/20">·</span>
            <span className="text-white/40">{trip.cities.length} stops</span>
          </div>
          <h1 className="text-[30px] leading-tight font-semibold text-white">
            {trip.title}
          </h1>
        </div>

        {/* Right: cost summary */}
        <div className="flex items-stretch gap-3">
          {/* Total cost */}
          <div
            className="flex flex-col justify-center px-5 py-3 rounded-2xl border backdrop-blur-md min-w-[140px]"
            style={{
              background: 'rgba(255,255,255,0.025)',
              borderColor: 'rgba(255,255,255,0.08)',
            }}
          >
            <div className="text-white/40 text-[10px] uppercase tracking-wider mb-1">
              Total trip
            </div>
            <div className="text-white text-2xl font-semibold leading-none tabular-nums">
              ${liveTotal.toLocaleString()}
            </div>
            <div className="text-white/35 text-[11px] mt-1.5">
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
            <div className="flex items-center gap-1.5 text-[#34d399]/70 text-[10px] uppercase tracking-wider mb-1">
              <TrendingDown size={10} />
              <span>You save</span>
            </div>
            <div className="text-[#34d399] text-2xl font-semibold leading-none tabular-nums">
              ${liveSavings.toLocaleString()}
            </div>
            <div className="text-[#34d399]/50 text-[11px] mt-1.5">
              vs default routing
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
