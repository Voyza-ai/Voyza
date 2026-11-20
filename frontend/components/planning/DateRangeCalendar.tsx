'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { humanDayRange } from '@/lib/dateHelpers';

/**
 * The chat planner's answer to "When are you thinking of going?": two months
 * side by side, first day then last day. Past days can't be picked.
 */
type Props = {
  onSelect: (start: string, end: string) => void;
  onFlexible: () => void;
  /** Today, as YYYY-MM-DD — for tests; defaults to the local date. */
  today?: string;
};

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS_AHEAD = 18;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const localToday = () => {
  const t = new Date();
  return iso(t.getFullYear(), t.getMonth(), t.getDate());
};
const nightsBetween = (a: string, b: string) =>
  Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);

function monthCells(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  return [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => iso(year, month, i + 1))];
}

export default function DateRangeCalendar({ onSelect, onFlexible, today = localToday() }: Props) {
  const ty = +today.slice(0, 4);
  const tm = +today.slice(5, 7) - 1;
  // Months shown, counted from this month: the left one is `offset`.
  const [offset, setOffset] = useState(0);
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const months = useMemo(
    () =>
      [offset, offset + 1].map((o) => {
        const d = new Date(ty, tm + o, 1);
        return {
          year: d.getFullYear(),
          month: d.getMonth(),
          label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        };
      }),
    [offset, ty, tm],
  );

  const pick = (day: string) => {
    if (!start || end || day <= start) {
      setStart(day);
      setEnd(null);
      return;
    }
    setEnd(day);
  };

  // The range drawn: chosen, or previewed up to the hovered day.
  const rangeEnd = end ?? (start && hover && hover > start ? hover : null);
  const nights = start && end ? nightsBetween(start, end) : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      role="group"
      aria-label="Pick your travel dates"
      data-testid="date-range-calendar"
      className="w-full max-w-[640px] rounded-2xl border border-gray-200 bg-white p-4"
    >
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          aria-label="Previous month"
          disabled={offset === 0}
          onClick={() => setOffset((o) => Math.max(0, o - 1))}
          className="w-8 h-8 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="flex-1 grid grid-cols-2 gap-6 text-center text-[14px] font-semibold text-gray-900">
          {months.map((m) => (
            <span key={m.label}>{m.label}</span>
          ))}
        </div>
        <button
          type="button"
          aria-label="Next month"
          disabled={offset >= MONTHS_AHEAD}
          onClick={() => setOffset((o) => Math.min(MONTHS_AHEAD, o + 1))}
          className="w-8 h-8 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-6 px-1" onMouseLeave={() => setHover(null)}>
        {months.map((m) => (
          <div key={m.label}>
            <div className="grid grid-cols-7 mb-1">
              {WEEKDAYS.map((w) => (
                <span key={w} className="text-center text-[11px] text-gray-400 py-1">
                  {w}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-y-0.5">
              {monthCells(m.year, m.month).map((day, i) => {
                if (!day) return <span key={`b${i}`} />;
                const past = day < today;
                const isEnd = day === start || day === end;
                const inRange = !!start && !!rangeEnd && day > start && day < rangeEnd;
                // Half a band toward the range, but not past the row's edge:
                // a last day on a Sunday or a first day on a Saturday.
                const col = i % 7;
                const edgeOfRange =
                  !!start && !!rangeEnd && ((day === start && col !== 6) || (day === rangeEnd && col !== 0));
                return (
                  <div
                    key={day}
                    className="relative h-9 flex items-center justify-center"
                    style={{
                      background: inRange
                        ? '#eff6ff'
                        : edgeOfRange
                          ? `linear-gradient(to ${day === start ? 'right' : 'left'}, transparent 50%, #eff6ff 50%)`
                          : undefined,
                    }}
                  >
                    <button
                      type="button"
                      disabled={past}
                      aria-label={new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)).toLocaleDateString('en-US', {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                      aria-pressed={isEnd}
                      data-day={day}
                      onClick={() => pick(day)}
                      onMouseEnter={() => setHover(day)}
                      className={`relative w-9 h-9 rounded-full text-[13px] tabular-nums transition-colors ${
                        past
                          ? 'text-gray-300 cursor-default'
                          : isEnd || day === rangeEnd
                            ? 'text-white font-semibold'
                            : inRange
                              ? 'text-[#1d4ed8] hover:bg-[#dbeafe]'
                              : 'text-gray-800 hover:bg-gray-100'
                      } ${day === today && !isEnd ? 'font-semibold' : ''}`}
                      style={isEnd || (!past && day === rangeEnd) ? { background: '#2563eb' } : undefined}
                    >
                      {+day.slice(8, 10)}
                      {day === today && !isEnd && (
                        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#2563eb]" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between gap-3">
        <span className="text-[13px] text-gray-500" data-testid="date-range-summary">
          {start && end ? (
            <>
              <span className="text-gray-900 font-medium">{humanDayRange(start, end)}</span>
              {' · '}
              {nights} {nights === 1 ? 'night' : 'nights'}
            </>
          ) : start ? (
            'Now pick your last day'
          ) : (
            'Pick your first day'
          )}
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onFlexible}
            className="px-3 py-2 rounded-xl text-[13px] text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
          >
            I&apos;m flexible
          </button>
          <button
            type="button"
            disabled={!start || !end}
            onClick={() => start && end && onSelect(start, end)}
            className="px-4 py-2 rounded-xl text-[13px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            style={{ background: '#2563eb' }}
          >
            Use these dates
          </button>
        </div>
      </div>
    </motion.div>
  );
}
