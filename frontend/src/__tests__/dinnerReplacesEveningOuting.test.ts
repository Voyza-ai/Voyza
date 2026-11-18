import { insertDinner } from '@/lib/dinnerPlace';
import { applyDinnerProposal } from '@/lib/dinners';
import { syncCitySchedule } from '@/lib/scheduleSync';
import type { DinnerProposal } from '@/lib/api';
import type { ScheduledEvent, Trip } from '@/lib/types';
import { buildTrip } from './fixtures';

/**
 * Live (Paris, Wed Dec 16): the day planner had "Dinner at Bouillon Chartier"
 * 17:00–19:00 — an activity pick that names a dinner — and the chat's dinner
 * plan went on at 19:30 beside it: two dinners one evening. A planned evening
 * outing that names a dinner is that evening's dinner, so the dinner plan
 * takes its place, as it already did for a planned restaurant meal.
 */

const dinner = (over: Partial<ScheduledEvent> = {}): ScheduledEvent => ({
  id: 'dinner-1',
  title: "L'Ami Jean",
  startTime: '19:30',
  endTime: '21:30',
  category: 'restaurant',
  notes: 'Basque-French bistro · $$',
  dinner: {
    restaurant: "L'Ami Jean",
    city: 'Rome',
    partySize: 2,
    status: 'not_booked',
    reserveUrl: 'https://www.google.com/maps/search/?api=1&query=L%27Ami%20Jean%2C%20Paris',
    reserveVia: 'Google Maps',
  },
  ...over,
});

const outing = (category: 'restaurant' | 'activity', over: Partial<ScheduledEvent> = {}): ScheduledEvent => ({
  id: 'o1',
  title: 'Dinner at Bouillon Chartier',
  startTime: '17:00',
  endTime: '19:00',
  category,
  notes: 'Classic Parisian brasserie serving traditional French fare since 1896.',
  plannedDurationMin: 120,
  ...over,
});

const day = (): ScheduledEvent[] => [
  { id: 'a1', title: 'Sainte-Chapelle', startTime: '09:00', endTime: '10:00', category: 'activity', plannedDurationMin: 60 },
  { id: 'r1', title: 'Le Comptoir du Relais (Classic French bistro)', startTime: '12:30', endTime: '14:00', category: 'restaurant', notes: '$$ · lunch', plannedDurationMin: 90 },
];

const eveningDinners = (es: ScheduledEvent[]) =>
  es.filter((e) => (e.category === 'restaurant' || /\bdinner\b/i.test(e.title)) && e.startTime >= '17:00').map((e) => e.title);

describe('a dinner plan replaces a planned evening outing that names a dinner', () => {
  it.each(['restaurant', 'activity'] as const)('"Dinner at Bouillon Chartier" (%s) 17:00–19:00 + dinner at 19:30: one dinner that evening', (category) => {
    const { events } = insertDinner([...day(), outing(category)], dinner(), '2026-12-16');
    expect(eveningDinners(events)).toEqual(["L'Ami Jean"]);
    // The rest of the day is untouched, lunch included.
    expect(events.map((e) => e.title)).toEqual(['Sainte-Chapelle', 'Le Comptoir du Relais (Classic French bistro)', "L'Ami Jean"]);
  });

  it('a daytime "dinner"-named stop is left alone, and so is the traveller\'s own evening block', () => {
    const own: ScheduledEvent = { id: 'u1', title: 'Dinner with Marie', startTime: '17:00', endTime: '18:30', category: 'custom' };
    const lunchy = outing('activity', { id: 'o2', title: 'Dinner-cruise ticket pickup', startTime: '11:00', endTime: '11:30', plannedDurationMin: 30 });
    const { events } = insertDinner([...day(), own, lunchy], dinner(), '2026-12-16');
    expect(events.map((e) => e.title)).toEqual(expect.arrayContaining(['Dinner with Marie', 'Dinner-cruise ticket pickup', "L'Ami Jean"]));
  });

  it('through Accept, and a later sync does not put the outing back on that evening', () => {
    const t: Trip = buildTrip();
    t.cities[0].schedule = { '2026-06-15': [], '2026-06-16': [...day(), outing('restaurant')], '2026-06-17': [] };
    t.cities[0].activities = [...t.cities[0].activities, 'Dinner at Bouillon Chartier'];
    const p: DinnerProposal = { kind: 'dinner', action: 'add', city: 'Rome', before: null, after: { date: '2026-06-16', event: dinner() } };
    const next = applyDinnerProposal(t, p)!;
    expect(eveningDinners(next.cities[0].schedule!['2026-06-16'])).toEqual(["L'Ami Jean"]);
    const synced = syncCitySchedule(next, 0);
    const d16 = (synced?.schedule ?? next.cities[0].schedule!)['2026-06-16'];
    expect(eveningDinners(d16)).toEqual(["L'Ami Jean"]);
  });
});
