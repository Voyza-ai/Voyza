jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

import { dropPriceOutliers, dropImplausiblePrices } from '../services/hotels';

/**
 * Guard against a provider row that is wildly out of line with the rest of its
 * own search. The case this was built from, measured against production:
 * Florence 2027-04-10 → 04-13 for 2 adults returned "Hotel Aldobrandini" at
 * $5383.47/night against a $267 median, and the provider returned it first —
 * so it became the trip's hotel and 95% of a $17,039 total.
 */
const hotel = (name: string, pricePerNight: number, stars = 0) =>
  ({
    name,
    rating: 8,
    stars,
    pricePerNight,
    price: pricePerNight * 3,
    currency: 'USD',
  }) as any;

describe('dropPriceOutliers', () => {
  it('drops the production Florence outlier and keeps everything else', () => {
    // Real prices and order from the live API.
    const hotels = [
      hotel('Hotel Aldobrandini', 5383.47),
      hotel('Radisson Blu Hotel, Florence', 170.31),
      hotel('B&B Hotel Firenze Laurus Al Duomo', 301.99),
      hotel('Plus Florence Hotel & Hostel', 159.87),
      hotel('Hotel David', 204.32),
      hotel('Bed & Breakfast Il Bargello', 197.58),
    ];

    const kept = dropPriceOutliers(hotels, 'Florence');

    expect(kept.map((h) => h.name)).not.toContain('Hotel Aldobrandini');
    expect(kept).toHaveLength(5);
  });

  it('keeps an expensive city where the whole set is high', () => {
    // A genuinely pricey search: high median, tight spread, nothing junk.
    const hotels = [
      hotel('Aman', 1800),
      hotel('Four Seasons', 1500),
      hotel('Peninsula', 1650),
      hotel('Mandarin Oriental', 2100),
      hotel('Ritz', 1400),
    ];

    expect(dropPriceOutliers(hotels, 'Tokyo')).toHaveLength(5);
  });

  it('leaves small result sets alone — the median is not meaningful', () => {
    const hotels = [hotel('Sane', 150), hotel('Absurd', 9000), hotel('Also sane', 160)];

    expect(dropPriceOutliers(hotels, 'Nowhere')).toHaveLength(3);
  });

  it('returns the set unfiltered rather than empty when everything looks wrong', () => {
    // Pathological: the median itself is the broken value, so filtering on it
    // would wipe the city. Showing suspicious prices beats showing no hotels.
    const hotels = [hotel('A', 1), hotel('B', 1), hotel('C', 900), hotel('D', 900)];

    const kept = dropPriceOutliers(hotels, 'Broken');
    expect(kept.length).toBeGreaterThan(0);
  });

  it('ignores zero, negative and non-finite prices when computing the median', () => {
    const hotels = [
      hotel('Zero', 0),
      hotel('Negative', -50),
      hotel('NaN', Number.NaN),
      hotel('Normal A', 200),
      hotel('Normal B', 210),
      hotel('Normal C', 190),
      hotel('Normal D', 220),
      hotel('Outlier', 4000),
    ];

    const kept = dropPriceOutliers(hotels, 'Mixed');

    // The junk prices must not drag the median down far enough to start
    // dropping legitimate rows, and the real outlier must still go.
    expect(kept.map((h) => h.name)).not.toContain('Outlier');
    expect(kept.map((h) => h.name)).toEqual(
      expect.arrayContaining(['Normal A', 'Normal B', 'Normal C', 'Normal D']),
    );
  });

  it('keeps a hotel sitting exactly on the 5x ceiling', () => {
    // Boundary: 5x median is allowed, only strictly above it is dropped.
    const hotels = [hotel('A', 100), hotel('B', 100), hotel('C', 100), hotel('D', 500)];

    expect(dropPriceOutliers(hotels, 'Edge').map((h) => h.name)).toContain('D');
  });

  it('is a no-op on an empty list', () => {
    expect(dropPriceOutliers([], 'Empty')).toEqual([]);
  });
});

/**
 * The absolute check. Its whole value is working where the median check can't:
 * tiny result sets, and a feed that is uniformly wrong so every row looks
 * sane beside its neighbours.
 */
describe('dropImplausiblePrices', () => {
  it('drops the real 3-star hotel priced at $5383/night', () => {
    const hotels = [hotel('Hotel Aldobrandini', 5383.47, 3), hotel('Normal', 180, 3)];

    const kept = dropImplausiblePrices(hotels, 'Florence');
    expect(kept.map((h) => h.name)).toEqual(['Normal']);
  });

  it('catches it in a 2-hotel set, where the median guard is powerless', () => {
    const hotels = [hotel('Junk', 5383.47, 3), hotel('Fine', 180, 3)];

    // The median guard bails below 4 results and lets this straight through.
    expect(dropPriceOutliers(hotels, 'Florence')).toHaveLength(2);
    expect(dropImplausiblePrices(hotels, 'Florence')).toHaveLength(1);
  });

  it('catches it when the whole feed is wrong and nothing looks like an outlier', () => {
    // Every row 20x too high: the median moves with the error, so relative
    // comparison sees a perfectly consistent set.
    const hotels = [
      hotel('A', 3600, 2),
      hotel('B', 3800, 2),
      hotel('C', 4000, 3),
      hotel('D', 4200, 3),
    ];

    expect(dropPriceOutliers(hotels, 'Broken')).toHaveLength(4);
    // All four are implausible, so this returns them rather than emptying the
    // city — but it logs every one, which is how we'd find out.
    expect(dropImplausiblePrices(hotels, 'Broken')).toHaveLength(4);
  });

  it('leaves 4 and 5 star hotels alone — they really do cost that', () => {
    const hotels = [hotel('Aman', 2400, 5), hotel('Four Seasons', 1800, 4), hotel('Inn', 200, 3)];

    expect(dropImplausiblePrices(hotels, 'Tokyo')).toHaveLength(3);
  });

  it('leaves unrated (0-star) properties alone — a whole villa has no ceiling', () => {
    const hotels = [hotel('Villa', 3000, 0), hotel('B&B', 120, 0)];

    expect(dropImplausiblePrices(hotels, 'Tuscany')).toHaveLength(2);
  });

  it('keeps a budget hotel sitting exactly on the ceiling', () => {
    const hotels = [hotel('Edge', 1000, 3), hotel('Over', 1000.01, 3)];

    expect(dropImplausiblePrices(hotels, 'Edge').map((h) => h.name)).toEqual(['Edge']);
  });

  it('is a no-op on an empty list', () => {
    expect(dropImplausiblePrices([], 'Empty')).toEqual([]);
  });
});

/**
 * Comparing a hotel against the median of its WHOLE search was measured over
 * 58 real production searches (832 rows) and lost badly: 1 true positive
 * against 4 legitimate hotels deleted. Comparing it only against others of the
 * same star rating drops exactly one row over the same data. These pin that
 * difference, since reverting to a global median would look like a tidy-up.
 */
describe('dropPriceOutliers compares within star tier', () => {
  it('keeps the luxury end of a bimodal market (the Bora Bora failure)', () => {
    // Shape taken from a real Bora Bora search: a handful of overwater resorts
    // beside a long budget tail. Against the combined median ($172, ceiling
    // $861) the old guard deleted all three resorts and left the guesthouses.
    const lodges = [62, 78, 95, 110, 119, 128, 140, 155, 167, 180, 201, 229, 248, 266].map(
      (p, i) => hotel(`Lodge ${i + 1}`, p, 0),
    );
    const resorts = [
      hotel('Westin Bora Bora', 1942.66, 5),
      hotel('InterContinental Le Moana', 1282.28, 4),
      hotel('Le Bora Bora by Pearl Resorts', 1121.9, 4),
    ];

    const kept = dropPriceOutliers([...lodges, ...resorts], 'Bora Bora').map((h) => h.name);

    expect(kept).toContain('Westin Bora Bora');
    expect(kept).toContain('InterContinental Le Moana');
    expect(kept).toContain('Le Bora Bora by Pearl Resorts');
    expect(kept).toHaveLength(17);
  });

  it('still drops a genuine outlier inside a large tier (the Positano case)', () => {
    // Real: "La Terrazza del Sole a Positano", 0-star, $6466.42/night against
    // a $464.29 tier median — 13.93x, and 5.8x the next dearest row in its own
    // tier. The absolute star guard exempts it for being 0-star, so this is
    // the only thing that catches it.
    const tier = [
      210, 265, 310, 355, 390, 420, 450, 464, 470, 495, 520, 560, 610, 680, 740, 820, 900, 1115,
    ].map((p, i) => hotel(`Positano ${i + 1}`, p, 0));
    const outlier = hotel('La Terrazza del Sole a Positano', 6466.42, 0);

    const kept = dropPriceOutliers([...tier, outlier], 'Positano').map((h) => h.name);

    expect(kept).not.toContain('La Terrazza del Sole a Positano');
    expect(kept).toHaveLength(18);
  });

  it('judges a hotel against its own tier, not a cheaper one', () => {
    // Same price, different stars: the 5-star is ordinary for its tier while
    // the 0-star is 10x its own. A global median could not tell them apart.
    const budget = [100, 110, 120, 130].map((p, i) => hotel(`Budget ${i}`, p, 0));
    const luxury = [900, 950, 1000, 1100].map((p, i) => hotel(`Luxury ${i}`, p, 5));
    const odd = hotel('Suspicious guesthouse', 1200, 0);
    const fine = hotel('Expensive but normal suite', 1200, 5);

    const kept = dropPriceOutliers([...budget, ...luxury, odd, fine], 'Mixed').map((h) => h.name);

    expect(kept).toContain('Expensive but normal suite');
    expect(kept).not.toContain('Suspicious guesthouse');
  });

  it('leaves a tier alone when it is too thin to have a median', () => {
    // Two 5-star rooms at wildly different prices: with only two of them there
    // is nothing to compare against, so neither is touched.
    const budget = [100, 110, 120, 130].map((p, i) => hotel(`Budget ${i}`, p, 0));
    const pair = [hotel('Suite A', 400, 5), hotel('Suite B', 4000, 5)];

    const kept = dropPriceOutliers([...budget, ...pair], 'Thin').map((h) => h.name);

    expect(kept).toContain('Suite B');
    expect(kept).toHaveLength(6);
  });

  it('filters one tier while leaving another unfiltered in the same search', () => {
    const big = [100, 105, 110, 115].map((p, i) => hotel(`Big ${i}`, p, 2));
    const bigOutlier = hotel('Big outlier', 900, 2);
    const small = [hotel('Small A', 300, 4), hotel('Small B', 3000, 4)];

    const kept = dropPriceOutliers([...big, bigOutlier, ...small], 'Split').map((h) => h.name);

    expect(kept).not.toContain('Big outlier');
    expect(kept).toContain('Small B');
  });

  it('treats a missing star rating as its own tier rather than crashing', () => {
    const rows = [
      { name: 'No stars A', rating: 8, pricePerNight: 100, price: 300, currency: 'USD' },
      { name: 'No stars B', rating: 8, pricePerNight: 110, price: 330, currency: 'USD' },
      { name: 'No stars C', rating: 8, pricePerNight: 120, price: 360, currency: 'USD' },
      { name: 'No stars D', rating: 8, pricePerNight: 130, price: 390, currency: 'USD' },
      { name: 'No stars outlier', rating: 8, pricePerNight: 2000, price: 6000, currency: 'USD' },
    ] as any[];

    const kept = dropPriceOutliers(rows, 'Unrated').map((h) => h.name);
    expect(kept).not.toContain('No stars outlier');
    expect(kept).toHaveLength(4);
  });
});
