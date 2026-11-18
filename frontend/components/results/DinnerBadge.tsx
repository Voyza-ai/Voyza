'use client';

import { ExternalLink } from 'lucide-react';
import type { DinnerPlan } from '@/lib/types';
import { nightLabel } from '@/lib/dinnerPlace';

/**
 * "Not booked yet" + Reserve, for a dinner plan wherever the trip shows it
 * (schedule day cards, the day planner, the calendar, the city guide). The
 * dashed outline is the product's own "not settled yet" line — the dashed
 * route — in the city's colour. The link opens the restaurant where the
 * traveller books it; nothing in BlueMurr books a table.
 */
export default function DinnerBadge({
  dinner,
  accent,
  size = 'sm',
  showReserve = true,
}: {
  dinner: DinnerPlan;
  accent: string;
  size?: 'xs' | 'sm';
  showReserve?: boolean;
}) {
  const text = size === 'xs' ? 'text-[9px]' : 'text-[10px]';
  return (
    <span className={`inline-flex items-center gap-1.5 flex-wrap ${text}`} data-testid="dinner-badge">
      <span
        className="font-medium px-1.5 py-[1px] rounded whitespace-nowrap"
        style={{ color: accent, border: `1px dashed ${accent}aa`, background: '#ffffffaa' }}
      >
        Not booked yet
      </span>
      {showReserve && (
        <a
          href={dinner.reserveUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-0.5 font-semibold whitespace-nowrap hover:underline"
          style={{ color: '#2e6bc4' }}
          title={`Opens ${dinner.restaurant} on ${dinner.reserveVia} — book the table there`}
          data-testid="dinner-badge-reserve"
        >
          Reserve <ExternalLink size={size === 'xs' ? 8 : 9} />
        </a>
      )}
      {dinner.movedFrom && (
        <span className="whitespace-nowrap" style={{ color: `${accent}99` }} data-testid="dinner-moved">
          moved from {nightLabel(dinner.movedFrom)} — your dates changed
        </span>
      )}
    </span>
  );
}
