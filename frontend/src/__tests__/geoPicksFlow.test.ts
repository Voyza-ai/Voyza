/**
 * The store's two-phase flow: AI picks land (and are scheduled at once), then
 * their POI coordinates land and untouched days are re-planned by geography.
 * A save waits for the coordinates; a failed /places call never blocks it.
 */
import './mocks';
import { resolvePlaces } from '@/lib/api';
import { startTripPicks, tripPicksSettled, useTripStore, type CityPicks } from '@/store/tripStore';
import type { Trip, Transport } from '@/lib/types';
import { buildTrip } from './fixtures';

const t: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };
const tripOf = (): Trip => ({
  ...buildTrip(),
  origin: undefined,
  cities: [
    {
      name: 'Paris',
      country: 'France',
      dates: { arrival: '2026-06-15', departure: '2026-06-16' },
      transportIn: t,
      transportOut: t,
      hotel: { name: '', rating: 0, pricePerNight: 0, area: '' } as any,
      hotels: [],
      selectedHotelIndex: 0,
      activities: [],
      restaurants: [],
      vibes: [],
    },
  ],
});

const picks: CityPicks = {
  activities: [
    { name: 'Louvre', category: 'museum', timeOfDay: 'morning', durationHours: 2, reason: 'r' },
    { name: 'Eiffel Tower', category: 'landmark', timeOfDay: 'afternoon', durationHours: 2, reason: 'r' },
    { name: 'Palais-Royal', category: 'landmark', timeOfDay: 'afternoon', durationHours: 2, reason: 'r' },
  ],
  restaurants: [
    { name: 'Montmartre bistro', cuisine: 'French', priceRange: '$$', mealType: 'lunch', reason: 'r' },
    { name: 'Café near Louvre', cuisine: 'French', priceRange: '$$', mealType: 'lunch', reason: 'r' },
  ],
};

const day = () =>
  (useTripStore.getState().currentTrip!.cities[0].schedule?.['2026-06-15'] ?? []).map((e) => e.title.replace(/ \(.*\)$/, ''));

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useTripStore.setState({ currentTrip: null, tripPicks: null });
  (resolvePlaces as jest.Mock).mockReset();
});

it('re-plans by geography when coordinates land, and a save waits for them', async () => {
  let answer!: (v: any) => void;
  (resolvePlaces as jest.Mock).mockReturnValue(new Promise((r) => (answer = r)));
  startTripPicks(tripOf(), [{ city: 'Paris', travelers: 1, nights: 1 }], [Promise.resolve(picks)]);
  await flush();
  await flush();

  // Picks are on screen at once, in queue order.
  expect(day()).toEqual(['Louvre', 'Montmartre bistro', 'Eiffel Tower']);
  expect(resolvePlaces).toHaveBeenCalledWith(
    expect.objectContaining({
      city: 'Paris',
      country: 'France',
      items: expect.arrayContaining([expect.objectContaining({ name: 'Café near Louvre', kind: 'restaurant' })]),
    }),
    expect.anything(),
  );

  let settled = false;
  tripPicksSettled().then(() => (settled = true));
  await flush();
  expect(settled).toBe(false);

  answer({
    provider: 'osm',
    places: [
      { name: 'Louvre', lat: 48.8611, lng: 2.338, placeId: 'osm:R1' },
      { name: 'Eiffel Tower', lat: 48.8584, lng: 2.2945, placeId: 'osm:W4' },
      { name: 'Palais-Royal', lat: 48.8638, lng: 2.337, placeId: 'osm:W5' },
      { name: 'Montmartre bistro', lat: 48.8867, lng: 2.3431, placeId: 'osm:N3' },
      { name: 'Café near Louvre', lat: 48.8625, lng: 2.336, placeId: 'osm:N2' },
    ],
  });
  await flush();
  await flush();

  expect(settled).toBe(true);
  expect(day()).toEqual(['Louvre', 'Café near Louvre', 'Palais-Royal']);
  const city = useTripStore.getState().currentTrip!.cities[0];
  expect(city.restaurants.find((r) => r.name === 'Café near Louvre')).toMatchObject({ lat: 48.8625, lng: 2.336, placeId: 'osm:N2' });
  expect(city.schedule!['2026-06-15'][0]).toMatchObject({ lat: 48.8611, placeId: 'osm:R1' });
});

it('a failed /places call settles and leaves the queue-order schedule', async () => {
  (resolvePlaces as jest.Mock).mockRejectedValue(new Error('down'));
  startTripPicks(tripOf(), [{ city: 'Paris', travelers: 1, nights: 1 }], [Promise.resolve(picks)]);
  await flush();
  await flush();
  await flush();
  await expect(tripPicksSettled()).resolves.toBe(false);
  expect(day()).toEqual(['Louvre', 'Montmartre bistro', 'Eiffel Tower']);
});
