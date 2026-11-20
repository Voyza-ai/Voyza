import { rankHotels, isCampsite } from '@/lib/hotelScore';
import { hotelFromResult } from '@/lib/hotelShape';

/**
 * Website audit (m8): "hu Roma Camping In Town" — cheap and well reviewed,
 * so it scored best — was the default hotel for a 2-person Culture trip to
 * Rome. A campsite stays in the list and stays choosable; it is never the
 * default.
 */
const h = (name: string, rating: number, pricePerNight: number, extra: Record<string, unknown> = {}) => ({
  name, rating, pricePerNight, reviewCount: 2000, ...extra,
});

describe('isCampsite', () => {
  it.each([
    'hu Roma Camping In Town',
    'Camping Village Roma',
    'Lisbon Campsite',
    'Riverside Campground',
    'Glamping Dolomiti',
    'Caravan Park Amsterdam',
    'Holiday Park Zeeland',
  ])('%s is a campsite', (name) => expect(isCampsite({ name })).toBe(true));

  it.each([
    'Hotel Campo de Fiori',
    'Camp Nou Suites',
    'Hotel Caravanserai',
    'Hilton Garden Inn',
    'Campanile Paris Bercy',
  ])('%s is not', (name) => expect(isCampsite({ name })).toBe(false));

  it("Booking's own property type counts, whatever the name", () => {
    expect(isCampsite({ name: 'Roma Green Village', accommodationType: 'Campsites' })).toBe(true);
    expect(isCampsite({ name: 'Seaside Lodge', accommodationType: 'Holiday parks' })).toBe(true);
    expect(isCampsite({ name: 'Hotel Artemide', accommodationType: 'Hotels' })).toBe(false);
  });
});

describe('rankHotels — a campsite is never the default', () => {
  it('the best-scoring campsite goes after every hotel, and stays in the list', () => {
    const ranked = rankHotels([
      h('hu Roma Camping In Town', 8.9, 61),
      h('Hotel Artemide', 8.8, 138),
      h('Hotel Raphael', 8.6, 161),
    ]);
    expect(ranked.map((x) => x.name)).toEqual(['Hotel Artemide', 'Hotel Raphael', 'hu Roma Camping In Town']);
  });

  it('a distrusted price still sits below the campsite', () => {
    const ranked = rankHotels([
      h('Hotel Glitch', 9.5, 20, { priceSuspect: true }),
      h('Camping Village Roma', 8.9, 60),
      h('Hotel Artemide', 8.8, 138),
    ]);
    expect(ranked.map((x) => x.name)).toEqual(['Hotel Artemide', 'Camping Village Roma', 'Hotel Glitch']);
  });

  it('when every option is a campsite, they keep their own order by score', () => {
    const ranked = rankHotels([h('Camping B', 8.0, 70), h('Camping A', 9.0, 60)]);
    expect(ranked.map((x) => x.name)).toEqual(['Camping A', 'Camping B']);
  });

  it("the search row's property type reaches the hotel and the ranking", () => {
    const hotel = hotelFromResult({
      id: '1', name: 'Roma Green Village', price: 180, pricePerNight: 60, currency: 'USD', rating: 9,
      reviewCount: 900, stars: 0, thumbnail: '', bookingUrl: '', amenities: [], accommodationType: 'Campsites',
    } as any);
    expect(hotel.accommodationType).toBe('Campsites');
    const ranked = rankHotels([{ ...hotel }, h('Hotel Artemide', 8.8, 138)]);
    expect(ranked[0].name).toBe('Hotel Artemide');
  });
});
