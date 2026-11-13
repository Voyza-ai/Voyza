/**
 * ROADMAP bug: duplicate AI suggestions across nearby cities (the Uffizi
 * recommended for Rome as well as Florence). Each city's request now names
 * the trip's other stops, and a pick another city already has stays there.
 */
import './mocks';
import { resolvePlaces, searchActivities, searchRestaurants } from '@/lib/api';
import { requestCityPicks, startTripPicks, useTripStore, type CityPicks } from '@/store/tripStore';
import { dedupeAcrossCities, pickKey } from '@/lib/picksDedupe';
import type { City, Trip, Transport } from '@/lib/types';
import { buildTrip } from './fixtures';

const t: Transport = { mode: 'train', operator: '', duration: '', price: 0 };
const cityOf = (name: string, arrival: string, departure: string): City =>
  ({
    name,
    country: 'Italy',
    dates: { arrival, departure },
    transportIn: t,
    transportOut: t,
    hotel: { name: '', rating: 0, pricePerNight: 0, area: '' } as any,
    hotels: [],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
  }) as City;

const tripOf = (): Trip => ({
  ...buildTrip(),
  origin: undefined,
  cities: [cityOf('Florence', '2027-04-01', '2027-04-03'), cityOf('Rome', '2027-04-03', '2027-04-05')],
});

const act = (name: string) => ({ name, category: 'museum' as const, timeOfDay: 'morning' as const, durationHours: 2, reason: 'r' });
const florence: CityPicks = { activities: [act('Uffizi Gallery'), act('Duomo climb')], restaurants: [] };
const rome: CityPicks = { activities: [act('Colosseum'), act('The Uffizi gallery'), act('Colosseum')], restaurants: [] };

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useTripStore.setState({ currentTrip: null, tripPicks: null });
  (resolvePlaces as jest.Mock).mockReset();
  (resolvePlaces as jest.Mock).mockResolvedValue({ provider: 'osm', places: [] });
});

it('treats spelling variants of one place as the same pick', () => {
  expect(pickKey('The Uffizi Gallery')).toBe(pickKey('uffizi  gallery'));
  expect(pickKey('Musée d’Orsay')).toBe(pickKey("Musee d'Orsay"));
});

it('keeps a landmark with the city that has it, and drops repeats inside a list', () => {
  const trip = { cities: [{ ...cityOf('Florence', '', ''), activities: ['Uffizi Gallery'] }, cityOf('Rome', '', '')] };
  expect(dedupeAcrossCities(trip, 'Rome', rome).activities.map((a) => a.name)).toEqual(['Colosseum']);
});

it('end to end: two cities land the same pick, only the first keeps it', async () => {
  startTripPicks(
    tripOf(),
    [
      { city: 'Florence', travelers: 1, nights: 2 },
      { city: 'Rome', travelers: 1, nights: 2 },
    ],
    [Promise.resolve(florence), new Promise<CityPicks>((r) => setTimeout(() => r(rome), 5))],
  );
  await new Promise((r) => setTimeout(r, 30));
  await flush();
  const [f, r] = useTripStore.getState().currentTrip!.cities;
  expect(f.activities).toEqual(['Uffizi Gallery', 'Duomo climb']);
  expect(r.activities).toEqual(['Colosseum']);
});

it("sends each city's request the trip's other stops", async () => {
  (searchActivities as jest.Mock).mockResolvedValue([]);
  (searchRestaurants as jest.Mock).mockResolvedValue([]);
  await requestCityPicks({ city: 'Rome', travelers: 1, nights: 2, otherCities: ['Florence'] });
  expect(searchActivities).toHaveBeenCalledWith(expect.objectContaining({ city: 'Rome', otherCities: ['Florence'] }));
  expect(searchRestaurants).toHaveBeenCalledWith(expect.objectContaining({ city: 'Rome', otherCities: ['Florence'] }));
});
