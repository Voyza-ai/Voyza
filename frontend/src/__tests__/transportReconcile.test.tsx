/**
 * The calendar follows transport changes the way the flowchart does.
 *
 * A day's generated travel blocks ("Head to …", the flight / train,
 * "Arrive at …") are tagged `auto` and re-derived from the current
 * `transportIn` / `transportOut` / home legs; activities, meals, the user's
 * own events and any travel block the user moved are left alone.
 */
import './mocks';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import DayPlanner from '@/components/results/DayPlanner';
import { useTripStore } from '@/store/tripStore';
import { buildDayTransportContext, buildDefaultSchedule } from '@/lib/dayScheduleDefaults';
import {
  applyUserEdit,
  reconcileDayEvents,
  reconcileDayTransport,
  reconcileTripTransport,
} from '@/lib/transportReconcile';
import type { City, HomeLeg, ScheduledEvent, Transport, Trip } from '@/lib/types';
import { buildTrip } from './fixtures';

// Hub lookups are a network side-channel of the planner, not under test here.
jest.mock('@/lib/tripHubs', () => ({
  useDayHubs: () => ({ arrive: null, departs: [] }),
}));

const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

/** Rome → Florence train options: the picked one and an alternative. */
const train0800: Transport = {
  mode: 'train',
  operator: 'Trenitalia',
  duration: '1h 32m',
  price: 35,
  departTime: '08:00',
  arriveTime: '09:32',
  fromStation: 'Roma Termini',
  toStation: 'Firenze S.M.N.',
};
const train1400: Transport = { ...train0800, operator: 'Italo', departTime: '14:00', arriveTime: '15:35' };

const homeOut: HomeLeg = {
  originAirport: 'JFK',
  destAirport: 'FCO',
  price: 600,
  currency: 'USD',
  durationMinutes: 500,
  operator: 'Delta',
  carrierCode: 'DL',
  departTime: '06:00',
  arriveTime: '14:20',
  departDate: '2026-06-15',
  arriveDate: '2026-06-15',
  stops: 0,
  bookingUrl: null,
};
const returnA: HomeLeg = {
  ...homeOut,
  originAirport: 'FLR',
  destAirport: 'JFK',
  departTime: '11:00',
  arriveTime: '15:00',
  departDate: '2026-06-20',
  arriveDate: '2026-06-20',
};
const returnB: HomeLeg = { ...returnA, operator: 'ITA', departTime: '18:30', arriveTime: '22:40' };

function makeTrip(): Trip {
  const base = buildTrip();
  const rome: City = {
    ...base.cities[0],
    dates: { arrival: '2026-06-15', departure: '2026-06-18' },
    transportIn: emptyTransport,
    transportOut: { ...train0800, alternatives: [train1400] },
    activities: ['Colosseum'],
    restaurants: [],
    schedule: undefined,
  };
  const florence: City = {
    ...base.cities[1],
    dates: { arrival: '2026-06-18', departure: '2026-06-20' },
    transportIn: train0800,
    transportOut: emptyTransport,
    activities: ['Uffizi Gallery', 'Duomo climb'],
    restaurants: [
      { name: 'Trattoria Mario', cuisine: 'Tuscan', priceRange: '$$' },
      { name: 'Buca Lapi', cuisine: 'Tuscan', priceRange: '$$$' },
    ],
    schedule: undefined,
  };
  return {
    ...base,
    cities: [rome, florence],
    origin: {
      city: 'New York',
      airports: ['JFK'],
      outboundLeg: homeOut,
      returnLeg: { ...returnA, alternatives: [returnB] },
    },
  };
}

const ARRIVAL = '2026-06-18'; // Florence arrival (train in)
const DEPARTURE = '2026-06-20'; // Florence departure (flight home)

/** Load a trip with its Florence arrival and departure days built. */
function loadBuilt(): Trip {
  const t = makeTrip();
  const f = t.cities[1];
  const schedule = {
    [ARRIVAL]: buildDefaultSchedule(f, ARRIVAL, t, 1),
    [DEPARTURE]: buildDefaultSchedule(f, DEPARTURE, t, 1),
  };
  const built = { ...t, cities: [t.cities[0], { ...f, schedule }] };
  useTripStore.setState({ currentTrip: built });
  return built;
}

const day = (date: string): ScheduledEvent[] =>
  useTripStore.getState().currentTrip!.cities[1].schedule![date];
const byRole = (events: ScheduledEvent[], role: string) => events.filter((e) => e.autoRole === role);
const nonTransport = (events: ScheduledEvent[]) => events.filter((e) => e.category !== 'transport');

describe('generated travel blocks are tagged', () => {
  it('every block buildDayTransportContext makes carries auto + its role', () => {
    const t = makeTrip();
    const arr = buildDayTransportContext(t.cities[1], ARRIVAL, t, 1).events;
    expect(arr.map((e) => [e.auto, e.autoRole])).toEqual([
      [true, 'in-head'],
      [true, 'in-travel'],
      [true, 'in-arrive'],
    ]);
    const dep = buildDayTransportContext(t.cities[1], DEPARTURE, t, 1).events;
    expect(dep.map((e) => [e.auto, e.autoRole])).toEqual([
      [true, 'out-head'],
      [true, 'out-travel'],
    ]);
  });

  it('activities and meals are not tagged', () => {
    const t = makeTrip();
    const events = buildDefaultSchedule(t.cities[1], ARRIVAL, t, 1);
    for (const e of nonTransport(events)) {
      expect(e.auto).toBeUndefined();
      expect(e.autoRole).toBeUndefined();
    }
  });
});

describe('reconciliation', () => {
  it('a day already in step is left alone (null, no write)', () => {
    const t = loadBuilt();
    expect(reconcileDayTransport(t, 1, ARRIVAL)).toBeNull();
    expect(reconcileDayTransport(t, 1, DEPARTURE)).toBeNull();
    expect(reconcileTripTransport(t)).toBe(t);
  });

  it('a day with no schedule yet is not built here', () => {
    const t = makeTrip();
    expect(reconcileDayTransport(t, 1, ARRIVAL)).toBeNull();
  });

  it('removes generated blocks when the transport behind them is gone', () => {
    const t = loadBuilt();
    const gone = { ...t, cities: [t.cities[0], { ...t.cities[1], transportIn: emptyTransport }] };
    const next = reconcileDayTransport(gone, 1, ARRIVAL)!;
    expect(next.filter((e) => e.category === 'transport')).toEqual([]);
    expect(nonTransport(next)).toEqual(nonTransport(t.cities[1].schedule![ARRIVAL]));
  });

  it('keeps ids of the blocks it rewrites', () => {
    const t = loadBuilt();
    const before = t.cities[1].schedule![ARRIVAL];
    useTripStore.getState().setTransportOut(0, 0);
    const after = day(ARRIVAL);
    expect(byRole(after, 'in-travel')[0].id).toBe(byRole(before, 'in-travel')[0].id);
  });
});

describe('swap updates — arrival day (transportIn)', () => {
  it('swapping the inbound train moves head-to, train and arrive blocks', () => {
    loadBuilt();
    useTripStore.getState().setTransportOut(0, 0); // 08:00 → 14:00
    const after = day(ARRIVAL);
    expect(byRole(after, 'in-head')[0]).toMatchObject({ startTime: '13:30', endTime: '14:00', auto: true });
    expect(byRole(after, 'in-travel')[0]).toMatchObject({ startTime: '14:00', endTime: '15:35', auto: true });
    expect(byRole(after, 'in-arrive')[0]).toMatchObject({ startTime: '15:35', endTime: '15:50', auto: true });
    expect(after.filter((e) => e.category === 'transport')).toHaveLength(3);
  });

  it('activities and restaurants stay exactly as they were', () => {
    const t = loadBuilt();
    const before = nonTransport(t.cities[1].schedule![ARRIVAL]);
    expect(before.length).toBeGreaterThan(0);
    useTripStore.getState().setTransportOut(0, 0);
    expect(nonTransport(day(ARRIVAL))).toEqual(before);
  });

  it('user-added events stay, even one titled like a travel block', () => {
    loadBuilt();
    const s = useTripStore.getState();
    s.addScheduledEvent(1, ARRIVAL, { id: 'mine', title: 'Head to the market', startTime: '17:00', endTime: '18:00', category: 'custom' });
    s.setTransportOut(0, 0);
    expect(day(ARRIVAL).find((e) => e.id === 'mine')).toEqual({
      id: 'mine',
      title: 'Head to the market',
      startTime: '17:00',
      endTime: '18:00',
      category: 'custom',
    });
  });
});

describe('swap updates — departure day (transportOut / return leg)', () => {
  it('swapping the flight home moves head-to and flight blocks', () => {
    loadBuilt();
    useTripStore.getState().setHomeLegAlternative('return', 0); // 11:00 → 18:30
    const after = day(DEPARTURE);
    expect(byRole(after, 'out-head')[0]).toMatchObject({ startTime: '16:30', endTime: '18:30', auto: true });
    expect(byRole(after, 'out-travel')[0]).toMatchObject({ startTime: '18:30', endTime: '22:40', auto: true });
    expect(after.filter((e) => e.category === 'transport')).toHaveLength(2);
  });

  it('the arrival day is not disturbed by a departure swap', () => {
    const t = loadBuilt();
    useTripStore.getState().setHomeLegAlternative('return', 0);
    expect(day(ARRIVAL)).toEqual(t.cities[1].schedule![ARRIVAL]);
  });

  it('an inter-city transportOut on a non-last city follows its swap too', () => {
    const t = makeTrip();
    const rome = t.cities[0];
    const dep = rome.dates.departure;
    const schedule = { [dep]: buildDefaultSchedule(rome, dep, t, 0) };
    useTripStore.setState({ currentTrip: { ...t, cities: [{ ...rome, schedule }, t.cities[1]] } });
    useTripStore.getState().setTransportOut(0, 0);
    const after = useTripStore.getState().currentTrip!.cities[0].schedule![dep];
    expect(byRole(after, 'out-travel')[0]).toMatchObject({ startTime: '14:00', endTime: '15:35' });
  });
});

describe('manual edits are honoured', () => {
  it('editing a generated block drops its auto flag', () => {
    const e: ScheduledEvent = { id: 'a', title: 'Head to X', startTime: '10:00', endTime: '12:00', category: 'transport', auto: true, autoRole: 'out-head' };
    expect(applyUserEdit(e, { startTime: '09:00' })).toMatchObject({ auto: false, autoRole: 'out-head', startTime: '09:00' });
    // A no-op write (same value) is not an edit.
    expect(applyUserEdit(e, { startTime: '10:00' }).auto).toBe(true);
    // Notes are not a move.
    expect(applyUserEdit(e, { notes: 'gate B' }).auto).toBe(true);
  });

  it('a moved block stays where the user put it after a swap, and is not duplicated', () => {
    loadBuilt();
    const s = useTripStore.getState();
    const head = byRole(day(ARRIVAL), 'in-head')[0];
    s.updateScheduledEvent(1, ARRIVAL, head.id, { startTime: '06:45' });
    s.setTransportOut(0, 0);
    const after = day(ARRIVAL);
    const heads = after.filter((e) => /^Head to/.test(e.title));
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({ id: head.id, startTime: '06:45', endTime: '08:00', auto: false });
    // The untouched blocks still follow the new train.
    expect(byRole(after, 'in-travel')[0]).toMatchObject({ startTime: '14:00', auto: true });
    expect(byRole(after, 'in-arrive')[0]).toMatchObject({ startTime: '15:35', auto: true });
  });

  it('swapping back and forth never duplicates blocks', () => {
    loadBuilt();
    const s = useTripStore.getState();
    s.setTransportOut(0, 0);
    s.setTransportOut(0, 0); // and back
    expect(day(ARRIVAL).filter((e) => e.category === 'transport')).toHaveLength(3);
  });
});

describe('legacy trips (events saved before the auto flag)', () => {
  const strip = (events: ScheduledEvent[]) =>
    events.map(({ auto: _a, autoRole: _r, ...rest }) => rest as ScheduledEvent);

  it('recognises untagged generator blocks, re-times and tags them, keeps the rest', () => {
    const t = makeTrip();
    const f = t.cities[1];
    // Saved with the 08:00 train, no flags.
    const legacy = strip(buildDefaultSchedule(f, ARRIVAL, t, 1));
    const now = { ...t, cities: [t.cities[0], { ...f, transportIn: train1400, schedule: { [ARRIVAL]: legacy } }] };
    const next = reconcileDayTransport(now, 1, ARRIVAL)!;
    const transport = next.filter((e) => e.category === 'transport');
    expect(transport.map((e) => [e.autoRole, e.startTime, e.auto])).toEqual([
      ['in-head', '13:30', true],
      ['in-travel', '14:00', true],
      ['in-arrive', '15:35', true],
    ]);
    expect(nonTransport(next)).toEqual(nonTransport(legacy));
  });

  it('a legacy day already on the current transport only gains the tags, then settles', () => {
    const t = makeTrip();
    const f = t.cities[1];
    const legacy = strip(buildDefaultSchedule(f, DEPARTURE, t, 1));
    const now = { ...t, cities: [t.cities[0], { ...f, schedule: { [DEPARTURE]: legacy } }] };
    const next = reconcileDayTransport(now, 1, DEPARTURE)!;
    expect(next.map((e) => e.id)).toEqual(legacy.map((e) => e.id));
    expect(next.filter((e) => e.category === 'transport').every((e) => e.auto === true)).toBe(true);
    const settled = { ...now, cities: [now.cities[0], { ...now.cities[1], schedule: { [DEPARTURE]: next } }] };
    expect(reconcileDayTransport(settled, 1, DEPARTURE)).toBeNull();
  });

  it('a legacy head-to the user had reshaped is kept as theirs', () => {
    const legacy: ScheduledEvent[] = [
      { id: 'h', title: 'Head to Roma Termini', startTime: '06:00', endTime: '08:00', category: 'transport' }, // 120 → generated shape
      { id: 'h2', title: 'Head to Roma Termini', startTime: '05:10', endTime: '08:00', category: 'transport' }, // 170 → reshaped
      { id: 'act', title: 'Uffizi', startTime: '16:00', endTime: '17:30', category: 'activity' },
    ];
    const t = makeTrip();
    const fresh = buildDayTransportContext({ ...t.cities[1], transportIn: train1400 }, ARRIVAL, t, 1).events;
    const next = reconcileDayEvents(legacy, fresh)!;
    const heads = next.filter((e) => /^Head to/.test(e.title));
    expect(heads).toEqual([
      { id: 'h2', title: 'Head to Roma Termini', startTime: '05:10', endTime: '08:00', category: 'transport', auto: false, autoRole: 'in-head' },
    ]);
    expect(next.find((e) => e.id === 'act')).toEqual(legacy[2]);
    expect(byRole(next, 'in-travel')[0].startTime).toBe('14:00');
  });

  it('legacy departure-day blocks map to the outbound slots', () => {
    const t = makeTrip();
    const f = t.cities[1];
    const legacy = strip(buildDefaultSchedule(f, DEPARTURE, t, 1));
    const swapped = { ...t, origin: { ...t.origin!, returnLeg: returnB } };
    const now = { ...swapped, cities: [t.cities[0], { ...f, schedule: { [DEPARTURE]: legacy } }] };
    const next = reconcileDayTransport(now, 1, DEPARTURE)!;
    expect(next.filter((e) => e.category === 'transport').map((e) => [e.autoRole, e.startTime])).toEqual([
      ['out-head', '16:30'],
      ['out-travel', '18:30'],
    ]);
  });
});

describe('DayPlanner', () => {
  function Live({ date }: { date: string }) {
    const trip = useTripStore((s) => s.currentTrip)!;
    return <DayPlanner trip={trip} date={date} city={trip.cities[1]} cityIndex={1} onClose={() => {}} />;
  }

  it('reconciles a stale legacy day on open', () => {
    const t = makeTrip();
    const f = t.cities[1];
    const stale = buildDefaultSchedule(f, ARRIVAL, t, 1).map(({ auto: _a, autoRole: _r, ...e }) => e as ScheduledEvent);
    useTripStore.setState({
      currentTrip: { ...t, cities: [t.cities[0], { ...f, transportIn: train1400, schedule: { [ARRIVAL]: stale } }] },
    });
    render(<Live date={ARRIVAL} />);
    expect(byRole(day(ARRIVAL), 'in-travel')[0].startTime).toBe('14:00');
    expect(screen.getByText('2 PM – 3:35 PM')).toBeInTheDocument();
  });

  it('updates live when the flight is swapped while it is open', () => {
    loadBuilt();
    render(<Live date={DEPARTURE} />);
    expect(screen.getByText('11 AM – 3 PM')).toBeInTheDocument();
    act(() => useTripStore.getState().setHomeLegAlternative('return', 0));
    expect(screen.getByText('6:30 PM – 10:40 PM')).toBeInTheDocument();
    expect(screen.queryByText('11 AM – 3 PM')).toBeNull();
  });

  it('updates live when the trip is replaced wholesale (AI leg refresh path)', () => {
    const t = loadBuilt();
    render(<Live date={ARRIVAL} />);
    const cur = useTripStore.getState().currentTrip!;
    act(() =>
      useTripStore.getState().setTrip({
        ...cur,
        cities: [cur.cities[0], { ...cur.cities[1], transportIn: train1400 }],
      }),
    );
    expect(byRole(day(ARRIVAL), 'in-travel')[0]).toMatchObject({ startTime: '14:00', endTime: '15:35' });
    expect(nonTransport(day(ARRIVAL))).toEqual(nonTransport(t.cities[1].schedule![ARRIVAL]));
  });
});
