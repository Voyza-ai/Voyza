'use client';

import { useRouter } from 'next/navigation';
import { TrainFront } from 'lucide-react';
import { getCityColor } from '@/lib/cityColors';
import { liveTripTotal } from '@/lib/tripTotals';
import { DEMO_TRIPS, capturedLabel, earliestDate, openDemoTrip } from '@/lib/demoTrips';

/**
 * A small row of stored searches (lib/demoTrips.ts) that open on /results
 * at once — no live search. Each reads as its route: pastel city chips
 * joined by the dashed route line.
 */
export default function DemoTrips() {
  const router = useRouter();
  if (DEMO_TRIPS.length === 0) return null;
  const asOf = capturedLabel(DEMO_TRIPS[0].capturedAt);

  return (
    <section className="mt-8" aria-labelledby="demo-trips-heading">
      <div className="flex items-baseline justify-between mb-2.5 px-1">
        <h2 id="demo-trips-heading" className="text-[13px] font-semibold text-gray-700">
          Demo trips
        </h2>
        <span className="text-[12px] text-gray-400">Saved searches · open instantly · prices from {asOf}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {DEMO_TRIPS.map((demo) => {
          const trip = demo.trip;
          const trains = trip.cities.filter((c) => c.transportOut?.mode === 'train').length;
          // Leaving home to the last stay's end, as the results header counts.
          const start = earliestDate(trip);
          const end = trip.cities[trip.cities.length - 1]?.dates.departure;
          const nights = start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) : 0;
          return (
            <button
              key={demo.slug}
              type="button"
              data-testid={`demo-trip-${demo.slug}`}
              onClick={() => openDemoTrip(demo, (href) => router.push(href))}
              className="group text-left rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm hover:border-blue-300 hover:shadow transition"
            >
              <div className="flex items-center flex-wrap gap-y-1.5">
                {trip.cities.map((c, i) => {
                  const color = getCityColor(c.colorIndex ?? i);
                  return (
                    <span key={c.name} className="flex items-center">
                      {i > 0 && <span aria-hidden className="w-4 border-t-2 border-dashed border-gray-300 mx-1" />}
                      <span
                        className="rounded-md px-2 py-0.5 text-[12px] font-semibold"
                        style={{ background: color.bg, color: color.text }}
                      >
                        {c.name}
                      </span>
                    </span>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center justify-between text-[12px] text-gray-500">
                <span>
                  From {trip.origin?.city ?? 'home'} · {nights} nights · {trip.travelers} travelers
                </span>
                <span className="font-semibold text-gray-900 tabular-nums">
                  ${Math.round(liveTripTotal(trip)).toLocaleString('en-US')}
                </span>
              </div>
              {trains > 0 && (
                <div className="mt-1 flex items-center gap-1 text-[12px] font-medium" style={{ color: '#2563eb' }}>
                  <TrainFront size={13} />
                  {trains === 1 ? '1 leg by train' : `${trains} legs by train`}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
