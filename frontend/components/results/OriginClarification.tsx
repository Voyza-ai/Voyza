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
 * made. This is that line.
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
 * Palette is the home card's own (Flowchart.tsx `HOME_COLOR`), because this is
 * about the home leg and should read as part of it rather than as a system
 * notice. No new colour, no glow, no gradient.
 */

/** Same values as `HOME_COLOR` in Flowchart.tsx — this belongs to the home card. */
const HOME = {
  bg: '#FDE2E2',
  text: '#7C1A1A',
  border: '#F0B8B8',
};

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
    <div
      className="rounded-2xl border px-4 py-3"
      style={{ background: HOME.bg, borderColor: HOME.border }}
    >
      <div className="flex items-start gap-2.5">
        <MapPin size={15} className="mt-0.5 flex-shrink-0" style={{ color: HOME.text }} />

        <div className="flex-1 min-w-0">
          <div className="text-[13px] leading-snug" style={{ color: HOME.text }}>
            Flying from <span className="font-semibold">{chosen.label}</span>
            {lead && (
              <span className="font-mono text-[11px] tracking-wider" style={{ color: `${HOME.text}99` }}>
                {' '}
                ({lead})
              </span>
            )}
          </div>

          <div className="text-[12px] mt-0.5" style={{ color: `${HOME.text}cc` }}>
            {/* The traveller's own words, so it is obvious why we had to pick. */}
            You typed &ldquo;{clarification.input}&rdquo;, which matches{' '}
            {clarification.candidates.length} places.{' '}
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="underline underline-offset-2 font-medium"
              style={{ color: HOME.text }}
            >
              {open ? 'Hide' : alternatives.length === 1 ? 'See the other' : 'See the others'}
            </button>
          </div>

          {open && (
            <ul className="mt-2.5 flex flex-col gap-1.5">
              {alternatives.map((candidate) => (
                <li key={candidate.placeId}>
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
                    className="w-full text-left rounded-xl px-3 py-2 border transition-colors disabled:cursor-default"
                    style={{
                      borderColor: HOME.border,
                      background: 'rgba(255,255,255,0.55)',
                      color: HOME.text,
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[12px] font-medium truncate">{candidate.label}</span>
                      <span
                        className="text-[10px] font-mono uppercase tracking-wider flex-shrink-0"
                        style={{ color: `${HOME.text}99` }}
                      >
                        {candidate.airports.slice(0, 3).join(' · ')}
                      </span>
                    </div>
                    {candidate.distanceKm !== undefined && (
                      <div className="text-[10px] mt-0.5" style={{ color: `${HOME.text}88` }}>
                        {candidate.distanceKm.toLocaleString()} km away
                      </div>
                    )}
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
