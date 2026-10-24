/**
 * Duration truth in the day planner.
 *
 * The bug: a 4-hour activity rendered as a 2-hour block. The day was cut
 * into fixed slots and `Math.min(slotEnd, start + requested)` truncated
 * anything longer than its slot. The slots existed because meals were
 * pinned to exact clock times, so the morning slot had to stop at 12:00.
 *
 * The fix inverts it — activities are laid down at their real length and
 * meals are fitted into the gaps, anywhere inside a window. These tests
 * pin the guarantee: a rendered block never understates the thing it
 * names, and anything the day cannot hold is dropped WHOLE and reported.
 *
 * The first two blocks are NEGATIVE CONTROLS: they touch only
 * `buildDefaultSchedule`, which was exported before this change too, so
 * they are runnable against both implementations. Against the old
 * scheduler the first fails with lunch missing entirely and the second
 * with 72-minute activity blocks instead of 90.
 */

import {
  buildCityScheduleFromSuggestions,
  buildDefaultSchedule,
  planDay,
  plannedDuration,
  ACTIVITY_EARLIEST_MIN,
  ACTIVITY_FALLBACK_MIN,
  DAY_CLOSE_MIN,
  DAY_OPEN_MIN,
  MEAL_DURATION_MIN,
  MEAL_WINDOWS,
  MIN_PLACEABLE_MIN,
  SLOT_BUFFER_MIN,
} from '@/lib/dayScheduleDefaults';
import type { City, HomeLeg, ScheduledEvent, Transport, Trip } from '@/lib/types';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { buildTrip } from './fixtures';

/* ─────────────────────────────── helpers ─────────────────────────────── */

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

const lengthOf = (e: ScheduledEvent) => toMin(e.endTime) - toMin(e.startTime);

const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

function cityOf(overrides: Partial<City> & { name: string; dates: City['dates'] }): City {
  return {
    country: 'China',
    transportIn: emptyTransport,
    transportOut: emptyTransport,
    hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
    hotels: [],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
    ...overrides,
  } as City;
}

function tripOf(city: City, returnLeg?: HomeLeg): Trip {
  return {
    ...buildTrip(),
    cities: [city],
    origin: returnLeg
      ? { city: 'New York', airports: ['EWR'], outboundLeg: null, returnLeg }
      : undefined,
  };
}

const act = (
  name: string,
  timeOfDay: ActivitySuggestion['timeOfDay'],
  durationHours: number,
): ActivitySuggestion => ({
  name,
  category: 'landmark',
  timeOfDay,
  durationHours,
  reason: 'worth the trip',
});

const meal = (
  name: string,
  mealType: RestaurantSuggestion['mealType'],
): RestaurantSuggestion => ({
  name,
  cuisine: 'Local',
  priceRange: '$$',
  mealType,
  reason: 'tasty',
});

const DATES = { arrival: '2026-06-15', departure: '2026-06-16' };

/** Run the trip-creation scheduler for a one-city stay. */
const schedule = (
  activities: ActivitySuggestion[],
  restaurants: RestaurantSuggestion[],
  returnLeg?: HomeLeg,
) => {
  const city = cityOf({ name: 'Beijing', dates: DATES });
  const trip = tripOf(city, returnLeg);
  return buildCityScheduleFromSuggestions(activities, restaurants, trip.cities[0], 0, trip);
};

/** Every event across every day of a stay. */
const allEvents = (result: { schedule: Record<string, ScheduledEvent[]> }): ScheduledEvent[] =>
  Object.keys(result.schedule).reduce<ScheduledEvent[]>(
    (acc, date) => acc.concat(result.schedule[date]),
    [],
  );

/**
 * The guarantee this whole change exists for. Asserted on every scenario
 * below rather than once, because it is the thing that must never regress.
 */
const expectNoBlockUnderstatesItself = (events: ScheduledEvent[]) => {
  for (const e of events) {
    if (e.plannedDurationMin === undefined) continue;
    expect(lengthOf(e)).toBe(e.plannedDurationMin);
  }
};

/** Consecutive events on a day must stay SLOT_BUFFER_MIN apart. */
const expectBufferHolds = (events: ScheduledEvent[]) => {
  const sorted = [...events].sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  for (let i = 1; i < sorted.length; i++) {
    const gap = toMin(sorted[i].startTime) - toMin(sorted[i - 1].endTime);
    // Transport blocks are produced by the carrier's own times and butt
    // up against each other by design (head-to ends when the flight departs).
    if (sorted[i].category === 'transport' && sorted[i - 1].category === 'transport') continue;
    expect(gap).toBeGreaterThanOrEqual(SLOT_BUFFER_MIN);
  }
};

const expectMealInWindow = (e: ScheduledEvent, window: { open: number; close: number }) => {
  expect(toMin(e.startTime)).toBeGreaterThanOrEqual(window.open);
  expect(toMin(e.endTime)).toBeLessThanOrEqual(window.close);
};

/* ───────────────────── negative control: meal windows ───────────────────── */

describe('negative control — a meal is not pinned to one exact minute', () => {
  it('still seats lunch on a day whose activities run through 12:30', () => {
    // Four 90-minute activities from 09:00 tile straight over 12:30, which
    // was the only minute the old code would consider for lunch — so lunch
    // vanished from the day entirely.
    const city = cityOf({
      name: 'Rome',
      dates: { arrival: '2026-06-15', departure: '2026-06-18' },
      activities: ['Colosseum', 'Forum', 'Palatine', 'Borghese'],
      restaurants: [
        { name: 'Lunch Spot', cuisine: 'Roman', priceRange: '$$' },
        { name: 'Dinner Spot', cuisine: 'Roman', priceRange: '$$$' },
      ],
    });
    const trip = tripOf(city);

    const events = buildDefaultSchedule(trip.cities[0], '2026-06-16', trip, 0);
    const lunch = events.find((e) => e.title === 'Lunch Spot');

    expect(lunch).toBeDefined();
    // ...and it lands somewhere sensible, not at a hard-coded 12:30.
    expectMealInWindow(lunch!, MEAL_WINDOWS.lunch);
    expectBufferHolds(events);
    expectNoBlockUnderstatesItself(events);
  });
});

/* ──────────────────── negative control: no shrinking ──────────────────── */

describe('negative control — no event is rendered shorter than it asked for', () => {
  it('gives every activity on a busy day its full nominal block', () => {
    // The old builder divided the day by the activity count
    // (`Math.floor(availableMinutes / city.activities.length)`), so a day
    // with many activities shrank each one below the 90-minute nominal.
    const city = cityOf({
      name: 'Rome',
      dates: { arrival: '2026-06-15', departure: '2026-06-18' },
      activities: [
        'Colosseum',
        'Forum',
        'Palatine',
        'Borghese',
        'Trastevere walk',
        'Appian Way',
        'Capitoline',
        'Baths of Caracalla',
        'Ostia Antica',
        'Catacombs',
      ],
      restaurants: [],
    });
    const trip = tripOf(city);

    const events = buildDefaultSchedule(trip.cities[0], '2026-06-16', trip, 0);
    const activities = events.filter((e) => e.category === 'activity');

    expect(activities.length).toBeGreaterThan(0);
    for (const a of activities) expect(lengthOf(a)).toBe(90);

    // Ten 90-minute activities cannot fit one day. The ones that don't fit
    // are left off whole rather than everything being squeezed.
    expect(activities.length).toBeLessThan(10);
    expectBufferHolds(events);
    expectNoBlockUnderstatesItself(events);
  });
});

/* ───────────────────────── the reported scenario ───────────────────────── */

describe('a 4-hour activity renders as 4 hours', () => {
  const result = schedule(
    [act('Great Wall hike', 'morning', 4)],
    [meal('Cafe', 'breakfast'), meal('Noodles', 'lunch'), meal('Duck', 'dinner')],
  );
  const events = allEvents(result);
  const hike = events.find((e) => e.title === 'Great Wall hike')!;

  it('occupies four hours of calendar, not two', () => {
    expect(hike).toBeDefined();
    expect(lengthOf(hike)).toBe(240);
    expect(hike.plannedDurationMin).toBe(240);
  });

  it('is not dropped or deferred to make room', () => {
    expect(result.unscheduled).toEqual([]);
  });

  it('still seats all three meals, each inside its window', () => {
    const breakfast = events.find((e) => e.title.startsWith('Cafe'))!;
    const lunch = events.find((e) => e.title.startsWith('Noodles'))!;
    const dinner = events.find((e) => e.title.startsWith('Duck'))!;
    expectMealInWindow(breakfast, MEAL_WINDOWS.breakfast);
    expectMealInWindow(lunch, MEAL_WINDOWS.lunch);
    expectMealInWindow(dinner, MEAL_WINDOWS.dinner);
    expect(lengthOf(breakfast)).toBe(MEAL_DURATION_MIN.breakfast);
    expect(lengthOf(lunch)).toBe(MEAL_DURATION_MIN.lunch);
    expect(lengthOf(dinner)).toBe(MEAL_DURATION_MIN.dinner);
  });

  it('keeps the travel buffer between every pair of items', () => {
    expectBufferHolds(result.schedule[DATES.arrival]);
  });

  it('never understates any block', () => {
    expectNoBlockUnderstatesItself(events);
  });

  it('does not start the activity before its time-of-day floor', () => {
    expect(toMin(hike.startTime)).toBeGreaterThanOrEqual(ACTIVITY_EARLIEST_MIN.morning);
  });
});

/* ───────────────────── several long activities in a day ───────────────────── */

describe('several long activities in one day', () => {
  const result = schedule(
    [
      act('Great Wall hike', 'morning', 4),
      act('Forbidden City', 'afternoon', 3.5),
      act('Opera', 'evening', 3),
    ],
    [meal('Cafe', 'breakfast'), meal('Noodles', 'lunch'), meal('Duck', 'dinner')],
  );
  const events = allEvents(result);

  it('gives each one its full length wherever it lands', () => {
    const wanted: Record<string, number> = {
      'Great Wall hike': 240,
      'Forbidden City': 210,
      Opera: 180,
    };
    for (const title of Object.keys(wanted)) {
      const e = events.find((x) => x.title === title);
      expect(e).toBeDefined();
      expect(lengthOf(e!)).toBe(wanted[title]);
    }
  });

  it('defers what one day cannot hold to the next day of the stay', () => {
    // 10.5 hours of activity plus three meals does not fit a single day,
    // so something moves to day 2 — at full length, not shortened.
    const days = Object.keys(result.schedule);
    expect(days.length).toBeGreaterThan(1);
    // Deferred, not lost: nothing ends up permanently unscheduled.
    expect(result.unscheduled).toEqual([]);
  });

  it('does not overlap two items on the same day', () => {
    for (const date of Object.keys(result.schedule)) {
      const sorted = [...result.schedule[date]].sort(
        (a, b) => toMin(a.startTime) - toMin(b.startTime),
      );
      for (let i = 1; i < sorted.length; i++) {
        expect(toMin(sorted[i].startTime)).toBeGreaterThanOrEqual(toMin(sorted[i - 1].endTime));
      }
      expectBufferHolds(result.schedule[date]);
    }
  });

  it('never understates any block', () => {
    expectNoBlockUnderstatesItself(events);
  });
});

/* ──────────────────────── a day too full to hold it all ──────────────────────── */

describe('an item no day of the stay can hold', () => {
  // A 4-hour activity on a travel day whose window closes at 10:00 (a
  // 12:00 flight, 2h airport buffer) cannot fit, and there is no later
  // day to defer it to.
  const earlyFlight: HomeLeg = {
    originAirport: 'PEK',
    destAirport: 'EWR',
    price: 500,
    currency: 'USD',
    durationMinutes: 180,
    operator: 'UA',
    carrierCode: 'UA',
    departTime: '12:00',
    arriveTime: '15:00',
    departDate: '2026-06-16',
    stops: 0,
    bookingUrl: null,
  };
  const result = schedule(
    [act('Great Wall hike', 'morning', 4), act('Second long hike', 'morning', 4)],
    [meal('Cafe', 'breakfast'), meal('Noodles', 'lunch'), meal('Duck', 'dinner')],
    earlyFlight,
  );
  const events = allEvents(result);

  it('reports it whole, with its real duration, instead of shrinking it', () => {
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0]).toEqual({
      title: 'Second long hike',
      kind: 'activity',
      durationMin: 240,
      date: '2026-06-16',
    });
  });

  it('does not render a stub block for the item it dropped', () => {
    expect(events.map((e) => e.title)).not.toContain('Second long hike');
  });

  it('still places the one that does fit, at full length', () => {
    const hike = events.find((e) => e.title === 'Great Wall hike')!;
    expect(lengthOf(hike)).toBe(240);
  });

  it('never understates any block', () => {
    expectNoBlockUnderstatesItself(events);
  });
});

/* ───────────────────── travel day with a hard window end ───────────────────── */

describe('travel day with an early hard window end', () => {
  const eveningFlight: HomeLeg = {
    originAirport: 'PEK',
    destAirport: 'EWR',
    price: 500,
    currency: 'USD',
    durationMinutes: 180,
    operator: 'UA',
    carrierCode: 'UA',
    // 19:00 departure, 2h flight buffer → nothing after 17:00.
    departTime: '19:00',
    arriveTime: '22:00',
    departDate: '2026-06-16',
    stops: 0,
    bookingUrl: null,
  };
  const result = schedule(
    [act('Great Wall hike', 'morning', 4), act('Temple of Heaven', 'morning', 2)],
    [meal('Cafe', 'breakfast'), meal('Noodles', 'lunch'), meal('Duck', 'dinner')],
    eveningFlight,
  );
  const travelDay = result.schedule['2026-06-16'];

  it('keeps the transport blocks the carrier dictates', () => {
    const transport = travelDay.filter((e) => e.category === 'transport');
    expect(transport.map((e) => e.title)).toEqual([
      'Head to PEK',
      'Flight PEK → EWR',
    ]);
  });

  it('puts nothing else after the head-to-airport block', () => {
    const headTo = travelDay.find((e) => e.title === 'Head to PEK')!;
    const cutoff = toMin(headTo.startTime);
    expect(cutoff).toBe(17 * 60);
    for (const e of travelDay) {
      if (e.category === 'transport') continue;
      expect(toMin(e.endTime)).toBeLessThanOrEqual(cutoff);
    }
  });

  it('still fits a 2-hour activity before the cutoff, at full length', () => {
    const temple = travelDay.find((e) => e.title === 'Temple of Heaven')!;
    expect(temple).toBeDefined();
    expect(lengthOf(temple)).toBe(120);
    expect(toMin(temple.endTime)).toBeLessThanOrEqual(17 * 60);
  });

  it('never understates any block', () => {
    expectNoBlockUnderstatesItself(allEvents(result));
  });
});

/* ──────────────────────────── a day with no activities ──────────────────────────── */

describe('a day with no activities', () => {
  const result = schedule(
    [],
    [meal('Cafe', 'breakfast'), meal('Noodles', 'lunch'), meal('Duck', 'dinner')],
  );
  const day = result.schedule[DATES.arrival];

  it('seats the meals at their ideal times, since nothing is in the way', () => {
    const at = (prefix: string) => day.find((e) => e.title.startsWith(prefix))!;
    expect(toMin(at('Cafe').startTime)).toBe(MEAL_WINDOWS.breakfast.ideal);
    expect(toMin(at('Noodles').startTime)).toBe(MEAL_WINDOWS.lunch.ideal);
    expect(toMin(at('Duck').startTime)).toBe(MEAL_WINDOWS.dinner.ideal);
  });

  it('produces no activity blocks and drops nothing', () => {
    expect(day.filter((e) => e.category === 'activity')).toHaveLength(0);
    expect(result.unscheduled).toEqual([]);
  });
});

describe('a day with neither activities nor restaurants', () => {
  it('produces an empty stay with nothing dropped', () => {
    const result = schedule([], []);
    expect(allEvents(result)).toEqual([]);
    expect(result.unscheduled).toEqual([]);
  });
});

/* ───────────────────────────── planDay directly ───────────────────────────── */

describe('planDay', () => {
  const base = {
    dayStart: DAY_OPEN_MIN,
    dayEnd: DAY_CLOSE_MIN,
    busyRanges: [] as Array<[number, number]>,
  };

  const item = (key: string, durationMin: number, extra: Partial<Parameters<typeof planDay>[0]['sequence'][0]> = {}) => ({
    key,
    durationMin,
    earliestStart: DAY_OPEN_MIN,
    latestEnd: DAY_CLOSE_MIN,
    ...extra,
  });

  it('places a sequence item at its full duration', () => {
    const plan = planDay({ ...base, sequence: [item('a', 240)], flexible: [] });
    expect(plan.placements).toEqual([
      { key: 'a', startMin: DAY_OPEN_MIN, endMin: DAY_OPEN_MIN + 240, durationMin: 240 },
    ]);
    expect(plan.dropped).toEqual([]);
  });

  it('keeps SLOT_BUFFER_MIN between consecutive sequence items', () => {
    const plan = planDay({
      ...base,
      sequence: [item('a', 120), item('b', 120)],
      flexible: [],
    });
    const [a, b] = plan.placements;
    expect(b.startMin - a.endMin).toBe(SLOT_BUFFER_MIN);
  });

  it('keeps SLOT_BUFFER_MIN clear of a busy range', () => {
    const plan = planDay({
      ...base,
      busyRanges: [[DAY_OPEN_MIN, DAY_OPEN_MIN + 60]],
      sequence: [item('a', 120)],
      flexible: [],
    });
    expect(plan.placements[0].startMin).toBe(DAY_OPEN_MIN + 60 + SLOT_BUFFER_MIN);
  });

  it('drops an item whole rather than shortening it to the room left', () => {
    // 10 hours asked of a 2-hour day.
    const plan = planDay({
      dayStart: 9 * 60,
      dayEnd: 11 * 60,
      busyRanges: [],
      sequence: [item('long', 600, { earliestStart: 9 * 60, latestEnd: 11 * 60 })],
      flexible: [],
    });
    expect(plan.placements).toEqual([]);
    expect(plan.dropped).toEqual([{ key: 'long', durationMin: 600 }]);
  });

  it('slides a sequence item later so a flexible item keeps its window', () => {
    // A 4-hour item would swallow the whole lunch window if it started at
    // 09:00. It is moved, not trimmed.
    const plan = planDay({
      ...base,
      sequence: [item('hike', 240, { earliestStart: 9 * 60 })],
      flexible: [
        {
          key: 'lunch',
          durationMin: MEAL_DURATION_MIN.lunch,
          earliestStart: MEAL_WINDOWS.lunch.open,
          latestEnd: MEAL_WINDOWS.lunch.close,
          idealStart: MEAL_WINDOWS.lunch.ideal,
        },
      ],
    });
    const hike = plan.placements.find((p) => p.key === 'hike')!;
    const lunch = plan.placements.find((p) => p.key === 'lunch')!;
    expect(hike.durationMin).toBe(240);
    expect(hike.endMin - hike.startMin).toBe(240);
    expect(lunch.startMin).toBeGreaterThanOrEqual(MEAL_WINDOWS.lunch.open);
    expect(lunch.endMin).toBeLessThanOrEqual(MEAL_WINDOWS.lunch.close);
    expect(plan.dropped).toEqual([]);
  });

  it('lets a meal give way rather than dropping an activity that needs the room', () => {
    // 11 hours leaves no window for lunch anywhere. The rule is that a
    // meal decides WHEN an activity happens, never WHETHER.
    const plan = planDay({
      ...base,
      sequence: [item('epic', 660, { earliestStart: 9 * 60 })],
      flexible: [
        {
          key: 'lunch',
          durationMin: MEAL_DURATION_MIN.lunch,
          earliestStart: MEAL_WINDOWS.lunch.open,
          latestEnd: MEAL_WINDOWS.lunch.close,
          idealStart: MEAL_WINDOWS.lunch.ideal,
        },
      ],
    });
    const epic = plan.placements.find((p) => p.key === 'epic')!;
    expect(epic.endMin - epic.startMin).toBe(660);
    expect(plan.dropped).toEqual([{ key: 'lunch', durationMin: MEAL_DURATION_MIN.lunch }]);
  });

  it('puts a flexible item at the free minute nearest its ideal', () => {
    const plan = planDay({
      ...base,
      sequence: [],
      flexible: [
        {
          key: 'dinner',
          durationMin: MEAL_DURATION_MIN.dinner,
          earliestStart: MEAL_WINDOWS.dinner.open,
          latestEnd: MEAL_WINDOWS.dinner.close,
          idealStart: MEAL_WINDOWS.dinner.ideal,
        },
      ],
    });
    expect(plan.placements[0].startMin).toBe(MEAL_WINDOWS.dinner.ideal);
  });

  it('drops a flexible item whose window is entirely outside the day', () => {
    const plan = planDay({
      dayStart: DAY_OPEN_MIN,
      dayEnd: 15 * 60, // head-to-airport at 15:00
      busyRanges: [],
      sequence: [],
      flexible: [
        {
          key: 'dinner',
          durationMin: MEAL_DURATION_MIN.dinner,
          earliestStart: MEAL_WINDOWS.dinner.open,
          latestEnd: MEAL_WINDOWS.dinner.close,
          idealStart: MEAL_WINDOWS.dinner.ideal,
        },
      ],
    });
    expect(plan.placements).toEqual([]);
    expect(plan.dropped).toEqual([{ key: 'dinner', durationMin: MEAL_DURATION_MIN.dinner }]);
  });

  it('returns placements sorted by start time even when meals land first', () => {
    const plan = planDay({
      ...base,
      sequence: [item('afternoon', 120, { earliestStart: 14 * 60 })],
      flexible: [
        {
          key: 'breakfast',
          durationMin: MEAL_DURATION_MIN.breakfast,
          earliestStart: MEAL_WINDOWS.breakfast.open,
          latestEnd: MEAL_WINDOWS.breakfast.close,
          idealStart: MEAL_WINDOWS.breakfast.ideal,
        },
      ],
    });
    const starts = plan.placements.map((p) => p.startMin);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(plan.placements[0].key).toBe('breakfast');
  });

  it('drops everything on a day clamped out of existence', () => {
    // A 23:00 arrival clamps windowStart past the day's close.
    const plan = planDay({
      dayStart: 24 * 60,
      dayEnd: DAY_CLOSE_MIN,
      busyRanges: [],
      sequence: [item('a', 60)],
      flexible: [
        {
          key: 'dinner',
          durationMin: MEAL_DURATION_MIN.dinner,
          earliestStart: MEAL_WINDOWS.dinner.open,
          latestEnd: MEAL_WINDOWS.dinner.close,
        },
      ],
    });
    expect(plan.placements).toEqual([]);
    expect(plan.dropped.map((d) => d.key).sort()).toEqual(['a', 'dinner']);
  });

  it('respects a busy range that splits the day in two', () => {
    const plan = planDay({
      ...base,
      busyRanges: [[12 * 60, 14 * 60]],
      sequence: [item('a', 120), item('b', 120)],
      flexible: [],
    });
    const [a, b] = plan.placements;
    expect(a.endMin).toBeLessThanOrEqual(12 * 60 - SLOT_BUFFER_MIN);
    expect(b.startMin).toBeGreaterThanOrEqual(14 * 60 + SLOT_BUFFER_MIN);
  });
});

/* ──────────────────────────── plannedDuration ──────────────────────────── */

describe('a suggestion with no stated duration', () => {
  it('falls back to the time-of-day default, not the 30-minute floor', () => {
    // `durationHours` is typed as a number but the AI can omit it; the
    // fixed-slot scheduler defaulted to 2h / 3h / 2h and so does this.
    const bare = (
      name: string,
      timeOfDay: ActivitySuggestion['timeOfDay'],
    ): ActivitySuggestion =>
      ({
        name,
        category: 'landmark',
        timeOfDay,
        reason: 'no duration given',
      } as unknown as ActivitySuggestion);

    const result = schedule(
      [bare('Morning thing', 'morning'), bare('Afternoon thing', 'afternoon')],
      [],
    );
    const events = allEvents(result);
    expect(lengthOf(events.find((e) => e.title === 'Morning thing')!)).toBe(
      ACTIVITY_FALLBACK_MIN.morning,
    );
    expect(lengthOf(events.find((e) => e.title === 'Afternoon thing')!)).toBe(
      ACTIVITY_FALLBACK_MIN.afternoon,
    );
    expectNoBlockUnderstatesItself(events);
  });
});

describe('plannedDuration', () => {
  it('passes a real duration through', () => {
    expect(plannedDuration(240)).toBe(240);
  });

  it(`floors a tiny duration at ${MIN_PLACEABLE_MIN} minutes`, () => {
    expect(plannedDuration(5)).toBe(MIN_PLACEABLE_MIN);
  });

  it('rounds a fractional duration', () => {
    expect(plannedDuration(3.5 * 60)).toBe(210);
    expect(plannedDuration(100.4)).toBe(100);
  });

  it('treats a missing or non-numeric duration as the floor, not NaN', () => {
    expect(plannedDuration(undefined)).toBe(MIN_PLACEABLE_MIN);
    expect(plannedDuration(Number.NaN)).toBe(MIN_PLACEABLE_MIN);
    expect(plannedDuration(Number.POSITIVE_INFINITY)).toBe(MIN_PLACEABLE_MIN);
  });
});
