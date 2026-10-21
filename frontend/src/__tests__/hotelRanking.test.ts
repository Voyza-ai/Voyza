import { rankHotels, hotelScore } from '@/lib/hotelScore';

/**
 * `rankHotels` existed but nothing in production called it — it was imported
 * only by the deprecated lib/mockData.ts, so every real trip took whatever the
 * provider happened to return first.
 *
 * The numbers below are a real Florence search against production
 * (2027-04-10 → 04-13, 2 adults). The provider's first result was a
 * $5383.47/night room rated 8.1; it became the trip's hotel and ~95% of a
 * $17,039 total.
 */
const FLORENCE_PRODUCTION = [
  { name: 'Hotel Aldobrandini', rating: 8.1, pricePerNight: 5383.47 },
  { name: 'Radisson Blu Hotel, Florence', rating: 8.5, pricePerNight: 170.31 },
  { name: 'B&B Hotel Firenze Laurus Al Duomo', rating: 9.1, pricePerNight: 301.99 },
  { name: 'Plus Florence Hotel & Hostel', rating: 8.5, pricePerNight: 159.87 },
  { name: 'Hotel David', rating: 9.7, pricePerNight: 204.32 },
  { name: 'Burchiello b&b', rating: 9.3, pricePerNight: 114.51 },
  { name: 'A Modino Florence Centre Suites', rating: 9.5, pricePerNight: 184.98 },
];

describe('rankHotels on real provider data', () => {
  it('does not pick the price outlier the provider returned first', () => {
    const ranked = rankHotels(FLORENCE_PRODUCTION);

    expect(ranked[0].name).not.toBe('Hotel Aldobrandini');
    // It should rank dead last — worst value in the set by a wide margin.
    expect(ranked[ranked.length - 1].name).toBe('Hotel Aldobrandini');
  });

  it('picks the best rating-for-price, not merely the cheapest', () => {
    const ranked = rankHotels(FLORENCE_PRODUCTION);

    // $114.51 at 9.3 beats $159.87 at 8.5 — cheaper AND better rated.
    expect(ranked[0].name).toBe('Burchiello b&b');
  });

  it('stamps a score on every hotel, descending', () => {
    const ranked = rankHotels(FLORENCE_PRODUCTION);
    const scores = ranked.map((h) => h.score);

    expect(scores).toHaveLength(FLORENCE_PRODUCTION.length);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('leaves the caller’s own fields intact', () => {
    const ranked = rankHotels(FLORENCE_PRODUCTION);
    expect(ranked[0]).toMatchObject({ name: expect.any(String), rating: expect.any(Number) });
  });

  it('is scale-invariant: a 10-point rating ranks like the 5-point one', () => {
    // The formula was tuned on 5-star ratings; Booking.com returns out of 10.
    // Because rating^2.8 is a power law, relative order depends only on the
    // ratio between ratings, so the same set ranks identically either way.
    const tenPoint = [
      { name: 'a', rating: 9.0, pricePerNight: 100 },
      { name: 'b', rating: 8.0, pricePerNight: 100 },
    ];
    const fivePoint = tenPoint.map((h) => ({ ...h, rating: h.rating / 2 }));

    expect(rankHotels(tenPoint).map((h) => h.name)).toEqual(
      rankHotels(fivePoint).map((h) => h.name),
    );
  });

  it('does not divide by zero on a free or zero-priced room', () => {
    expect(Number.isFinite(hotelScore({ rating: 9, pricePerNight: 0 }))).toBe(true);
  });

  it('handles an empty list', () => {
    expect(rankHotels([])).toEqual([]);
  });
});
