/**
 * A stay's picks are spread over its days (website audit m6). The planner
 * used to fill each day to the brim, so a long stay spent everything in its
 * first days: Rome, 6 nights, had Mar 11–13 full and Mar 14–15 at "0 events".
 * Now each day takes the picks left divided by the stay days left, still at
 * most one activity per time of day and one of each meal; a stay with picks
 * to spare plans as full days, as before.
 */
import { buildCityScheduleFromSuggestions } from '@/lib/dayScheduleDefaults';
import type { City, ScheduledEvent, Transport, Trip } from '@/lib/types';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { buildTrip } from './fixtures';

const none: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

const cityOf = (name: string, arrival: string, departure: string): City =>
  ({
    name,
    country: 'Italy',
    dates: { arrival, departure },
    transportIn: none,
    transportOut: none,
    hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
    hotels: [],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
  }) as City;

const act = (name: string, timeOfDay: ActivitySuggestion['timeOfDay']): ActivitySuggestion => ({
  name,
  category: 'landmark',
  timeOfDay,
  durationHours: 2,
  reason: 'r',
});
const meal = (name: string, mealType: RestaurantSuggestion['mealType'], cuisine = 'Roman'): RestaurantSuggestion => ({
  name,
  cuisine,
  priceRange: '$$',
  mealType,
  reason: 'r',
});

/** What a 6-night stay is given: 8 activities and 10 restaurants (the planner's caps). */
const ACTS = [
  act('Colosseum', 'morning'),
  act('Vatican Museums', 'morning'),
  act('Pantheon', 'morning'),
  act("St. Peter's dome", 'afternoon'),
  act('Borghese Gallery', 'afternoon'),
  act('Capitoline Museums', 'afternoon'),
  act('Trastevere walk', 'evening'),
  act('Vespa tour', 'evening'),
];
const MEALS = [
  meal('Roscioli', 'lunch'),
  meal('Pizzarium', 'lunch'),
  meal('Bonci', 'lunch'),
  meal('Flavio', 'dinner'),
  meal('Armando', 'dinner'),
  meal('Felice', 'dinner'),
  meal('Sant Eustachio', 'breakfast', 'Café'),
  meal('Roscioli Caffè', 'breakfast', 'Café'),
  meal('Da Enzo', 'any'),
  meal('Marigold', 'any', 'Bakery'),
];

const STAY = ['2027-03-10', '2027-03-11', '2027-03-12', '2027-03-13', '2027-03-14', '2027-03-15'];

const isActivity = (e: ScheduledEvent) => e.category === 'activity';
const isMeal = (e: ScheduledEvent) => e.category === 'restaurant';

/** Rome for 6 nights; `last` makes it the trip's last city (with a fly-home day). */
function plan(acts: ActivitySuggestion[], meals: RestaurantSuggestion[], { last = false, departure = '2027-03-16' } = {}) {
  const rome = cityOf('Rome', '2027-03-10', departure);
  const cities = last ? [rome] : [rome, cityOf('Naples', departure, '2027-03-19')];
  const trip: Trip = { ...buildTrip(), cities, origin: undefined };
  return buildCityScheduleFromSuggestions(acts, meals, rome, 0, trip).schedule;
}

describe('a long stay spreads its picks over its days', () => {
  const schedule = plan(ACTS, MEALS);
  const day = (d: string) => schedule[d] ?? [];

  it('leaves no stay day empty (live: Rome, 6 nights, Mar 14 and 15 at "0 events")', () => {
    for (const d of STAY) {
      expect(day(d).filter(isActivity).length).toBeGreaterThanOrEqual(1);
      expect(day(d).filter(isMeal).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('spreads them evenly: no day has two more of either than another', () => {
    const acts = STAY.map((d) => day(d).filter(isActivity).length);
    const meals = STAY.map((d) => day(d).filter(isMeal).length);
    expect(Math.max(...acts) - Math.min(...acts)).toBeLessThanOrEqual(1);
    expect(Math.max(...meals) - Math.min(...meals)).toBeLessThanOrEqual(1);
  });

  it('still places every pick, each once', () => {
    const titles = STAY.flatMap((d) => day(d)).map((e) => e.title.replace(/ \(.*\)$/, ''));
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.sort()).toEqual([...ACTS.map((a) => a.name), ...MEALS.map((m) => m.name)].sort());
  });

  it('never puts a sit-down dinner at breakfast to fill a day', () => {
    const early = STAY.flatMap((d) => day(d)).filter((e) => isMeal(e) && e.startTime < '11:00');
    expect(early.some((e) => /^Da Enzo/.test(e.title))).toBe(false);
  });

  it('as the last city, uses its stay days and leaves the fly-home day to leaving', () => {
    const last = plan(ACTS, MEALS, { last: true });
    for (const d of STAY) expect((last[d] ?? []).filter(isActivity).length).toBeGreaterThanOrEqual(1);
    expect((last['2027-03-16'] ?? []).filter((e) => isActivity(e) || isMeal(e))).toEqual([]);
  });
});

describe('a short stay with picks to spare plans full days, as before', () => {
  it('two nights, eight activities, ten restaurants: three of each on both days', () => {
    const schedule = plan(ACTS, MEALS, { departure: '2027-03-12' });
    for (const d of ['2027-03-10', '2027-03-11']) {
      expect(schedule[d].filter(isActivity)).toHaveLength(3);
      expect(schedule[d].filter(isMeal)).toHaveLength(3);
    }
  });
});
