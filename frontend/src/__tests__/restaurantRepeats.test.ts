import { syncCitySchedule, syncTripSchedules } from '@/lib/scheduleSync';
import { parseStop } from '@/lib/stayRelay';
import type { City, Trip } from '@/lib/types';
import { buildCity, buildTrip } from './fixtures';

/**
 * Live (2026-11-18): after a stay gained days, the days it gained repeated
 * the restaurants already planned — E. Pellicci for breakfast three mornings
 * running, St. JOHN twice. A restaurant is planned on one day of a stay; a
 * day with nothing new to eat at keeps that meal open.
 */
describe('a stay that runs out of new restaurants', () => {
  const rome = buildCity({
    name: 'Rome',
    dates: { arrival: '2026-06-15', departure: '2026-06-17' },
    activities: ['Colosseum', 'Vatican Museums'],
    restaurants: [
      { name: 'Da Enzo', cuisine: 'Italian', priceRange: '$$' },
      { name: 'Armando', cuisine: 'Roman', priceRange: '$$' },
    ],
  });
  const florence = buildCity({ name: 'Florence', dates: { arrival: '2026-06-17', departure: '2026-06-19' }, activities: ['Uffizi Gallery'], restaurants: [] });
  const base: Trip = { ...buildTrip(), cities: [rome, florence], origin: undefined };

  const restaurantDays = (c: City) => {
    const at = new Map<string, string[]>();
    for (const [d, es] of Object.entries(c.schedule ?? {})) {
      for (const e of es) {
        if (e.category !== 'restaurant') continue;
        const k = parseStop(e).name;
        at.set(k, [...(at.get(k) ?? []), `${d} ${e.startTime}`]);
      }
    }
    return at;
  };

  it('two more nights in Rome: the new days do not repeat a restaurant from another day', () => {
    const laid = syncCitySchedule(base, 0)!;
    const before: Trip = { ...base, cities: [{ ...rome, schedule: laid.schedule, unscheduled: laid.unscheduled }, florence] };
    // Both restaurants are on the stay already.
    expect(Array.from(restaurantDays(before.cities[0]).keys()).sort()).toEqual(['Armando', 'Da Enzo']);
    const after: Trip = {
      ...before,
      cities: [
        { ...before.cities[0], dates: { arrival: '2026-06-15', departure: '2026-06-19' } },
        { ...florence, dates: { arrival: '2026-06-19', departure: '2026-06-21' } },
      ],
    };
    const synced = syncTripSchedules(before, after);
    const romeAfter = synced.cities[0];
    // The stay did grow: its new days are planned.
    expect(Object.keys(romeAfter.schedule ?? {}).sort()).toEqual(expect.arrayContaining(['2026-06-17', '2026-06-18']));
    const repeats = Array.from(restaurantDays(romeAfter).entries()).filter(([, at]) => at.length > 1);
    expect(repeats).toEqual([]);
  });
});
