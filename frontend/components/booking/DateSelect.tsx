'use client';

import { useEffect, useState } from 'react';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const daysIn = (year: number | null, month: number | null) =>
  month ? new Date(year ?? 2000, month, 0).getDate() : 31; // 2000 is a leap year: Feb 29 allowed until a year is picked

type Parts = { y: number | null; m: number | null; d: number | null };

const parse = (iso: string): Parts => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : { y: null, m: null, d: null };
};

/**
 * Month / Day / Year dropdowns instead of a native date picker, which makes
 * you page back month by month to reach a birth year. Each select also takes
 * typing ("1995" jumps to 1995). Emits "YYYY-MM-DD" once all three are set,
 * '' until then.
 */
export default function DateSelect({
  id,
  value,
  onChange,
  fromYear,
  toYear,
  className,
  style,
  label,
}: {
  id: string;
  value: string;
  onChange: (iso: string) => void;
  /** Year list runs from `fromYear` to `toYear`, either direction (DOB counts down). */
  fromYear: number;
  toYear: number;
  className: string;
  style?: React.CSSProperties;
  /** Names the three selects for screen readers: "Date of birth month", …. */
  label: string;
}) {
  const [parts, setParts] = useState<Parts>(() => parse(value));

  // Follow an outside reset (e.g. the form cleared), not our own emissions.
  useEffect(() => {
    const p = parse(value);
    if (p.y !== null) setParts(p);
    else if (value === '') setParts((cur) => (cur.y && cur.m && cur.d ? { y: null, m: null, d: null } : cur));
  }, [value]);

  const update = (patch: Partial<Parts>) => {
    const next = { ...parts, ...patch };
    if (next.d && next.d > daysIn(next.y, next.m)) next.d = null; // Feb 30 → pick again
    setParts(next);
    onChange(
      next.y && next.m && next.d
        ? `${next.y}-${String(next.m).padStart(2, '0')}-${String(next.d).padStart(2, '0')}`
        : '',
    );
  };

  const step = fromYear <= toYear ? 1 : -1;
  const years: number[] = [];
  for (let y = fromYear; step > 0 ? y <= toYear : y >= toYear; y += step) years.push(y);

  return (
    <div className="grid grid-cols-[1.5fr_0.9fr_1.1fr] gap-1.5">
      <select
        id={id}
        aria-label={`${label} month`}
        className={className}
        style={style}
        value={parts.m ?? ''}
        onChange={(e) => update({ m: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">Month</option>
        {MONTHS.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </select>
      <select
        id={`${id}-day`}
        aria-label={`${label} day`}
        className={className}
        style={style}
        value={parts.d ?? ''}
        onChange={(e) => update({ d: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">Day</option>
        {Array.from({ length: daysIn(parts.y, parts.m) }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <select
        id={`${id}-year`}
        aria-label={`${label} year`}
        className={className}
        style={style}
        value={parts.y ?? ''}
        onChange={(e) => update({ y: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">Year</option>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}
