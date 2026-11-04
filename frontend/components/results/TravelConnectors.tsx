'use client';

import { Footprints, TramFront } from 'lucide-react';
import type { ScheduledEvent } from '@/lib/types';
import { estimateHubTravel, hasCoords, legBetweenEvents, type TravelInfo } from '@/lib/geoSchedule';
import { NO_HUBS, type DayHubs } from '@/lib/tripHubs';

/**
 * Travel time between consecutive located events on a day's time grid:
 * a dashed line through the gap (the product's dashed-route motif) with a
 * small "12 min walk" tag. Drawn between two events that both carry POI
 * coordinates, and between a travel block and the stop next to it:
 * "Arrive at Rome" → the first stop, and the last stop → "Head to the
 * airport", measured from the located airport / station (`hubs`).
 *
 * Absolutely positioned inside the same container as the event blocks, so
 * `minuteToPx` must match theirs.
 */
export type Connector = { key: string; startMin: number; endMin: number; leg: TravelInfo };

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

const isArrive = (e: ScheduledEvent) => e.category === 'transport' && /^arrive at\b/i.test(e.title);
const isHeadTo = (e: ScheduledEvent) => e.category === 'transport' && /^head to\b/i.test(e.title);

/** The hub a "Head to …" block goes to: the departure it ends at, else the only one. */
function departHub(evt: ScheduledEvent, hubs: DayHubs) {
  const exact = hubs.departs.find((d) => d.departTime && d.departTime === evt.endTime);
  if (exact) return exact.hub;
  return hubs.departs.length === 1 ? hubs.departs[0].hub : null;
}

/** The connectors for a day, in time order. Pure — exported for tests. */
export function dayConnectors(events: ScheduledEvent[], hubs: DayHubs = NO_HUBS): Connector[] {
  const sorted = [...events].sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  const out: Connector[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const evt = sorted[i];
    let leg = legBetweenEvents(prev, evt);
    // Arrival hub → first located stop.
    if (!leg && isArrive(prev) && evt.category !== 'transport' && hasCoords(evt) && hubs.arrive) {
      leg = estimateHubTravel(hubs.arrive, evt);
    }
    // Last located stop → the airport / station being headed to.
    if (!leg && isHeadTo(evt) && prev.category !== 'transport' && hasCoords(prev)) {
      const hub = departHub(evt, hubs);
      if (hub) leg = estimateHubTravel(hub, prev);
    }
    if (!leg) continue;
    out.push({ key: `${prev.id}>${evt.id}`, startMin: toMin(prev.endTime), endMin: toMin(evt.startTime), leg });
  }
  return out;
}

export default function TravelConnectors({
  events,
  minuteToPx,
  accent,
  left = 6,
  hubs = NO_HUBS,
}: {
  events: ScheduledEvent[];
  /** Located arrival / departure hubs for this day (see useDayHubs). */
  hubs?: DayHubs;
  minuteToPx: (min: number) => number;
  accent: string;
  /** Inset of the dashed line from the container's left edge, in px. */
  left?: number;
}) {
  const connectors = dayConnectors(events, hubs);
  return (
    <>
      {connectors.map(({ key, startMin, endMin, leg }) => {
        const top = minuteToPx(startMin);
        const height = Math.max(0, minuteToPx(endMin) - top);
        const Icon = leg.mode === 'walk' ? Footprints : TramFront;
        const label = `${leg.minutes} min ${leg.mode === 'walk' ? 'walk' : 'transit'}`;
        const title = `${label} · ${leg.distanceKm} km${leg.source === 'estimate' ? ' (estimated)' : ''}`;
        return (
          <div
            key={key}
            data-testid="travel-connector"
            title={title}
            className="absolute right-1 pointer-events-none z-[15]"
            style={{ top, height, left }}
          >
            <div
              className="absolute top-0 bottom-0 left-[6px] border-l-[1.5px] border-dashed"
              style={{ borderColor: `${accent}80` }}
            />
            <div className="absolute left-[14px] top-1/2 -translate-y-1/2">
              <span
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-white px-1.5 text-[9px] font-medium leading-[13px]"
                style={{ color: accent, border: `1px solid ${accent}40` }}
              >
                <Icon size={9} strokeWidth={2.25} aria-hidden />
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}
