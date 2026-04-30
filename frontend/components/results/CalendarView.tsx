'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Plane, TrainFront, Moon } from 'lucide-react';
import { Trip, City, TransportMode } from '@/lib/types';
import { getCityColor } from '@/lib/cityColors';
import { parseLocal, toIso, daysBetween } from '@/lib/dateHelpers';
import DayPlanner from './DayPlanner';

type CalendarViewProps = {
  trip: Trip;
  onCityClick?: (cityIndex: number) => void;
};

type DayCell = {
  date: Date;
  iso: string;
  cityIndex: number | null;
  city: City | null;
  isArrival: boolean;
  isDeparture: boolean;
  /** Mode of the outbound transport on departure days (so we can pick the right icon). */
  departureMode: TransportMode | null;
  /** Depart time of the leg leaving this city on its departure day (HH:mm). */
  departureTime: string | null;
  isInMonth: boolean;
};

export default function CalendarView({ trip, onCityClick }: CalendarViewProps) {
  const [selectedDay, setSelectedDay] = useState<DayCell | null>(null);

  // Compute trip span
  const start = parseLocal(trip.cities[0].dates.arrival);
  const end = parseLocal(trip.cities[trip.cities.length - 1].dates.departure);

  // Build a map of date -> city
  const dateToCity = new Map<string, { city: City; index: number }>();
  trip.cities.forEach((city, index) => {
    const arr = parseLocal(city.dates.arrival);
    const dep = parseLocal(city.dates.departure);
    // A city "occupies" arrival up to (but not including) departure date
    const days = daysBetween(arr, dep);
    for (let i = 0; i < days; i++) {
      const d = new Date(arr);
      d.setDate(arr.getDate() + i);
      dateToCity.set(toIso(d), { city, index });
    }
  });

  // Build month grids that cover the entire trip span
  const months: { year: number; month: number; cells: DayCell[] }[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (
    cursor.getFullYear() < end.getFullYear() ||
    (cursor.getFullYear() === end.getFullYear() && cursor.getMonth() <= end.getMonth())
  ) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    const startWeekday = firstOfMonth.getDay(); // 0 = Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells: DayCell[] = [];

    // Leading blanks (previous month)
    for (let i = 0; i < startWeekday; i++) {
      const d = new Date(year, month, i - startWeekday + 1);
      cells.push({
        date: d,
        iso: toIso(d),
        cityIndex: null,
        city: null,
        isArrival: false,
        isDeparture: false,
        departureMode: null,
        departureTime: null,
        isInMonth: false,
      });
    }

    // Days of this month
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const iso = toIso(date);
      const match = dateToCity.get(iso);
      const cityIndex = match?.index ?? null;
      const city = match?.city ?? null;
      const isArrival = !!city && city.dates.arrival === iso;
      // Departure day shows the city's departure flight, not the city itself
      const departureCity = trip.cities.find((c) => c.dates.departure === iso);
      const isDeparture = !!departureCity;
      const departureMode = departureCity?.transportOut.mode ?? null;
      const departureTime = departureCity?.transportOut.departTime ?? null;

      cells.push({
        date,
        iso,
        cityIndex,
        city,
        isArrival,
        isDeparture,
        departureMode,
        departureTime,
        isInMonth: true,
      });
    }

    // Trailing blanks to fill grid
    while (cells.length % 7 !== 0) {
      const lastDate = cells[cells.length - 1].date;
      const next = new Date(lastDate);
      next.setDate(lastDate.getDate() + 1);
      cells.push({
        date: next,
        iso: toIso(next),
        cityIndex: null,
        city: null,
        isArrival: false,
        isDeparture: false,
        departureMode: null,
        departureTime: null,
        isInMonth: false,
      });
    }

    months.push({ year, month, cells });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const totalNights = daysBetween(start, end);

  return (
    <div className="px-8 py-6">
      {/* Month grids */}
      <div className="flex flex-col gap-8">
        {months.map(({ year, month, cells }, mi) => {
          const monthName = new Date(year, month, 1).toLocaleDateString('en-US', {
            month: 'long',
            year: 'numeric',
          });

          return (
            <motion.div
              key={`${year}-${month}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: mi * 0.08 }}
            >
              {/* Month header with inline city legend */}
              <div className="flex items-center gap-4 flex-wrap mb-4">
                <h3 className="text-gray-800 text-lg font-semibold">{monthName}</h3>
                <div className="flex flex-wrap gap-2">
                  {trip.cities.map((city, i) => {
                    const cColor = getCityColor(city.colorIndex ?? i);
                    const arr = parseLocal(city.dates.arrival);
                    const dep = parseLocal(city.dates.departure);
                    const nights = daysBetween(arr, dep);
                    return (
                      <button
                        key={i}
                        onClick={() => onCityClick?.(i)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border transition-all hover:scale-[1.04]"
                        style={{
                          background: cColor.bg,
                          borderColor: cColor.border,
                        }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: cColor.text }}
                        />
                        <span className="text-gray-900 text-[11px] font-medium">
                          {city.name}
                        </span>
                        <span className="text-gray-400 text-[10px]">
                          {nights} {nights === 1 ? 'night' : 'nights'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Weekday header */}
              <div className="grid grid-cols-7 gap-2 mb-2">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                  <div
                    key={d}
                    className="text-center text-gray-400 text-[10px] uppercase tracking-wider py-1"
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Day cells */}
              <div className="grid grid-cols-7 gap-2">
                {cells.map((cell, ci) => {
                  if (!cell.isInMonth) {
                    return <div key={ci} className="h-[88px]" />;
                  }

                  const theme = cell.city && cell.cityIndex != null
                    ? getCityColor(cell.city.colorIndex ?? cell.cityIndex)
                    : null;

                  return (
                    <motion.button
                      key={ci}
                      onClick={() => {
                        if (cell.city || cell.isDeparture) setSelectedDay(cell);
                      }}
                      whileHover={cell.city || cell.isDeparture ? { scale: 1.04 } : undefined}
                      className="relative h-[88px] rounded-xl border overflow-hidden text-left p-2 transition-colors"
                      style={{
                        background: theme
                          ? theme.bg
                          : 'rgba(0,0,0,0.02)',
                        borderColor: theme
                          ? theme.border
                          : 'rgba(0,0,0,0.05)',
                        cursor: cell.city || cell.isDeparture ? 'pointer' : 'default',
                      }}
                    >
                      {/* Top accent strip on city days */}
                      {theme && (
                        <div
                          className="absolute top-0 left-0 right-0 h-[2px]"
                          style={{
                            background: theme.text,
                            opacity: 0.6,
                          }}
                        />
                      )}

                      {/* Day number */}
                      <div className="flex items-start justify-between">
                        <span
                          className="text-[13px] font-semibold"
                          style={{
                            color: theme ? theme.text : '#d1d5db',
                          }}
                        >
                          {cell.date.getDate()}
                        </span>
                        {cell.isDeparture && (
                          cell.departureMode === 'train' ? (
                            <TrainFront size={10} className="text-gray-400" />
                          ) : (
                            <Plane
                              size={10}
                              className="text-gray-400"
                              style={{ transform: 'rotate(45deg)' }}
                            />
                          )
                        )}
                      </div>

                      {/* City name */}
                      {cell.city && (
                        <div className="mt-1">
                          <div className="text-gray-900 text-[11px] font-medium leading-tight truncate">
                            {cell.city.name}
                          </div>
                          {cell.isArrival ? (
                            <div className="flex items-center gap-1 mt-0.5">
                              {cell.city.transportIn.mode === 'flight' ? (
                                <Plane size={8} className="text-gray-400" />
                              ) : (
                                <TrainFront size={8} className="text-gray-400" />
                              )}
                              <span className="text-gray-400 text-[9px] font-mono">
                                {cell.city.transportIn.departTime && cell.city.transportIn.arriveTime
                                  ? `${cell.city.transportIn.departTime}→${cell.city.transportIn.arriveTime}`
                                  : cell.city.transportIn.arriveTime || 'arrive'}
                              </span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 mt-0.5">
                              <Moon size={8} className="text-gray-300" />
                              <span className="text-gray-400 text-[9px]">night</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Departure-only cell — last city's outbound flight (e.g. flying home).
                          City is null because the dep date isn't mapped to any in-trip city. */}
                      {!cell.city && cell.isDeparture && cell.departureTime && (
                        <div className="mt-1 flex items-center gap-1">
                          {cell.departureMode === 'train' ? (
                            <TrainFront size={8} className="text-gray-400" />
                          ) : (
                            <Plane size={8} className="text-gray-400" style={{ transform: 'rotate(45deg)' }} />
                          )}
                          <span className="text-gray-400 text-[9px] font-mono">
                            {cell.departureTime}
                          </span>
                        </div>
                      )}
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Footer summary */}
      <div className="mt-8 text-gray-400 text-[12px] text-center">
        {totalNights} nights · {trip.cities.length} cities · click a day to see its itinerary
      </div>

      {/* Day planner — Google Calendar style. The fly-home day has no city
          mapping (cell.city is null) but is still clickable; resolve it to
          the departing city so the planner can show the head-to-airport flow. */}
      <AnimatePresence>
        {(() => {
          if (!selectedDay) return null;
          let plannerCity = selectedDay.city;
          let plannerCityIndex = selectedDay.cityIndex;
          if ((!plannerCity || plannerCityIndex == null) && selectedDay.isDeparture) {
            const dep = trip.cities.find((c) => c.dates.departure === selectedDay.iso);
            if (dep) {
              plannerCity = dep;
              plannerCityIndex = trip.cities.indexOf(dep);
            }
          }
          if (!plannerCity || plannerCityIndex == null) return null;
          return (
            <DayPlanner
              trip={trip}
              date={selectedDay.iso}
              city={plannerCity}
              cityIndex={plannerCityIndex}
              onClose={() => setSelectedDay(null)}
            />
          );
        })()}
      </AnimatePresence>
    </div>
  );
}

