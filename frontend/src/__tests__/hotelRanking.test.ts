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
  { name: 'Hotel Aldobrandini', rating: 8.1, reviewCount: 49, pricePerNight: 5383.47 },
  { name: 'Radisson Blu Hotel, Florence', rating: 8.5, reviewCount: 1316, pricePerNight: 170.31 },
  { name: 'B&B Hotel Firenze Laurus Al Duomo', rating: 9.1, reviewCount: 824, pricePerNight: 301.99 },
  { name: 'Plus Florence Hotel & Hostel', rating: 8.5, reviewCount: 20721, pricePerNight: 159.87 },
  { name: 'Hotel David', rating: 9.7, reviewCount: 1059, pricePerNight: 204.32 },
  { name: 'Burchiello b&b', rating: 9.3, reviewCount: 640, pricePerNight: 114.51 },
  { name: 'A Modino Florence Centre Suites', rating: 9.5, reviewCount: 91, pricePerNight: 184.98 },
  { name: 'Keys of Italy - Essential by Faenza', rating: 8.5, reviewCount: 8, pricePerNight: 161.13 },
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

/**
 * `rating^2.8` treated every rating as equally believable. These pin the
 * review-count discount, including the asymmetry, which is the part that would
 * be easy to "simplify" back into a bug.
 */
describe('review-count confidence', () => {
  it('stops a thinly-reviewed 9.5 outranking a well-reviewed 9.7', () => {
    const ranked = rankHotels(FLORENCE_PRODUCTION).map((h) => h.name);

    // A Modino: 9.5 from 91 reviews. Hotel David: 9.7 from 1059.
    expect(ranked.indexOf('Hotel David')).toBeLessThan(
      ranked.indexOf('A Modino Florence Centre Suites'),
    );
  });

  it('does NOT promote a below-average hotel just because it has few reviews', () => {
    // The regression that symmetric shrinkage introduces. "Keys of Italy" is
    // 8.5 from 8 reviews against a set mean near 9.0 — textbook shrinkage pulls
    // it UP to ~8.94 and it climbs from 5th to 2nd. It must not move up.
    const ranked = rankHotels(FLORENCE_PRODUCTION).map((h) => h.name);
    const thin = ranked.indexOf('Keys of Italy - Essential by Faenza');

    expect(thin).toBeGreaterThan(ranked.indexOf('Hotel David'));
    expect(thin).toBeGreaterThan(ranked.indexOf('Burchiello b&b'));
  });

  it('barely touches a hotel with plenty of reviews', () => {
    const plenty = hotelScore({ rating: 9.3, reviewCount: 640, pricePerNight: 100 }, 8.97);
    const unweighted = hotelScore({ rating: 9.3, pricePerNight: 100 });

    expect(plenty / unweighted).toBeGreaterThan(0.99);
  });

  it('heavily discounts a rating backed by a handful of reviews', () => {
    const thin = hotelScore({ rating: 9.9, reviewCount: 3, pricePerNight: 100 }, 8.5);
    const unweighted = hotelScore({ rating: 9.9, pricePerNight: 100 });

    expect(thin).toBeLessThan(unweighted * 0.8);
  });

  it('leaves scoring unchanged when reviewCount is absent', () => {
    // Demo data and any caller without review counts must behave as before.
    const withCount = hotelScore({ rating: 9, pricePerNight: 100 }, 8);
    const withoutPrior = hotelScore({ rating: 9, pricePerNight: 100 });

    expect(withCount).toBe(withoutPrior);
  });

  it('ignores a negative or non-finite reviewCount rather than corrupting the score', () => {
    const base = hotelScore({ rating: 9, pricePerNight: 100 });

    expect(hotelScore({ rating: 9, reviewCount: -5, pricePerNight: 100 }, 8)).toBe(base);
    expect(hotelScore({ rating: 9, reviewCount: Number.NaN, pricePerNight: 100 }, 8)).toBe(base);
  });

  it('survives a zero-review listing', () => {
    const score = hotelScore({ rating: 10, reviewCount: 0, pricePerNight: 100 }, 8.5);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeLessThan(hotelScore({ rating: 10, pricePerNight: 100 }));
  });
});

describe('locationScore', () => {
  it('is inert on real data, where nothing populates it', () => {
    // Every live hotel falls to the 0.7 default, so locTerm is 0.94 for all of
    // them — a constant multiplier, which cannot change a sort order. This
    // pins that so it is obvious if someone starts feeding the field: these
    // orderings would then diverge, and that is the signal, not a failure.
    const noLocation = FLORENCE_PRODUCTION.map(({ name, rating, reviewCount, pricePerNight }) => ({
      name,
      rating,
      reviewCount,
      pricePerNight,
    }));
    const allDefaulted = noLocation.map((h) => ({ ...h, locationScore: 0.7 }));

    expect(rankHotels(noLocation).map((h) => h.name)).toEqual(
      rankHotels(allDefaulted).map((h) => h.name),
    );
  });

  it('still works when something does supply it', () => {
    // Not dead code — the gap is the caller, not the formula. Demo data feeds
    // it, and a future source would too.
    const central = hotelScore({ rating: 9, pricePerNight: 200, locationScore: 1 });
    const remote = hotelScore({ rating: 9, pricePerNight: 200, locationScore: 0 });

    expect(central).toBeGreaterThan(remote);
    expect(central / remote).toBeCloseTo(1.25, 2);
  });
});
