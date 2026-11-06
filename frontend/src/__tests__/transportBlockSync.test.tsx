import { renderHook, act } from '@testing-library/react';
import {
  buildDayTransportContext,
  buildDefaultSchedule,
  reconcileDayTransport,
} from '@/lib/dayScheduleDefaults';
import { useTransportBlockSync } from '@/hooks/useTransportBlockSync';
import { useTripStore } from '@/store/tripStore';
import type { Trip, City, Transport, ScheduledEvent } from '@/lib/types';
import { buildTrip } from './fixtures';

/**
 * Calendar reacts to transport changes. Auto travel blocks are derived
 * from the trip's transport and rebuilt when it changes; everything else
 * on the day is left alone.
 */

const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

const train0800: Transport = {
  mode: 'train',
  operator: 'Trenitalia',
  duration: '1h 32m',
  price: 35,
  departTime: '08:00',
  arriveTime: '09:32',
  departDate: '2026-06-18',
  fromStation: 'Roma Termini',
  toStation: 'Firenze S.M.N.',
};
const train1400: Transport = { ...train0800, departTime: '14:00', arriveTime: '15:32' };

function tripWith(inbound: Transport, schedule?: Record<string, ScheduledEvent[]>): Trip {
  const base = buildTrip();
  const city = (c: Partial<City> & { name: string; dates: City['dates'] }) =>
    ({
      country: 'Italy',
      transportIn: emptyTransport,
      transportOut: emptyTransport,
      hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
      hotels: [],
      selectedHotelIndex: 0,
      activities: [],
      restaurants: [],
      vibes: [],
      ...c,
    }) as City;
  return {
    ...base,
    origin: undefined,
    cities: [
      city({ name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' }, transportOut: inbound }),
      city({ name: 'Florence', dates: { arrival: '2026-06-18', departure: '2026-06-20' }, transportIn: inbound, schedule }),
    ],
  };
}

const DAY = '2026-06-18';
const uffizi: ScheduledEvent = { id: 'user-uffizi', title: 'Uffizi', startTime: '17:00', endTime: '19:00', category: 'activity', plannedDurationMin: 120 };
const myNote: ScheduledEvent = { id: 'user-note', title: 'Call mum', startTime: '20:00', endTime: '20:15', category: 'custom' };

describe('auto tagging', () => {
  it('every generated travel block is tagged with the day fingerprint', () => {
    const t = tripWith(train0800);
    const { events } = buildDayTransportContext(t.cities[1], DAY, t, 1);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.auto === 'transport')).toBe(true);
    expect(new Set(events.map((e) => e.autoSig)).size).toBe(1);
  });
  it('activities and meals from the default builder are not tagged', () => {
    const t = tripWith(train0800);
    t.cities[1].activities = ['Duomo'];
    const all = buildDefaultSchedule(t.cities[1], DAY, t, 1);
    expect(all.find((e) => e.title === 'Duomo')?.auto).toBeUndefined();
  });
});

describe('reconcileDayTransport', () => {
  const dayFor = (inbound: Transport) => {
    const t = tripWith(inbound);
    return [...buildDayTransportContext(t.cities[1], DAY, t, 1).events, uffizi, myNote];
  };

  it('no change when the transport is the same', () => {
    const t = tripWith(train0800);
    expect(reconcileDayTransport(dayFor(train0800), t.cities[1], DAY, t, 1)).toBeNull();
  });

  it('a swapped train moves the travel blocks and keeps everything else', () => {
    const t = tripWith(train1400);
    const next = reconcileDayTransport(dayFor(train0800), t.cities[1], DAY, t, 1)!;
    expect(next).not.toBeNull();
    const travel = next.filter((e) => e.auto === 'transport');
    expect(travel.map((e) => [e.title, e.startTime, e.endTime])).toEqual([
      ['Head to Roma Termini', '13:30', '14:00'],
      ['Train Roma Termini → Firenze S.M.N.', '14:00', '15:32'],
      ['Arrive at Firenze S.M.N.', '15:32', '15:47'],
    ]);
    // Same objects for the user's things — not rebuilt, not moved.
    expect(next).toContain(uffizi);
    expect(next).toContain(myNote);
    // Sorted by start.
    expect(next.map((e) => e.startTime)).toEqual([...next.map((e) => e.startTime)].sort());
    // And settled: running again changes nothing.
    expect(reconcileDayTransport(next, t.cities[1], DAY, t, 1)).toBeNull();
  });

  it('a block dragged by hand keeps its time while the train is unchanged…', () => {
    const t = tripWith(train0800);
    const day = dayFor(train0800).map((e) => (e.title.startsWith('Head to') ? { ...e, startTime: '07:00' } : e));
    expect(reconcileDayTransport(day, t.cities[1], DAY, t, 1)).toBeNull();
  });

  it('…and snaps to the new train when the train changes', () => {
    const t = tripWith(train1400);
    const day = dayFor(train0800).map((e) => (e.title.startsWith('Head to') ? { ...e, startTime: '07:00' } : e));
    const next = reconcileDayTransport(day, t.cities[1], DAY, t, 1)!;
    expect(next.find((e) => e.title.startsWith('Head to'))?.startTime).toBe('13:30');
  });

  it('untagged blocks from older saved trips are recognised and rebuilt', () => {
    const t = tripWith(train1400);
    const legacy = dayFor(train0800).map(({ auto, autoSig, ...e }) => e as ScheduledEvent);
    const userTaxi: ScheduledEvent = { id: 'taxi', title: 'Taxi to hotel', startTime: '10:00', endTime: '10:30', category: 'transport' };
    const next = reconcileDayTransport([...legacy, userTaxi], t.cities[1], DAY, t, 1)!;
    expect(next.filter((e) => e.auto === 'transport').map((e) => e.startTime)).toEqual(['13:30', '14:00', '15:32']);
    expect(next).toContain(userTaxi); // a user's own transport event is not ours to move
    expect(next.filter((e) => e.title.startsWith('Train'))).toHaveLength(1); // no duplicates
  });

  describe('planner-placed items the traveller can no longer make', () => {
    // Placed by the planner after the 08:00 train landed (09:32 + 60 min).
    const morningUffizi: ScheduledEvent = { id: 'p-uffizi', title: 'Uffizi', startTime: '10:32', endTime: '12:02', category: 'activity', plannedDurationMin: 90 };
    const lunch: ScheduledEvent = { id: 'p-lunch', title: 'Trattoria', startTime: '12:30', endTime: '13:30', category: 'restaurant', plannedDurationMin: 60 };
    const day = (extra: ScheduledEvent[]) => {
      const t = tripWith(train0800);
      return [...buildDayTransportContext(t.cities[1], DAY, t, 1).events, ...extra];
    };

    it('move into the hours after the new arrival, keeping id and length', () => {
      const t = tripWith(train1400); // lands 15:32 → free from 16:32
      const next = reconcileDayTransport(day([morningUffizi]), t.cities[1], DAY, t, 1)!;
      const u = next.find((e) => e.id === 'p-uffizi')!;
      expect(u.startTime >= '16:32').toBe(true);
      expect(u.plannedDurationMin).toBe(90);
      const [h1, m1] = u.startTime.split(':').map(Number);
      const [h2, m2] = u.endTime.split(':').map(Number);
      expect(h2 * 60 + m2 - (h1 * 60 + m1)).toBe(90);
    });

    it('a meal that no longer fits its window stays put rather than vanishing', () => {
      const t = tripWith(train1400); // lunch window closes 14:30, traveller free from 16:32
      const next = reconcileDayTransport(day([lunch]), t.cities[1], DAY, t, 1)!;
      expect(next.find((e) => e.id === 'p-lunch')).toEqual(lunch);
    });

    it('a block the user resized by hand is never moved', () => {
      const t = tripWith(train1400);
      const resized = { ...morningUffizi, endTime: '12:32' }; // span ≠ plannedDurationMin
      const next = reconcileDayTransport(day([resized]), t.cities[1], DAY, t, 1)!;
      expect(next.find((e) => e.id === 'p-uffizi')).toEqual(resized);
    });

    it("the user's own events are never moved, even when they clash", () => {
      const t = tripWith(train1400);
      const mine: ScheduledEvent = { id: 'mine', title: 'Meet Sara', startTime: '10:00', endTime: '11:00', category: 'custom' };
      expect(reconcileDayTransport(day([mine]), t.cities[1], DAY, t, 1)!).toContainEqual(mine);
    });
  });

  it('a day whose travel blocks the user deleted is left alone', () => {
    const t = tripWith(train1400);
    expect(reconcileDayTransport([uffizi, myNote], t.cities[1], DAY, t, 1)).toBeNull();
  });
});

describe('useTransportBlockSync (store, as the results page runs it)', () => {
  afterEach(() => act(() => useTripStore.setState({ currentTrip: null })));

  it('swapping the leg in the store moves an open day’s travel blocks', () => {
    const t0 = tripWith(train0800);
    const day = [...buildDayTransportContext(t0.cities[1], DAY, t0, 1).events, uffizi];
    act(() => useTripStore.setState({ currentTrip: tripWith(train0800, { [DAY]: day }) }));
    renderHook(() => useTransportBlockSync());

    // Unchanged trip: the hook writes nothing.
    expect(useTripStore.getState().currentTrip!.cities[1].schedule![DAY]).toBe(day);

    // The user picks the 14:00 train on the flowchart.
    act(() => {
      const cur = useTripStore.getState().currentTrip!;
      const cities = cur.cities.map((c, i) =>
        i === 0 ? { ...c, transportOut: train1400 } : i === 1 ? { ...c, transportIn: train1400 } : c,
      );
      useTripStore.setState({ currentTrip: { ...cur, cities } });
    });

    const after = useTripStore.getState().currentTrip!.cities[1].schedule![DAY];
    expect(after.find((e) => e.title.startsWith('Train'))?.startTime).toBe('14:00');
    expect(after).toContain(uffizi);
  });
});
