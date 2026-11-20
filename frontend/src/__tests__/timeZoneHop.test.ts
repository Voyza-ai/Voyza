/**
 * A short flight into an earlier time zone — Paris 10:50 → London 10:48,
 * 58 minutes, as found live for the owner's trip — lands at an earlier clock
 * time than it left. Read as start–end, its block wrapped to midnight like an
 * overnight flight: the planner put nothing on London's arrival afternoon,
 * and the Schedule drew "Arrive at" on top of the flight.
 */
import { buildCityScheduleFromSuggestions, buildDayTransportContext } from '@/lib/dayScheduleDefaults';
import { blockLayout } from '@/lib/blockLayout';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import type { City, Transport, Trip } from '@/lib/types';
import { buildCity, buildTrip } from './fixtures';

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hop: Transport = {
  mode: 'flight', operator: 'American Airlines', duration: '58m', price: 80, from: 'Paris', to: 'London',
  departTime: '10:50', arriveTime: '10:48', departDate: '2027-01-15',
};
const none: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };
const acts: ActivitySuggestion[] = [
  { name: 'British Museum', category: 'museum', timeOfDay: 'morning', durationHours: 3, reason: '' },
  { name: 'Borough Market', category: 'food', timeOfDay: 'afternoon', durationHours: 2, reason: '' },
];
const meals: RestaurantSuggestion[] = [{ name: 'Kiln', cuisine: 'Thai', priceRange: '$$', mealType: 'dinner', reason: '' }];

function trip(): { trip: Trip; london: City } {
  const paris = buildCity({ name: 'Paris', country: 'France', dates: { arrival: '2027-01-12', departure: '2027-01-15' }, transportIn: none, transportOut: hop });
  const london = buildCity({ name: 'London', country: 'United Kingdom', dates: { arrival: '2027-01-15', departure: '2027-01-17' }, transportIn: hop, transportOut: none });
  return { trip: buildTrip({ cities: [paris, london], origin: undefined } as Partial<Trip>), london };
}

it('the arrival afternoon is planned: the flight occupies its flight time, not the rest of the day', () => {
  const { trip: t, london } = trip();
  const ctx = buildDayTransportContext(london, '2027-01-15', t, 1);
  expect(ctx.busy).toContainEqual([toMin('10:50'), toMin('11:48')]);
  const { schedule } = buildCityScheduleFromSuggestions(acts, meals, london, 1, t);
  const stops = schedule['2027-01-15'].filter((e) => e.category !== 'transport');
  expect(stops.length).toBeGreaterThan(0);
  // Not before landing (10:48 local) + 1h, nor over the flight drawn from 10:50.
  for (const e of stops) expect(toMin(e.startTime)).toBeGreaterThanOrEqual(toMin('12:03'));
});

it('the Schedule draws head-to, the flight and the arrival one after another', () => {
  const { trip: t, london } = trip();
  const events = buildDayTransportContext(london, '2027-01-15', t, 1).events;
  const px = (m: number) => m; // a minute a pixel
  const box = blockLayout(events, px, 18);
  const at = (role: string) => box.get(events.find((e) => e.autoRole === role)!.id)!;
  expect(at('in-travel')).toEqual({ top: toMin('10:50'), height: 58 });
  expect(at('in-arrive').top).toBeGreaterThanOrEqual(at('in-travel').top + at('in-travel').height);
  expect(at('in-head').top + at('in-head').height).toBeLessThanOrEqual(at('in-travel').top);
  // The times the traveller reads are the real ones.
  expect(events.find((e) => e.autoRole === 'in-travel')).toMatchObject({ startTime: '10:50', endTime: '10:48', title: 'Flight PAR → LON' });
});
