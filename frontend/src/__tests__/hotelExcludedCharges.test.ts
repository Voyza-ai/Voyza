import { hotelFromResult } from '@/lib/hotelShape';
import { effectiveHotel, liveTripTotal } from '@/lib/tripTotals';
import type { City, Trip } from '@/lib/types';

/**
 * Booking's excluded charges (city tax, cleaning and service fees) reach the
 * trip total.
 *
 * The backend now sets `taxesPerNight` on a hotel result when Booking's
 * breakdown lists charges excluded from the quoted price. The trip side
 * already knew what to do with it — `effectiveHotel` adds
 * `taxesPerNight × nights` and CityDetailPanel shows "incl. $X taxes" — but
 * `hotelFromResult`, the one mapping every planner path goes through, copied
 * seven fields and not that one, so it died at the boundary.
 *
 * Numbers: Kraft Hotel, Paris, two nights — $450.04 for the stay, and €32.52
 * of city tax excluded from it ($40.65, so $20.33 a night).
 */
const result = {
  id: '1001',
  name: 'Kraft Hotel',
  price: 450.04,
  pricePerNight: 225.02,
  currency: 'USD',
  rating: 8.6,
  reviewCount: 1200,
  stars: 3,
  thumbnail: '',
  bookingUrl: 'https://www.booking.com/hotel/fr/kraft.html',
  amenities: [],
  taxesPerNight: 20.33,
};

const city = (hotel: ReturnType<typeof hotelFromResult>): City =>
  ({
    name: 'Paris',
    country: 'France',
    dates: { arrival: '2027-01-11', departure: '2027-01-13' },
    transportIn: {} as any,
    transportOut: { price: 0 } as any,
    hotel,
    hotels: [hotel],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
  }) as unknown as City;

describe('hotelFromResult carries Booking’s excluded charges', () => {
  it('carries taxesPerNight through', () => {
    expect(hotelFromResult(result).taxesPerNight).toBe(20.33);
  });

  it('the stay and the trip total include them: (225.02 + 20.33) × 2 nights', () => {
    const c = city(hotelFromResult(result));
    const eff = effectiveHotel(c);
    expect(eff.roomSubtotal).toBeCloseTo(450.04, 2);
    expect(eff.taxesSubtotal).toBeCloseTo(40.66, 2);
    expect(eff.total).toBeCloseTo(490.7, 2);

    const trip = { cities: [c], travelers: 2 } as unknown as Trip;
    expect(liveTripTotal(trip)).toBe(491);
  });

  it('0 is kept: Booking said nothing is excluded', () => {
    expect(hotelFromResult({ ...result, taxesPerNight: 0 }).taxesPerNight).toBe(0);
  });

  it('absent stays absent — a result without a breakdown maps exactly as before', () => {
    const { taxesPerNight, ...bare } = result;
    const mapped = hotelFromResult(bare);
    expect(mapped).not.toHaveProperty('taxesPerNight');
    expect(effectiveHotel(city(mapped)).total).toBeCloseTo(450.04, 2);
  });

  it.each([NaN, -5, Infinity, '12' as unknown as number])('a value that is not a real charge (%p) is dropped, never added', (bad) => {
    const mapped = hotelFromResult({ ...result, taxesPerNight: bad });
    expect(mapped).not.toHaveProperty('taxesPerNight');
  });

  it('survives the JSON round trip a saved trip goes through', () => {
    const restored = JSON.parse(JSON.stringify(hotelFromResult(result)));
    expect(restored.taxesPerNight).toBe(20.33);
  });
});
