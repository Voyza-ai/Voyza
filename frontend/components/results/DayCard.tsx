'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { MapPin, Utensils, Plane, TrainFront, Clock } from 'lucide-react';
import { City, ScheduledEvent, TransportMode } from '@/lib/types';
import { getCityColor } from '@/lib/cityColors';
import { parseLocal } from '@/lib/dateHelpers';

/**
 * Read-only single-day column rendered side-by-side with peers in
 * `ScheduleView`. Each card mirrors the `DayPlanner` modal's vertical
 * time grid but stays read-only — drag/resize/add lives in the modal.
 *
 * Sizing model: the card stretches to fill whatever height its parent
 * gives it (`h-full flex flex-col`). The parent rail in `ScheduleView`
 * is itself `flex-1` of a viewport-tall column, so each card's outer
 * size always matches the visible window — top and bottom are visible
 * without page scroll.
 *
 * Inside the card, the body is `overflow-y: auto` over a full 0–24h
 * grid. Default scroll position is one hour before the day's earliest
 * event so pre-dawn travel events land in view automatically.
 *
 * Click model is a single step: clicking anywhere on the card (or on
 * any event block) fires `onOpenEditor` and the parent opens the
 * `DayPlanner` modal.
 */
type DayCardProps = {
  date: string; // ISO YYYY-MM-DD
  city: City | null;
  cityIndex: number | null;
  events: ScheduledEvent[];
  /**
   * Transport mode for the day's primary travel event, when the user
   * is on the move on this date. Drives the small flight/train icon in
   * the header. Null on stationary days.
   */
  travelMode?: TransportMode | null;
  onOpenEditor: () => void;
};

const HOUR_HEIGHT = 48; // px per hour row
const TOTAL_HOURS = 24;
const DEFAULT_SCROLL_HOUR = 7;

const timeToMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

const formatHour = (hour: number) => {
  if (hour === 0 || hour === 24) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
};

const CATEGORY_ICONS: Record<string, typeof MapPin> = {
  activity: MapPin,
  restaurant: Utensils,
  transport: Plane,
  free: Clock,
  custom: Clock,
};

const formatHeader = (iso: string) => {
  const d = parseLocal(iso);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  const day = d.getDate();
  return { weekday, label: `${month} ${day}` };
};

export default function DayCard({
  date,
  city,
  cityIndex,
  events,
  travelMode = null,
  onOpenEditor,
}: DayCardProps) {
  const theme =
    city && cityIndex != null ? getCityColor(city.colorIndex ?? cityIndex) : null;
  const accent = theme?.text ?? '#9ca3af';
  const bg = theme?.bg ?? '#f9fafb';
  const border = theme?.border ?? '#e5e7eb';

  // Pre-position the body scroll on mount so the day's events are visible
  // without manual scrolling. Strategy: scroll to one hour before the
  // earliest event of the day (so it isn't flush against the top edge),
  // capped between midnight and the 7 AM "typical morning" default.
  // Without this, an early-AM "Head to airport" block on a 6 AM flight
  // sits above the default 7 AM window and the user thinks the schedule
  // is blank.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const earliestMins = events.length > 0
      ? Math.min(...events.map((e) => timeToMinutes(e.startTime)))
      : DEFAULT_SCROLL_HOUR * 60;
    const targetMins = Math.max(0, Math.min(DEFAULT_SCROLL_HOUR * 60, earliestMins - 60));
    el.scrollTop = (targetMins / 60) * HOUR_HEIGHT;
  }, [date, events]);

  const { weekday, label } = formatHeader(date);

  return (
    <motion.div
      onClick={onOpenEditor}
      whileHover={{ scale: 1.005, boxShadow: `0 6px 18px ${accent}1c` }}
      transition={{ type: 'spring', stiffness: 320, damping: 24 }}
      className="flex-shrink-0 h-full w-[340px] rounded-2xl border-2 overflow-hidden cursor-pointer flex flex-col"
      style={{
        background: bg,
        borderColor: border,
        scrollSnapAlign: 'start',
      }}
    >
      {/* Top accent strip */}
      <div className="h-[3px] w-full flex-shrink-0" style={{ background: accent, opacity: 0.7 }} />

      {/* Header — pinned at the top of the card */}
      <div
        className="px-4 pt-3 pb-2.5 flex items-baseline justify-between gap-3 flex-shrink-0"
        style={{ borderBottom: `1px solid ${border}` }}
      >
        <div className="min-w-0">
          <div
            className="text-[10px] uppercase tracking-[0.18em] font-semibold"
            style={{ color: `${accent}aa` }}
          >
            {weekday}
          </div>
          <div className="text-[18px] font-semibold leading-tight" style={{ color: accent }}>
            {label}
          </div>
        </div>
        <div className="text-right min-w-0">
          <div
            className="flex items-center justify-end gap-1.5 text-[12px] font-medium truncate"
            style={{ color: city ? accent : '#9ca3af' }}
          >
            {/* Travel-day icon. Plane for flights, TrainFront for rail.
                Only rendered when the user is actually moving on this
                date; stationary days stay icon-free. */}
            {travelMode === 'flight' && (
              <Plane size={11} style={{ color: accent }} aria-label="Flight day" />
            )}
            {travelMode === 'train' && (
              <TrainFront size={11} style={{ color: accent }} aria-label="Train day" />
            )}
            <span className="truncate">{city?.name ?? 'Travel day'}</span>
          </div>
          <div className="text-[10px]" style={{ color: `${accent}80` }}>
            {events.length} {events.length === 1 ? 'event' : 'events'}
          </div>
        </div>
      </div>

      {/* Body — flex-1 fills whatever vertical space remains in the
          card, and overflow-y:auto turns the inner full-day grid into
          a scrollable region. The user mouse-wheels inside this body
          to walk through earlier/later hours of the same day. */}
      <div ref={bodyRef} className="relative flex-1 overflow-y-auto no-scrollbar">
        <div className="relative ml-12 mr-2" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
          {/* Hour rules + labels — one per hour, 0..24 inclusive so the
              final boundary line draws at midnight. */}
          {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => (
            <div
              key={i}
              className="absolute left-0 right-0"
              style={{ top: i * HOUR_HEIGHT }}
            >
              <div
                className="absolute right-full pr-2 text-[9px] font-medium -translate-y-1/2 select-none whitespace-nowrap"
                style={{ color: `${accent}70` }}
              >
                {formatHour(i)}
              </div>
              <div className="w-full h-px" style={{ background: `${accent}15` }} />
            </div>
          ))}

          {/* Event blocks. Read-only — no resize handles, no trash. The
              click bubbles up to the card-level onClick so we don't
              need a separate handler here. */}
          {events.map((evt) => {
            const startMins = timeToMinutes(evt.startTime);
            const endMins = timeToMinutes(evt.endTime);
            const top = (startMins / 60) * HOUR_HEIGHT;
            const height = Math.max(((endMins - startMins) / 60) * HOUR_HEIGHT, 18);
            const CatIcon = CATEGORY_ICONS[evt.category ?? 'custom'] ?? Clock;
            return (
              <div
                key={evt.id}
                className="absolute left-1 right-1 rounded-lg border-l-[3px] px-2 py-1 transition-shadow hover:shadow-sm"
                style={{
                  top,
                  height,
                  background: `${accent}20`,
                  borderLeftColor: accent,
                }}
              >
                <div className="flex items-center gap-1">
                  <CatIcon size={9} style={{ color: accent }} />
                  <span
                    className="text-[11px] font-medium truncate leading-tight"
                    style={{ color: accent }}
                  >
                    {evt.title}
                  </span>
                </div>
                {height > 30 && (
                  <div className="text-[9px] mt-0.5 truncate" style={{ color: `${accent}80` }}>
                    {evt.startTime} – {evt.endTime}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer hint — pinned at the bottom of the card */}
      <div
        className="text-center text-[10px] uppercase tracking-wider py-1.5 flex-shrink-0"
        style={{ color: `${accent}99`, borderTop: `1px solid ${border}` }}
      >
        Click to edit
      </div>
    </motion.div>
  );
}
