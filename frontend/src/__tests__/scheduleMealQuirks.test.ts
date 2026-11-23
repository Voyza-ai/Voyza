/**
 * Quirks the owner saw in auto-built day plans (live, Paris & London,
 * 2026-11-17):
 *
 *  - breakfast at a sit-down restaurant: Le Comptoir du Relais (classic
 *    bistro) and Septime ($$$$) at 08:00, because a pick the AI marked "any"
 *    meal could fill breakfast;
 *  - two dinners on one evening: "The Ledbury 18:00 | Borough Market food tour
 *    20:45", "Bouillon Chartier 18:00 | Dinner at Bouillon Chartier 20:25";
 *  - daytime stops at night: Marché des Enfants Rouges at 20:31, a walking tour
 *    at 20:15 on an arrival day.
 */

import { buildCityScheduleFromSuggestions, buildDefaultSchedule } from '@/lib/dayScheduleDefaults';
import { syncCitySchedule } from '@/lib/scheduleSync';
import type { City, ScheduledEvent, Transport, Trip } from '@/lib/types';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { buildTrip } from './fixtures';

const DAYTIME_END_MIN = 19 * 60 + 30;
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};
const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

function cityOf(overrides: Partial<City> & { name: string; dates: City['dates'] }): City {
  return {
    country: 'France',
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

const act = (name: string, timeOfDay: ActivitySuggestion['timeOfDay'], hours: number, category: ActivitySuggestion['category'] = 'landmark'): ActivitySuggestion => ({
  name,
  category,
  timeOfDay,
  durationHours: hours,
  reason: 'worth it',
});
const spot = (name: string, cuisine: string, priceRange: RestaurantSuggestion['priceRange'], mealType: RestaurantSuggestion['mealType']): RestaurantSuggestion => ({
  name,
  cuisine,
  priceRange,
  mealType,
  reason: 'good',
});

function build(activities: ActivitySuggestion[], restaurants: RestaurantSuggestion[], dates = { arrival: '2027-01-13', departure: '2027-01-16' }, city: Partial<City> = {}) {
  const c = cityOf({ name: 'Paris', dates, ...city });
  const trip: Trip = { ...buildTrip(), cities: [c, cityOf({ name: 'London', dates: { arrival: dates.departure, departure: '2027-01-20' } })], origin: undefined };
  return buildCityScheduleFromSuggestions(activities, restaurants, trip.cities[0], 0, trip).schedule;
}

const meals = (schedule: Record<string, ScheduledEvent[]>) =>
  Object.entries(schedule).flatMap(([d, es]) => es.filter((e) => e.category === 'restaurant').map((e) => ({ d, e, start: toMin(e.startTime) })));

describe('breakfast', () => {
  it('is never a sit-down restaurant marked "any" meal (live: Le Comptoir du Relais and Septime at 08:00)', () => {
    const s = build(
      [],
      [
        spot('Septime', 'Modern French', '$$$$', 'any'),
        spot('Le Comptoir du Relais', 'Classic bistro', '$$', 'any'),
        spot("L'Ami Jean", 'Basque-French bistro', '$$', 'any'),
        spot('Bouillon Chartier', 'Traditional French', '$', 'any'),
      ],
    );
    const early = meals(s).filter((m) => m.start < 11 * 60).map((m) => `${m.d} ${m.e.startTime} ${m.e.title}`);
    expect(early).toEqual([]);
    // They still make lunches and dinners.
    expect(meals(s).length).toBeGreaterThanOrEqual(4);
  });

  it('can be a café, bakery or crêperie the AI marked "any", or anything it marked breakfast', () => {
    const s = build(
      [],
      [
        spot('Septime', 'Modern French', '$$$$', 'any'),
        spot('Breizh Café', 'Breton crêpes', '$', 'any'),
        spot('Du Pain et des Idées', 'Bakery', '$', 'breakfast'),
        spot('Clown Bar', 'Neo-bistro', '$$', 'lunch'),
        spot("L'Ami Jean", 'Basque-French bistro', '$$', 'dinner'),
      ],
    );
    const breakfasts = meals(s)
      .filter((m) => m.start < 11 * 60)
      .sort((a, b) => a.d.localeCompare(b.d))
      .map((m) => m.e.title.replace(/ \(.*\)$/, ''));
    // The one marked breakfast first, then the crêperie — never Septime, ahead of it in the queue.
    expect(breakfasts).toEqual(['Du Pain et des Idées', 'Breizh Café']);
    expect(meals(s).find((m) => /^Septime/.test(m.e.title))!.start).toBeGreaterThanOrEqual(11 * 60);
  });
});

describe('one dinner an evening', () => {
  it('an evening food outing is that evening\'s dinner (live: The Ledbury 18:00, then Borough Market food tour 20:45)', () => {
    const s = build(
      [act('Borough Market food crawl', 'evening', 2, 'food')],
      [spot('The Clove Club', 'modern British', '$$$$', 'dinner')],
      { arrival: '2027-01-13', departure: '2027-01-14' },
    );
    const evenings = meals(s).filter((m) => m.d === '2027-01-13' && m.start >= 17 * 60).map((m) => m.e.title);
    expect(evenings).toEqual(['Borough Market food crawl']);
  });

  it('"Dinner at L\'Ami Jean" is an evening, its restaurant is not planned again, and no evening gets two dinners', () => {
    // As a re-plan offers a curated name: no time of day of its own.
    const s = build(
      [act("Dinner at L'Ami Jean", 'afternoon', 1.5, 'experience'), act('Musée Rodin', 'morning', 2)],
      [spot("L'Ami Jean", 'Basque-French bistro', '$$', 'dinner'), spot('Septime', 'Modern French', '$$$$', 'dinner'), spot('Clown Bar', 'Neo-bistro', '$$', 'dinner')],
    );
    const all = Object.entries(s).flatMap(([d, es]) => es.map((e) => ({ d, e })));
    const outing = all.find(({ e }) => e.title === "Dinner at L'Ami Jean");
    expect(outing).toBeDefined();
    expect(toMin(outing!.e.startTime)).toBeGreaterThanOrEqual(17 * 60);
    expect(all.filter(({ e }) => /^L'Ami Jean/.test(e.title))).toEqual([]);
    for (const [d, es] of Object.entries(s)) {
      const dinners = es.filter((e) => e.category === 'restaurant' && toMin(e.startTime) >= 17 * 60).map((e) => e.title);
      expect({ d, dinners: dinners.length <= 1 ? 'ok' : dinners }).toEqual({ d, dinners: 'ok' });
    }
  });
});

describe('daytime stops stay in the daytime', () => {
  it('an afternoon sight does not run into the night on a late-arrival day; it goes to a later day', () => {
    const lateTrain: Transport = { mode: 'train', operator: 'Eurostar', duration: '2h 20m', price: 90, departTime: '14:01', arriveTime: '17:20', departDate: '2027-01-13', fromStation: 'London St Pancras', toStation: 'Paris Gare du Nord' };
    const s = build(
      [act("Musée d'Orsay", 'afternoon', 3), act('Le Marais walking tour', 'morning', 2)],
      [],
      { arrival: '2027-01-13', departure: '2027-01-16' },
      { transportIn: lateTrain },
    );
    const late = Object.entries(s).flatMap(([d, es]) =>
      es.filter((e) => e.category === 'activity' && toMin(e.endTime) > DAYTIME_END_MIN).map((e) => `${d} ${e.startTime}–${e.endTime} ${e.title}`),
    );
    expect(late).toEqual([]);
    const placed = Object.values(s).flat().map((e) => e.title);
    expect(placed).toContain("Musée d'Orsay");
    expect(placed).toContain('Le Marais walking tour');
  });

  it('an evening activity may still run late', () => {
    const s = build([act('Moulin Rouge show', 'evening', 2.5, 'nightlife'), act('Seine night cruise', 'evening', 1)], [], { arrival: '2027-01-13', departure: '2027-01-14' });
    const titles = Object.values(s).flat().map((e) => e.title);
    expect(titles).toContain('Moulin Rouge show');
  });
});

/**
 * The same rules where day plans are filled again after an edit
 * (lib/scheduleSync.ts): a day never planned takes the city's unused picks.
 */
describe('after an edit (scheduleSync fill)', () => {
  const lateTrain: Transport = { mode: 'train', operator: 'Eurostar', duration: '2h 20m', price: 90, departTime: '14:01', arriveTime: '17:20', departDate: '2027-01-13', fromStation: 'London St Pancras', toStation: 'Paris Gare du Nord' };
  const syncOf = (city: Partial<City>) => {
    const c = cityOf({ name: 'Paris', dates: { arrival: '2027-01-13', departure: '2027-01-16' }, ...city });
    const trip: Trip = { ...buildTrip(), cities: [c, cityOf({ name: 'London', dates: { arrival: '2027-01-16', departure: '2027-01-20' } })], origin: undefined };
    const out = syncCitySchedule(trip, 0);
    return out?.schedule ?? c.schedule ?? {};
  };

  it('a picked sight is not put on the evening of a late arrival (live: a walking tour at 20:15)', () => {
    const s = syncOf({ transportIn: lateTrain, activities: ['Le Marais walking tour', "Musée d'Orsay"] });
    const late = Object.entries(s).flatMap(([d, es]) =>
      es.filter((e) => e.category === 'activity' && toMin(e.endTime) > DAYTIME_END_MIN).map((e) => `${d} ${e.startTime}–${e.endTime} ${e.title}`),
    );
    expect(late).toEqual([]);
    const titles = Object.values(s).flat().map((e) => e.title);
    expect(titles).toContain('Le Marais walking tour');
  });

  it('a stop a changed arrival pushes off its slot is not moved to the night (live: Marché des Enfants Rouges at 20:31)', () => {
    // The train now lands at 13:00: the market planned 13:15–15:15 sits on the
    // arrival transfer, and the rest of the day is full until 20:45.
    const noonTrain: Transport = { ...lateTrain, departTime: '10:40', arriveTime: '13:00' };
    const planned = (title: string, start: string, end: string, category: 'activity' | 'restaurant', notes?: string): ScheduledEvent => ({
      id: title, title, startTime: start, endTime: end, category, notes, plannedDurationMin: toMin(end) - toMin(start),
    });
    const s = syncOf({
      transportIn: noonTrain,
      activities: ['Marché des Enfants Rouges', "Musée d'Orsay"],
      restaurants: [{ name: 'Septime', cuisine: 'Modern French', priceRange: '$$$$' }],
      schedule: {
        '2027-01-13': [
          planned('Marché des Enfants Rouges', '13:15', '15:15', 'restaurant', 'Food market'),
          planned("Musée d'Orsay", '15:30', '18:30', 'activity'),
          planned('Septime (Modern French)', '18:45', '20:45', 'restaurant', '$$$$ · Tasting menu'),
        ],
      },
    });
    const market = Object.entries(s).flatMap(([d, es]) => es.filter((e) => e.title === 'Marché des Enfants Rouges').map((e) => `${d} ${e.startTime}–${e.endTime}`));
    expect(market).toHaveLength(1);
    const [, time] = market[0].split(' ');
    expect(toMin(time.split('–')[1])).toBeLessThanOrEqual(DAYTIME_END_MIN);
  });

  it('days filled from the picks around a planned one: "Dinner at …" is an evening, never also a meal, one dinner an evening', () => {
    const s = syncOf({
      activities: ["Dinner at L'Ami Jean", 'Musée Rodin', 'Sainte-Chapelle', 'Canal Saint-Martin stroll'],
      restaurants: [
        { name: "L'Ami Jean", cuisine: 'Basque-French bistro', priceRange: '$$' },
        { name: 'Septime', cuisine: 'Modern French', priceRange: '$$$$' },
        { name: 'Clown Bar', cuisine: 'Neo-bistro', priceRange: '$$' },
      ],
      // The first day was planned; the other two never were (no key).
      schedule: {
        '2027-01-13': [{ id: 'p1', title: "Musée d'Orsay", startTime: '10:00', endTime: '13:00', category: 'activity', plannedDurationMin: 180 }],
      },
    });
    const all = Object.entries(s).flatMap(([d, es]) => es.map((e) => ({ d, e })));
    const outing = all.find(({ e }) => e.title === "Dinner at L'Ami Jean");
    expect(outing).toBeDefined();
    expect(toMin(outing!.e.startTime)).toBeGreaterThanOrEqual(17 * 60);
    expect(all.filter(({ e }) => /^L'Ami Jean/.test(e.title))).toEqual([]);
    for (const [d, es] of Object.entries(s)) {
      const dinners = es.filter((e) => e.category === 'restaurant' && toMin(e.startTime) >= 17 * 60).map((e) => e.title);
      expect({ d, dinners: dinners.length <= 1 ? 'ok' : dinners }).toEqual({ d, dinners: 'ok' });
    }
  });

  it('"Dinner at L\'Ami Jean" is an evening, its restaurant is not a second meal, and no evening has two dinners', () => {
    const s = syncOf({
      activities: ["Dinner at L'Ami Jean", 'Musée Rodin', 'Sainte-Chapelle'],
      restaurants: [
        { name: "L'Ami Jean", cuisine: 'Basque-French bistro', priceRange: '$$' },
        { name: 'Septime', cuisine: 'Modern French', priceRange: '$$$$' },
        { name: 'Clown Bar', cuisine: 'Neo-bistro', priceRange: '$$' },
      ],
    });
    const all = Object.entries(s).flatMap(([d, es]) => es.map((e) => ({ d, e })));
    const outing = all.find(({ e }) => e.title === "Dinner at L'Ami Jean");
    expect(outing).toBeDefined();
    expect(toMin(outing!.e.startTime)).toBeGreaterThanOrEqual(17 * 60);
    expect(all.filter(({ e }) => e.title === "L'Ami Jean")).toEqual([]);
    for (const [d, es] of Object.entries(s)) {
      const dinners = es.filter((e) => e.category === 'restaurant' && toMin(e.startTime) >= 17 * 60).map((e) => e.title);
      expect({ d, dinners: dinners.length <= 1 ? 'ok' : dinners }).toEqual({ d, dinners: 'ok' });
    }
  });
});

/** A day with no plan yet, from the city's curated lists (lib/dayScheduleDefaults buildDefaultSchedule). */
describe('a day laid out from the curated lists', () => {
  it('"Dinner at L\'Ami Jean" is the dinner, L\'Ami Jean is not lunch, and sights end by the evening', () => {
    const c = cityOf({
      name: 'Paris',
      dates: { arrival: '2027-01-13', departure: '2027-01-16' },
      activities: ["Dinner at L'Ami Jean", 'Musée Rodin', 'Sainte-Chapelle', 'Canal Saint-Martin stroll', 'Atelier des Lumières', 'Père Lachaise', 'Opera Garnier tour', 'Pompidou'],
      restaurants: [
        { name: "L'Ami Jean", cuisine: 'Basque-French bistro', priceRange: '$$' },
        { name: 'Breizh Café', cuisine: 'Breton crêpes', priceRange: '$' },
        { name: 'Septime', cuisine: 'Modern French', priceRange: '$$$$' },
      ],
    });
    const trip: Trip = { ...buildTrip(), cities: [c, cityOf({ name: 'London', dates: { arrival: '2027-01-16', departure: '2027-01-20' } })], origin: undefined };
    const es = buildDefaultSchedule(trip.cities[0], '2027-01-14', trip, 0);
    const line = (e: ScheduledEvent) => `${e.startTime}–${e.endTime} ${e.title}`;
    expect(es.filter((e) => e.title === "L'Ami Jean").map(line)).toEqual([]);
    const outing = es.find((e) => e.title === "Dinner at L'Ami Jean");
    expect(outing && toMin(outing.startTime)).toBeGreaterThanOrEqual(17 * 60);
    expect(es.filter((e) => e.category === 'restaurant' && toMin(e.startTime) >= 17 * 60).map(line)).toHaveLength(1);
    expect(es.filter((e) => e.category === 'activity' && toMin(e.endTime) > DAYTIME_END_MIN).map(line)).toEqual([]);
  });
});
