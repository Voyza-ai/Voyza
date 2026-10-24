/**
 * Activity duration clipping.
 *
 * A 4-hour activity rendered as a 2-hour block because the morning slot
 * caps at 12:00, and the requested duration was discarded at that point —
 * it survived nowhere, not even the notes.
 *
 * These cover the DATA half: the real duration is now preserved on the
 * event. The rendered block is deliberately left alone, because whether a
 * long activity overflows into the afternoon or renders truncated with a
 * label is a design decision that needs sign-off.
 */

import {
  placeInSlot,
  SLOT_BUFFER_MIN,
  MIN_PLACEABLE_MIN,
} from '@/lib/dayScheduleDefaults';
import type { ScheduledEvent } from '@/lib/types';

const pad = (n: number) => String(n).padStart(2, '0');
const minToTime = (t: number) => `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;

/** Same shape PlanningChat's makeActivityEvent produces. */
const makeEvent =
  (title: string, notes?: string) =>
  (startMin: number, endMin: number): ScheduledEvent => ({
    id: 'e1',
    title,
    startTime: minToTime(startMin),
    endTime: minToTime(endMin),
    category: 'activity',
    notes,
  });

// The real slot definitions from PlanningChat's scheduler.
const MORNING: [number, number] = [10 * 60, 12 * 60];
const AFTERNOON: [number, number] = [14 * 60 + 15, 18 * 60 + 30];

describe('placeInSlot — the reported 4-hour activity', () => {
  const place = (durMin: number) =>
    placeInSlot({
      cursor: 0,
      slotStart: MORNING[0],
      slotEnd: MORNING[1],
      desiredDurMin: durMin,
      make: makeEvent('Great Wall hike', 'A long day out'),
    });

  it('still renders inside the morning slot (no visual change yet)', () => {
    const r = place(4 * 60)!;
    expect(r.event.startTime).toBe('10:00');
    expect(r.event.endTime).toBe('12:00');
  });

  it('preserves the real 4-hour duration on the event', () => {
    // This is the fix: 240 used to be discarded here.
    const r = place(4 * 60)!;
    expect(r.event.plannedDurationMin).toBe(240);
  });

  it('flags the event as clipped', () => {
    const r = place(4 * 60)!;
    expect(r.event.durationClipped).toBe(true);
  });

  it('lets a consumer tell a clipped 4h activity from a real 2h one', () => {
    // Both render 10:00-12:00. Before, they were indistinguishable.
    const clipped = place(4 * 60)!.event;
    const genuine = place(2 * 60)!.event;

    expect(clipped.startTime).toBe(genuine.startTime);
    expect(clipped.endTime).toBe(genuine.endTime);

    expect(clipped.plannedDurationMin).toBe(240);
    expect(clipped.durationClipped).toBe(true);
    expect(genuine.plannedDurationMin).toBe(120);
    expect(genuine.durationClipped).toBeUndefined();
  });

  it('does not hide the duration in the notes', () => {
    // The old code comment claimed the duration survived in the notes.
    // It did not, and this fix does not start writing prose there either.
    const r = place(4 * 60)!;
    expect(r.event.notes).toBe('A long day out');
  });
});

describe('placeInSlot — clipping flag accuracy', () => {
  const inMorning = (durMin: number, cursor = 0) =>
    placeInSlot({
      cursor,
      slotStart: MORNING[0],
      slotEnd: MORNING[1],
      desiredDurMin: durMin,
      make: makeEvent('Activity'),
    });

  it('does not flag an activity that fits exactly', () => {
    const r = inMorning(2 * 60)!;
    expect(r.event.endTime).toBe('12:00');
    expect(r.event.durationClipped).toBeUndefined();
    expect(r.event.plannedDurationMin).toBe(120);
  });

  it('does not flag an activity that fits with room to spare', () => {
    const r = inMorning(90)!;
    expect(r.event.endTime).toBe('11:30');
    expect(r.event.durationClipped).toBeUndefined();
    expect(r.event.plannedDurationMin).toBe(90);
  });

  it('flags by even a single minute of loss', () => {
    const r = inMorning(121)!;
    expect(r.event.endTime).toBe('12:00');
    expect(r.event.durationClipped).toBe(true);
    expect(r.event.plannedDurationMin).toBe(121);
  });

  it('accounts for the inter-event buffer when clipping', () => {
    // A 10:45 cursor means the event starts at 11:00, so only 60 minutes
    // of the slot are left and a 90-minute activity is clipped.
    const r = inMorning(90, 10 * 60 + 45)!;
    expect(r.event.startTime).toBe('11:00');
    expect(r.event.endTime).toBe('12:00');
    expect(r.event.durationClipped).toBe(true);
    expect(r.event.plannedDurationMin).toBe(90);
  });

  it('leaves a long afternoon activity unclipped — the slot is wide', () => {
    const r = placeInSlot({
      cursor: 0,
      slotStart: AFTERNOON[0],
      slotEnd: AFTERNOON[1],
      desiredDurMin: 4 * 60,
      make: makeEvent('Museum crawl'),
    })!;
    expect(r.event.startTime).toBe('14:15');
    expect(r.event.endTime).toBe('18:15');
    expect(r.event.durationClipped).toBeUndefined();
    expect(r.event.plannedDurationMin).toBe(240);
  });
});

describe('placeInSlot — behaviour preserved from the inline tryPlace', () => {
  it('advances the cursor to the event end', () => {
    const r = placeInSlot({
      cursor: 0,
      slotStart: MORNING[0],
      slotEnd: MORNING[1],
      desiredDurMin: 90,
      make: makeEvent('Activity'),
    })!;
    expect(r.cursor).toBe(11 * 60 + 30);
  });

  it(`leaves a ${SLOT_BUFFER_MIN}-minute buffer after a previous event`, () => {
    const r = placeInSlot({
      cursor: 10 * 60 + 30,
      slotStart: MORNING[0],
      slotEnd: MORNING[1],
      desiredDurMin: 60,
      make: makeEvent('Activity'),
    })!;
    expect(r.event.startTime).toBe('10:45');
  });

  it('starts at the slot start when nothing has been placed yet', () => {
    const r = placeInSlot({
      cursor: 0,
      slotStart: MORNING[0],
      slotEnd: MORNING[1],
      desiredDurMin: 60,
      make: makeEvent('Activity'),
    })!;
    expect(r.event.startTime).toBe('10:00');
  });

  it('returns null when the cursor has run past the slot', () => {
    expect(
      placeInSlot({
        cursor: 13 * 60,
        slotStart: MORNING[0],
        slotEnd: MORNING[1],
        desiredDurMin: 60,
        make: makeEvent('Activity'),
      }),
    ).toBeNull();
  });

  it(`returns null when under ${MIN_PLACEABLE_MIN} minutes remain`, () => {
    // 11:45 cursor → 12:00 start, which is already the slot end.
    expect(
      placeInSlot({
        cursor: 11 * 60 + 20,
        slotStart: MORNING[0],
        slotEnd: MORNING[1],
        desiredDurMin: 60,
        make: makeEvent('Activity'),
      }),
    ).toBeNull();
  });

  it('returns null for an inverted slot (clamped out of existence)', () => {
    // clampSlot produces start > end on a day with a late arrival.
    expect(
      placeInSlot({
        cursor: 0,
        slotStart: 12 * 60,
        slotEnd: 10 * 60,
        desiredDurMin: 60,
        make: makeEvent('Activity'),
      }),
    ).toBeNull();
  });

  it(`floors a tiny or missing duration at ${MIN_PLACEABLE_MIN} minutes`, () => {
    const tiny = placeInSlot({
      cursor: 0,
      slotStart: MORNING[0],
      slotEnd: MORNING[1],
      desiredDurMin: 5,
      make: makeEvent('Quick stop'),
    })!;
    expect(tiny.event.endTime).toBe('10:30');
    expect(tiny.event.plannedDurationMin).toBe(30);
    expect(tiny.event.durationClipped).toBeUndefined();

    const nan = placeInSlot({
      cursor: 0,
      slotStart: MORNING[0],
      slotEnd: MORNING[1],
      desiredDurMin: Number.NaN,
      make: makeEvent('Unknown length'),
    })!;
    expect(nan.event.endTime).toBe('10:30');
    expect(nan.event.plannedDurationMin).toBe(30);
  });

  it('keeps every field the make() callback set', () => {
    const r = placeInSlot({
      cursor: 0,
      slotStart: MORNING[0],
      slotEnd: MORNING[1],
      desiredDurMin: 60,
      make: makeEvent('Louvre', 'Skip the line'),
    })!;
    expect(r.event.id).toBe('e1');
    expect(r.event.title).toBe('Louvre');
    expect(r.event.category).toBe('activity');
    expect(r.event.notes).toBe('Skip the line');
  });
});
