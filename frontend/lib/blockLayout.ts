import type { ScheduledEvent } from './types';
import { durationMinutes } from './dayScheduleDefaults';

/**
 * Where each event of a day is drawn on a time grid: its start and end,
 * at least `minHeightPx` tall — with travel blocks kept in sequence.
 *
 * Two travel blocks used to land on top of each other, unreadable:
 *  - a hop into an earlier time zone (Paris 10:50 → London 10:48) ends at
 *    an earlier clock time than it starts, so the flight had no height of its
 *    own and its "Arrive at" sat over it. It is drawn for its flight time
 *    from departure instead (the times on it stay the real ones);
 *  - a short leg (11:36 → 11:41) is drawn taller than its five minutes, over
 *    the "Arrive at" that starts when it lands.
 * So each travel block is drawn below the one before it — head-to, the
 * flight, then the arrival — when the one before it runs over. Only the
 * drawing moves; no event's times change.
 */
export function blockLayout(
  events: ScheduledEvent[],
  minuteToPx: (min: number) => number,
  minHeightPx: number,
): Map<string, { top: number; height: number }> {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const out = new Map<string, { top: number; height: number }>();
  for (const e of events) {
    const s = toMin(e.startTime);
    let end = toMin(e.endTime);
    if (end < s) {
      const dur = e.category === 'transport' ? durationMinutes(e.notes) : null;
      end = dur !== null && s + dur < 24 * 60 ? s + dur : 24 * 60;
    }
    const top = minuteToPx(s);
    out.set(e.id, { top, height: Math.max(minuteToPx(end) - top, minHeightPx) });
  }

  const travel = events.filter((e) => e.category === 'transport').sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  // The landing marker comes after the leg it lands, whatever the clocks say.
  const arrive = travel.findIndex((e) => e.autoRole === 'in-arrive');
  const leg = travel.findIndex((e) => e.autoRole === 'in-travel');
  if (arrive >= 0 && leg > arrive) travel.splice(leg + 1, 0, ...travel.splice(arrive, 1));
  let bottom = -Infinity;
  for (const e of travel) {
    const box = out.get(e.id)!;
    if (box.top < bottom) out.set(e.id, { top: bottom, height: box.height });
    bottom = Math.max(bottom, out.get(e.id)!.top + box.height);
  }
  return out;
}
