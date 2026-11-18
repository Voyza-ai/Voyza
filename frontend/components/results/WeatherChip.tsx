'use client';

import type { DayWeather } from '@/lib/api';
import { weatherEmoji, weatherTemps, weatherTitle } from '@/lib/tripWeather';

/**
 * A day's weather on the Calendar and Schedule: emoji and high/low. A typical
 * day (past years' average, not a forecast) is marked "avg"; as a pill (the
 * Schedule) it also has a dashed outline where a forecast has a solid one.
 * The hover text says which and from where.
 */
export default function WeatherChip({
  day,
  fahrenheit,
  typicalYears,
  accent,
  variant = 'pill',
}: {
  day: DayWeather;
  fahrenheit: boolean;
  typicalYears?: string | null;
  /** The city's text colour, as the rest of the card uses. */
  accent: string;
  /** pill: outlined, beside a heading. inline: plain text on its own line (a calendar cell). */
  variant?: 'pill' | 'inline';
}) {
  const typical = day.kind === 'typical';
  const title = weatherTitle(day, fahrenheit, typicalYears);
  const pill = variant === 'pill';
  return (
    <span
      data-testid="weather-chip"
      data-kind={day.kind}
      title={title}
      aria-label={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap font-medium leading-none ${
        pill ? 'rounded-full px-1.5 py-[3px] text-[11px]' : 'text-[10.5px]'
      }`}
      style={{
        color: accent,
        ...(pill ? { background: '#ffffffb0', border: `1px ${typical ? 'dashed' : 'solid'} ${accent}${typical ? '88' : '40'}` } : {}),
      }}
    >
      <span aria-hidden className="text-[13px]">
        {weatherEmoji(day)}
      </span>
      <span>{weatherTemps(day, fahrenheit)}</span>
      {typical && <span style={{ opacity: 0.7 }}>avg</span>}
    </span>
  );
}
