'use client';

import { useState } from 'react';
import { MapPin } from 'lucide-react';

import type { Trip } from '@/lib/types';

/**
 * "Flying from Portland, Oregon — did you mean Portland, Maine?"
 *
 * Someone typing an ambiguous origin gets their trip priced from the most
 * likely reading, because an optimize run is already spending money on Duffel
 * by the time the origin matters and cannot stop to ask. That is the right
 * trade, but it leaves a trip whose every flight and every price is for a city
 * the traveller may not have meant, with nothing on screen saying a choice was
 * made — the home card just reads "Portland · PDX", which looks correct unless
 * you happen to know PDX is Oregon. This is that line.
 *
 * It SHOWS, it does not block: the trip is already priced and visible, and
 * this sits underneath it. Picking another reading re-prices rather than
 * warning.
 *
 * Rare by construction — the resolver sets `originClarification` only when a
 * name genuinely has more than one real reading, which is a few hundred of
 * 36,009 places. `Portland`, `Springfield`, `Melbourne` and `Venice` are the
 * shape of it.
 *
 * Styled as a sibling of BudgetOverBanner and VibeTierUpBanner, which share
 * this slot: a 10% accent wash, a 30% accent border, a round icon chip at 18%,
 * and body copy in grey rather than the accent. The accent is --accent /
 * --flight (#2e6bc4) — already this app's flight colour, and deliberately not
 * the banners' amber, because amber here means something is wrong and this is
 * just a fact about what was priced.
 */

/** --accent in globals.css, which is also --flight. */
const ACCENT = '46,107,196';
const ACCENT_HEX = '#2e6bc4';

export type OriginChoice = {
  placeId: string;
  label: string;
  airports: string[];
};

export default function OriginClarification({
  clarification,
  pricedFrom,
  onChoose,
}: {
  clarification: NonNullable<Trip['originClarification']>;
  /** The airports the trip was actually priced from. */
  pricedFrom: string[];
  /**
   * Called when the traveller picks a different reading. Absent while the
   * re-pricing path does not exist yet, in which case the alternatives are
   * shown but not clickable — see the note in the results page.
   */
  onChoose?: (choice: OriginChoice) => void;
}) {
  const [open, setOpen] = useState(false);

  const [chosen, ...alternatives] = clarification.candidates;
  if (!chosen || alternatives.length === 0) return null;

  // What the trip was priced from, preferring the airports the optimizer
  // actually used over the candidate's own list — they can differ if the
  // caller passed its own.
  const lead = pricedFrom[0] ?? chosen.airports[0] ?? '';

  return (
    <div className="mx-8 mt-4 mb-1">
      <div
        className="flex items-start gap-3 px-4 py-3 rounded-xl border"
        style={{
          background: `linear-gradient(90deg, rgba(${ACCENT},0.10) 0%, rgba(${ACCENT},0.04) 100%)`,
          borderColor: `rgba(${ACCENT},0.30)`,
        }}
      >
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
          style={{ background: `rgba(${ACCENT},0.18)` }}
        >
          <MapPin size={14} style={{ color: ACCENT_HEX }} />
        </div>

        <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
          <span className="text-gray-700">
            Flying from <strong className="text-gray-900">{chosen.label}</strong>
          </span>
          {lead && (
            <span className="text-gray-400 font-mono text-[11px] tracking-wider"> ({lead})</span>
          )}

          <div className="text-gray-500 mt-1">
            {/* The traveller's own words, so it is obvious why we had to pick. */}
            You typed &ldquo;{clarification.input}&rdquo;, which matches{' '}
            {clarification.candidates.length} places.{' '}
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="underline underline-offset-2 font-medium"
              style={{ color: ACCENT_HEX }}
            >
              {open ? 'Hide' : alternatives.length === 1 ? 'See the other' : 'See the others'}
            </button>
          </div>

          {open && (
            /* Across the row, not stacked. This banner is the full width of
               the cards area and the alternatives are one line each, so
               stacking them left most of that width empty. `flex-1` with a
               floor shares the row between however many there are, and wraps
               once they stop fitting. */
            <ul className="mt-2.5 flex flex-wrap gap-2">
              {alternatives.map((candidate) => (
                /* The cap only bites when there is a single alternative,
                   which would otherwise stretch one short row across the
                   whole banner. Two or more never reach it. */
                <li key={candidate.placeId} className="flex-1 min-w-[220px] max-w-[520px]">
                  <button
                    type="button"
                    disabled={!onChoose}
                    onClick={() =>
                      onChoose?.({
                        placeId: candidate.placeId,
                        label: candidate.label,
                        airports: candidate.airports,
                      })
                    }
                    className="w-full h-full text-left rounded-lg px-3 py-2 border bg-white transition-colors enabled:hover:border-gray-300 disabled:cursor-default"
                    style={{ borderColor: '#e5e7eb' }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[12px] font-medium text-gray-900 truncate">
                        {candidate.label}
                      </span>
                      <span className="flex items-baseline gap-2 flex-shrink-0 text-[10px]">
                        <span className="font-mono uppercase tracking-wider text-gray-500">
                          {candidate.airports.slice(0, 3).join(' · ')}
                        </span>
                        {candidate.distanceKm !== undefined && (
                          <span className="text-gray-400">
                            {candidate.distanceKm.toLocaleString()} km away
                          </span>
                        )}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
