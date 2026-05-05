'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Plus,
  Clock,
  MapPin,
  Utensils,
  Plane,
  TrainFront,
  GripVertical,
  Trash2,
  Check,
} from 'lucide-react';
import { Trip, City, ScheduledEvent } from '@/lib/types';
import { getCityColor } from '@/lib/cityColors';
import { buildDefaultSchedule } from '@/lib/dayScheduleDefaults';
import { useTripStore } from '@/store/tripStore';

type DayPlannerProps = {
  trip: Trip;
  /** ISO date string for the day to display */
  date: string;
  /** The city this day belongs to */
  city: City;
  cityIndex: number;
  onClose: () => void;
};

/* ---- Constants ---- */
const HOUR_HEIGHT = 64; // px per hour row
const END_HOUR = 24; // midnight (full-day grid runs 00:00–24:00)

const timeToMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

const minutesToTime = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const minutesToLabel = (mins: number) => {
  const h = mins / 60;
  const hour = Math.floor(h);
  const minute = Math.round((h - hour) * 60);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return minute === 0
    ? `${display} ${ampm}`
    : `${display}:${String(minute).padStart(2, '0')} ${ampm}`;
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

let _idCounter = 0;
const newId = () => `evt-${Date.now()}-${++_idCounter}`;

export default function DayPlanner({
  trip,
  date,
  city,
  cityIndex,
  onClose,
}: DayPlannerProps) {
  const color = getCityColor(city.colorIndex ?? cityIndex);
  const accent = color.text;

  const addScheduledEvent = useTripStore((s) => s.addScheduledEvent);
  const updateScheduledEvent = useTripStore((s) => s.updateScheduledEvent);
  const removeScheduledEvent = useTripStore((s) => s.removeScheduledEvent);
  const setDaySchedule = useTripStore((s) => s.setDaySchedule);

  // Initialize schedule for this day if it doesn't exist
  const existingSchedule = city.schedule?.[date];
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!initialized && !existingSchedule) {
      const defaults = buildDefaultSchedule(city, date, trip, cityIndex);
      setDaySchedule(cityIndex, date, defaults);
      setInitialized(true);
    } else {
      setInitialized(true);
    }
  }, [initialized, existingSchedule, city, date, trip, cityIndex, setDaySchedule]);

  const events = city.schedule?.[date] ?? [];

  // Render the full day, midnight to midnight. Lets the user scroll up to
  // any pre-dawn hour to add an event there, and ensures very early travel
  // events (e.g. a 4 AM "head to airport") are never clipped.
  const startHour = 0;
  const totalHours = END_HOUR - startHour;

  // Add new event state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addStartTime, setAddStartTime] = useState('09:00');
  const [addEndTime, setAddEndTime] = useState('10:00');
  const [addTitle, setAddTitle] = useState('');
  const [addCategory, setAddCategory] = useState<ScheduledEvent['category']>('custom');

  // Drag resize state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragEdge, setDragEdge] = useState<'top' | 'bottom' | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const dayLabel = new Date(
    ...date.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))) as [number, number, number]
  ).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const handleClickSlot = (hour: number) => {
    setAddStartTime(minutesToTime(hour * 60));
    setAddEndTime(minutesToTime((hour + 1) * 60));
    setAddTitle('');
    setAddCategory('custom');
    setShowAddForm(true);
  };

  const handleAddEvent = () => {
    const t = addTitle.trim();
    if (!t) return;
    addScheduledEvent(cityIndex, date, {
      id: newId(),
      title: t,
      startTime: addStartTime,
      endTime: addEndTime,
      category: addCategory,
    });
    setShowAddForm(false);
    setAddTitle('');
  };

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draggingId || !dragEdge || !gridRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      const totalMinutes = (relY / (totalHours * HOUR_HEIGHT)) * totalHours * 60;
      const snapped = Math.round((totalMinutes + startHour * 60) / 15) * 15;
      const clamped = Math.max(startHour * 60, Math.min(END_HOUR * 60, snapped));
      const timeStr = minutesToTime(clamped);

      const evt = events.find((ev) => ev.id === draggingId);
      if (!evt) return;

      if (dragEdge === 'top') {
        if (timeToMinutes(timeStr) < timeToMinutes(evt.endTime) - 15) {
          updateScheduledEvent(cityIndex, date, draggingId, { startTime: timeStr });
        }
      } else {
        if (timeToMinutes(timeStr) > timeToMinutes(evt.startTime) + 15) {
          updateScheduledEvent(cityIndex, date, draggingId, { endTime: timeStr });
        }
      }
    },
    [draggingId, dragEdge, events, cityIndex, date, updateScheduledEvent, startHour, totalHours]
  );

  const handleMouseUp = useCallback(() => {
    setDraggingId(null);
    setDragEdge(null);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-4xl max-h-[92vh] flex flex-col rounded-2xl border-2 shadow-2xl overflow-hidden"
        style={{ background: color.bg, borderColor: color.border }}
      >
        {/* Top accent */}
        <div className="h-[4px] w-full" style={{ background: accent }} />

        {/* Header */}
        <div
          className="px-6 pt-5 pb-4 flex items-start justify-between gap-4 flex-shrink-0"
          style={{ borderBottom: `3px solid ${color.border}` }}
        >
          <div>
            <div
              className="text-[11px] uppercase tracking-[0.18em] font-semibold mb-1"
              style={{ color: `${accent}aa` }}
            >
              Day Planner · {city.name}
            </div>
            <h2 className="text-2xl font-semibold" style={{ color: accent }}>
              {dayLabel}
            </h2>
            <div className="text-[12px] mt-1" style={{ color: `${accent}70` }}>
              {events.length} {events.length === 1 ? 'event' : 'events'} scheduled
              {' '}· click an empty slot to add
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setShowAddForm(true);
                setAddStartTime('09:00');
                setAddEndTime('10:00');
                setAddTitle('');
              }}
              className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-2 rounded-xl transition-all"
              style={{ background: accent, color: color.bg }}
            >
              <Plus size={14} />
              Add event
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-full border flex items-center justify-center transition-all"
              style={{ borderColor: color.border, color: accent, background: `${accent}0c` }}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Scrollable time grid */}
        <div
          className="flex-1 min-h-0 overflow-y-auto"
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <div
            ref={gridRef}
            className="relative ml-16"
            style={{ height: totalHours * HOUR_HEIGHT }}
          >
            {/* Hour lines + labels */}
            {Array.from({ length: totalHours + 1 }, (_, i) => {
              const hour = startHour + i;
              return (
                <div key={hour} className="absolute left-0 right-0" style={{ top: i * HOUR_HEIGHT }}>
                  <div
                    className="absolute right-full pr-3 text-[11px] font-medium -translate-y-1/2 select-none whitespace-nowrap"
                    style={{ color: `${accent}70` }}
                  >
                    {formatHour(hour)}
                  </div>
                  <div
                    className="w-full h-px"
                    style={{ background: `${accent}15` }}
                  />
                </div>
              );
            })}

            {/* Clickable hour slots */}
            {Array.from({ length: totalHours }, (_, i) => {
              const hour = startHour + i;
              return (
                <div
                  key={`slot-${hour}`}
                  className="absolute left-0 right-4 cursor-pointer hover:bg-opacity-100 transition-colors rounded-lg"
                  style={{
                    top: i * HOUR_HEIGHT + 1,
                    height: HOUR_HEIGHT - 1,
                  }}
                  onClick={() => handleClickSlot(hour)}
                />
              );
            })}

            {/* Event blocks */}
            {events.map((evt) => {
              const startMins = timeToMinutes(evt.startTime) - startHour * 60;
              const endMins = timeToMinutes(evt.endTime) - startHour * 60;
              const top = (startMins / 60) * HOUR_HEIGHT;
              const height = Math.max(((endMins - startMins) / 60) * HOUR_HEIGHT, 24);

              const catColors: Record<string, { bg: string; border: string }> = {
                activity: { bg: `${accent}20`, border: accent },
                restaurant: { bg: `${accent}15`, border: `${accent}88` },
                transport: { bg: `${accent}30`, border: accent },
                free: { bg: `${accent}08`, border: `${accent}40` },
                custom: { bg: `${accent}18`, border: `${accent}70` },
              };
              const cat = catColors[evt.category ?? 'custom'] ?? catColors.custom;
              const CatIcon = CATEGORY_ICONS[evt.category ?? 'custom'] ?? Clock;

              return (
                <div
                  key={evt.id}
                  className="absolute left-1 right-5 rounded-xl border-l-[3px] px-3 py-1.5 cursor-default group transition-shadow hover:shadow-md"
                  style={{
                    top,
                    height,
                    background: cat.bg,
                    borderLeftColor: cat.border,
                    zIndex: draggingId === evt.id ? 20 : 10,
                  }}
                >
                  {/* Top resize handle */}
                  <div
                    className="absolute top-0 left-0 right-0 h-2 cursor-n-resize"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setDraggingId(evt.id);
                      setDragEdge('top');
                    }}
                  />

                  <div className="flex items-start justify-between gap-2 h-full">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <CatIcon size={11} style={{ color: accent }} />
                        <span
                          className="text-[13px] font-medium truncate leading-tight"
                          style={{ color: accent }}
                        >
                          {evt.title}
                        </span>
                      </div>
                      {height > 36 && (
                        <div className="text-[11px] mt-0.5" style={{ color: `${accent}80` }}>
                          {minutesToLabel(timeToMinutes(evt.startTime))} – {minutesToLabel(timeToMinutes(evt.endTime))}
                        </div>
                      )}
                      {height > 56 && evt.notes && (
                        <div className="text-[10px] mt-0.5 truncate" style={{ color: `${accent}60` }}>
                          {evt.notes}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeScheduledEvent(cityIndex, date, evt.id);
                      }}
                      className="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      style={{ color: `${accent}70` }}
                      title="Remove"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>

                  {/* Bottom resize handle */}
                  <div
                    className="absolute bottom-0 left-0 right-0 h-2 cursor-s-resize"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setDraggingId(evt.id);
                      setDragEdge('bottom');
                    }}
                  />
                </div>
              );
            })}

            {/* Current time indicator (if today) */}
            <CurrentTimeIndicator accent={accent} startHour={startHour} />
          </div>
        </div>

        {/* Add event modal */}
        <AnimatePresence>
          {showAddForm && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[400px] rounded-2xl border-2 shadow-2xl p-5 z-30"
              style={{ background: color.bg, borderColor: color.border }}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-[12px] uppercase tracking-wider font-semibold" style={{ color: accent }}>
                  New event
                </span>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="w-6 h-6 flex items-center justify-center"
                  style={{ color: `${accent}60` }}
                >
                  <X size={14} />
                </button>
              </div>

              <input
                autoFocus
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddEvent();
                  if (e.key === 'Escape') setShowAddForm(false);
                }}
                placeholder="Event name"
                className="w-full text-[15px] bg-transparent focus:outline-none mb-3 pb-2"
                style={{ color: accent, borderBottom: `2px solid ${color.border}` }}
              />

              <div className="flex items-center gap-3 mb-3">
                <div className="flex items-center gap-1.5">
                  <Clock size={12} style={{ color: `${accent}80` }} />
                  <input
                    type="time"
                    value={addStartTime}
                    onChange={(e) => setAddStartTime(e.target.value)}
                    className="text-[13px] bg-transparent focus:outline-none"
                    style={{ color: accent }}
                  />
                </div>
                <span style={{ color: `${accent}50` }}>–</span>
                <input
                  type="time"
                  value={addEndTime}
                  onChange={(e) => setAddEndTime(e.target.value)}
                  className="text-[13px] bg-transparent focus:outline-none"
                  style={{ color: accent }}
                />
              </div>

              <div className="flex items-center gap-1.5 mb-4">
                {(['activity', 'restaurant', 'custom'] as const).map((cat) => {
                  const labels: Record<string, string> = {
                    activity: 'Activity',
                    restaurant: 'Dining',
                    custom: 'Other',
                  };
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setAddCategory(cat)}
                      className="text-[11px] px-2.5 py-1 rounded-lg transition-all"
                      style={{
                        background: addCategory === cat ? accent : `${accent}10`,
                        color: addCategory === cat ? color.bg : `${accent}80`,
                      }}
                    >
                      {labels[cat]}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={handleAddEvent}
                disabled={!addTitle.trim()}
                className="w-full flex items-center justify-center gap-2 text-[13px] font-medium px-4 py-2.5 rounded-xl transition-all disabled:opacity-30"
                style={{ background: accent, color: color.bg }}
              >
                <Check size={14} />
                Add to schedule
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

/* ---- Current time red line (shows only if the date is today) ---- */
function CurrentTimeIndicator({ accent, startHour }: { accent: string; startHour: number }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < startHour * 60 || mins > END_HOUR * 60) return null;

  const offset = ((mins - startHour * 60) / 60) * HOUR_HEIGHT;
  return (
    <div className="absolute left-0 right-0 z-30 pointer-events-none" style={{ top: offset }}>
      <div className="flex items-center">
        <div
          className="w-2 h-2 rounded-full -ml-1"
          style={{ background: '#ef4444' }}
        />
        <div className="flex-1 h-[2px]" style={{ background: '#ef4444' }} />
      </div>
    </div>
  );
}
