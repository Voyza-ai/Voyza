jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

import { dropUnusablePrices, flagSuspectPrices } from '../services/hotels';

/**
 * Price plausibility, in two halves that must not be confused:
 *
 *  - `dropUnusablePrices` DELETES, on certainty. A missing or zero price has no
 *    hotel behind it, and is the single most dangerous value in the system
 *    because the ranking formula's `100 / price` term turns it into the
 *    highest-scoring row in the search.
 *  - `flagSuspectPrices` only MARKS. It never removes anything, because the
 *    previous attempt at this deleted Bora Bora's three overwater resorts in
 *    production and we cannot tell a glitch from a genuinely expensive hotel
 *    reliably enough to be allowed to delete.
 *
 * The case this all came from, measured against production: Florence
 * 2027-04-10 → 04-13 for 2 adults returned "Hotel Aldobrandini" at
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

const names = (hotels: any[]) => hotels.map((h) => h.name);
const suspect = (hotels: any[]) => hotels.filter((h) => h.priceSuspect).map((h) => h.name);
const trusted = (hotels: any[]) => hotels.filter((h) => !h.priceSuspect).map((h) => h.name);
const reasonOf = (hotels: any[], name: string) =>
  hotels.find((h) => h.name === name)?.priceSuspectReason;

/**
 * The half that deletes. Everything here is a value no hotel can really have,
 * so there is no false-positive cost to weigh.
 */
describe('dropUnusablePrices', () => {
  it('drops a zero price — the value that scored BEST before this existed', () => {
    // Measured through the real frontend rankHotels: a $0/night row scored
    // 40028.8 against ~235 for a legitimate hotel, so it came first and became
    // the trip's hotel and headline total.
    const hotels = [hotel('Real', 180, 3), hotel('Zero', 0, 3)];

    expect(names(dropUnusablePrices(hotels, 'Florence'))).toEqual(['Real']);
  });

  it('drops a negative price', () => {
    // Also scored 40028.8 — Math.max(1, -50) clamped it to the best possible
    // price term rather than rejecting it.
    const hotels = [hotel('Real', 180, 3), hotel('Negative', -50, 3)];

    expect(names(dropUnusablePrices(hotels, 'Florence'))).toEqual(['Real']);
  });

  it('drops NaN and Infinity', () => {
    const hotels = [
      hotel('Real', 180, 3),
      hotel('NaN', Number.NaN, 3),
      hotel('Infinity', Number.POSITIVE_INFINITY, 3),
    ];

    expect(names(dropUnusablePrices(hotels, 'Florence'))).toEqual(['Real']);
  });

  it('drops a price below the absolute floor', () => {
    // $3/night is not a room for two adults, it is a data error — and it
    // scored 16415.7, i.e. first.
    const hotels = [hotel('Real', 180, 3), hotel('Three dollars', 3, 3)];

    expect(names(dropUnusablePrices(hotels, 'Florence'))).toEqual(['Real']);
  });

  it('keeps a cheap but plausible price', () => {
    // A hostel bed really does go for this. The floor is set to catch an
    // ABSENT price, not a cheap one, so it must not reach genuine budget stock.
    const hotels = [hotel('Hostel', 12, 1), hotel('Normal', 180, 3)];

    expect(names(dropUnusablePrices(hotels, 'Bangkok'))).toHaveLength(2);
  });

  it('keeps a price sitting exactly on the floor', () => {
    const hotels = [hotel('Edge', 5, 1), hotel('Under', 4.99, 1)];

    expect(names(dropUnusablePrices(hotels, 'Edge'))).toEqual(['Edge']);
  });

  it('drops a row whose stay total is unusable even when the nightly rate looks fine', () => {
    // price and pricePerNight are derived from each other at the mapping, but
    // currency conversion converts them independently, so they can diverge.
    const broken = { ...hotel('Diverged', 180, 3), price: 0 };

    expect(names(dropUnusablePrices([broken, hotel('Real', 180, 3)], 'Florence'))).toEqual([
      'Real',
    ]);
  });

  it('returns empty rather than a city of $0 hotels', () => {
    // The old guards had an "empty is worse than suspicious" fallback. That
    // reasoning applied to rows that might have been real. These cannot be, and
    // a $0 trip total is a confidently wrong answer rather than a cautious one.
    const hotels = [hotel('A', 0, 2), hotel('B', 0, 2), hotel('C', Number.NaN, 2)];

    expect(dropUnusablePrices(hotels, 'Broken')).toEqual([]);
  });

  it('is a no-op on an empty list', () => {
    expect(dropUnusablePrices([], 'Empty')).toEqual([]);
  });
});

/**
 * The half that only marks. The single most important property in this file is
 * that NOTHING is ever removed here — that is what makes the thresholds safe
 * to set aggressively, and what stops a tuning mistake deleting real inventory.
 */
describe('flagSuspectPrices never removes a row', () => {
  const scenarios: Array<[string, any[]]> = [
    ['the Florence outlier', [hotel('Aldobrandini', 5383.47, 3), hotel('Normal', 180, 3)]],
    [
      'a whole feed priced 20x too high',
      [hotel('A', 3600, 2), hotel('B', 3800, 2), hotel('C', 4000, 3), hotel('D', 4200, 3)],
    ],
    ['a single row', [hotel('Alone', 9000, 0)]],
    [
      'a tier where every row is over its own ceiling',
      [hotel('A', 100, 2), hotel('B', 100, 2), hotel('C', 9000, 2), hotel('D', 9000, 2)],
    ],
  ];

  for (const [label, hotels] of scenarios) {
    it(`keeps every row — ${label}`, () => {
      const out = flagSuspectPrices(hotels, 'City');
      expect(out).toHaveLength(hotels.length);
      expect(names(out).sort()).toEqual(names(hotels).sort());
    });
  }
});

describe('flagSuspectPrices — per star tier', () => {
  it('flags the production Florence outlier and trusts everything else', () => {
    // Real prices and order from the live API.
    const hotels = [
      hotel('Hotel Aldobrandini', 5383.47, 4),
      hotel('Radisson Blu Hotel, Florence', 170.31, 4),
      hotel('B&B Hotel Firenze Laurus Al Duomo', 301.99, 4),
      hotel('Plus Florence Hotel & Hostel', 159.87, 4),
      hotel('Hotel David', 204.32, 4),
      hotel('Bed & Breakfast Il Bargello', 197.58, 4),
    ];

    const out = flagSuspectPrices(hotels, 'Florence');

    expect(suspect(out)).toEqual(['Hotel Aldobrandini']);
    expect(reasonOf(out, 'Hotel Aldobrandini')).toBe('above-tier-median');
  });

  it('keeps the luxury end of a bimodal market trusted (the Bora Bora failure)', () => {
    // Shape taken from a real Bora Bora search: a handful of overwater resorts
    // beside a long budget tail. Against the combined median ($172, ceiling
    // $861) the first version of this deleted all three resorts and left the
    // guesthouses.
    const lodges = [62, 78, 95, 110, 119, 128, 140, 155, 167, 180, 201, 229, 248, 266].map(
      (p, i) => hotel(`Lodge ${i + 1}`, p, 0),
    );
    const resorts = [
      hotel('Westin Bora Bora', 1942.66, 5),
      hotel('InterContinental Le Moana', 1282.28, 4),
      hotel('Le Bora Bora by Pearl Resorts', 1121.9, 4),
    ];

    const out = flagSuspectPrices([...lodges, ...resorts], 'Bora Bora');

    expect(suspect(out)).toEqual([]);
    expect(trusted(out)).toHaveLength(17);
  });

  it('still flags a genuine outlier inside a large tier (the Positano case)', () => {
    // Real: "La Terrazza del Sole a Positano", 0-star, $6466.42/night against
    // a $464.29 tier median — 13.93x, and 5.8x the next dearest row in its own
    // tier. The absolute star guard exempts it for being 0-star.
    const tier = [
      210, 265, 310, 355, 390, 420, 450, 464, 470, 495, 520, 560, 610, 680, 740, 820, 900, 1115,
    ].map((p, i) => hotel(`Positano ${i + 1}`, p, 0));
    const outlier = hotel('La Terrazza del Sole a Positano', 6466.42, 0);

    const out = flagSuspectPrices([...tier, outlier], 'Positano');

    expect(suspect(out)).toEqual(['La Terrazza del Sole a Positano']);
    expect(reasonOf(out, 'La Terrazza del Sole a Positano')).toBe('above-tier-median');
  });

  it('judges a hotel against its own tier, not a cheaper one', () => {
    // Same price, different stars: the 5-star is ordinary for its tier while
    // the 0-star is 10x its own. A global median could not tell them apart.
    const budget = [100, 110, 120, 130].map((p, i) => hotel(`Budget ${i}`, p, 0));
    const luxury = [900, 950, 1000, 1100].map((p, i) => hotel(`Luxury ${i}`, p, 5));
    const odd = hotel('Suspicious guesthouse', 1200, 0);
    const fine = hotel('Expensive but normal suite', 1200, 5);

    const out = flagSuspectPrices([...budget, ...luxury, odd, fine], 'Mixed');

    expect(suspect(out)).toEqual(['Suspicious guesthouse']);
  });

  it('keeps a hotel sitting exactly on the tier ceiling trusted', () => {
    // Boundary: 5x the tier median is allowed, only strictly above it is flagged.
    const hotels = [hotel('A', 100, 2), hotel('B', 100, 2), hotel('C', 100, 2), hotel('D', 500, 2)];

    expect(suspect(flagSuspectPrices(hotels, 'Edge'))).toEqual([]);
  });

  it('leaves a thin 5-star tier alone — stars are independent evidence of price class', () => {
    const budget = [100, 110, 120, 130].map((p, i) => hotel(`Budget ${i}`, p, 0));
    const pair = [hotel('Suite A', 400, 5), hotel('Suite B', 4000, 5)];

    expect(suspect(flagSuspectPrices([...budget, ...pair], 'Thin'))).toEqual([]);
  });

  it('flags one tier while leaving another untouched in the same search', () => {
    const big = [100, 105, 110, 115].map((p, i) => hotel(`Big ${i}`, p, 2));
    const bigOutlier = hotel('Big outlier', 900, 2);
    const small = [hotel('Small A', 300, 4), hotel('Small B', 3000, 4)];

    const out = flagSuspectPrices([...big, bigOutlier, ...small], 'Split');

    expect(suspect(out)).toEqual(['Big outlier']);
  });

  it('ignores unusable prices when computing a tier median', () => {
    // A row of 0s in the set would drag every floor down with it. searchHotels
    // drops them first, but this must not depend on call order.
    const hotels = [
      hotel('Zero', 0, 3),
      hotel('Normal A', 200, 3),
      hotel('Normal B', 210, 3),
      hotel('Normal C', 190, 3),
      hotel('Normal D', 220, 3),
      hotel('Outlier', 4000, 3),
    ];

    const out = flagSuspectPrices(hotels, 'Mixed');

    expect(suspect(out)).toEqual(['Outlier']);
  });

  it('is a no-op on an empty list', () => {
    expect(flagSuspectPrices([], 'Empty')).toEqual([]);
  });
});

/**
 * The absolute star ceiling. Its value is working where a comparison cannot:
 * a result set of one, and a feed that is uniformly wrong so every row looks
 * sane beside its neighbours.
 */
describe('flagSuspectPrices — absolute star ceiling', () => {
  it('flags a 3-star priced at $5383/night', () => {
    const hotels = [hotel('Hotel Aldobrandini', 5383.47, 3), hotel('Normal', 180, 3)];

    const out = flagSuspectPrices(hotels, 'Florence');

    expect(suspect(out)).toEqual(['Hotel Aldobrandini']);
    expect(reasonOf(out, 'Hotel Aldobrandini')).toBe('above-star-ceiling');
  });

  it('catches it in a 2-hotel set, where a tier median is powerless', () => {
    const hotels = [hotel('Junk', 5383.47, 3), hotel('Fine', 180, 3)];

    expect(suspect(flagSuspectPrices(hotels, 'Florence'))).toEqual(['Junk']);
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

    expect(suspect(flagSuspectPrices(hotels, 'Broken'))).toHaveLength(4);
  });

  it('leaves 4 and 5 star hotels alone — they really do cost that', () => {
    const hotels = [hotel('Aman', 2400, 5), hotel('Four Seasons', 1800, 4), hotel('Inn', 200, 3)];

    expect(suspect(flagSuspectPrices(hotels, 'Tokyo'))).toEqual([]);
  });

  it('keeps a budget hotel sitting exactly on the ceiling trusted', () => {
    const hotels = [hotel('Edge', 1000, 3), hotel('Over', 1000.01, 3)];

    expect(suspect(flagSuspectPrices(hotels, 'Edge'))).toEqual(['Over']);
  });
});

/**
 * The gap the per-tier rule leaves open, and the reason this file changed
 * again: a lone unrated row has no peers, so nothing judged it at all. A
 * Val d'Isère search returned a single 0-star listing at $3377.84/night — a
 * tier of one, and exempt from the star ceiling for being unrated — and it
 * reached customers unchallenged.
 */
describe('flagSuspectPrices — unrated row with no tier to judge it', () => {
  // Shape of the real Val d'Isère search: one 0-star row, 8 three-star, 3
  // four-star, 2 five-star.
  const valdisere = (lonePrice: number) => [
    hotel('Lone unrated', lonePrice, 0),
    ...[400, 450, 480, 500, 520, 560, 640, 887].map((p, i) => hotel(`Three ${i}`, p, 3)),
    ...[700, 812, 1000].map((p, i) => hotel(`Four ${i}`, p, 4)),
    ...[1063, 1319].map((p, i) => hotel(`Five ${i}`, p, 5)),
  ];

  it('flags the lone unrated row when it dwarfs the whole search', () => {
    const out = flagSuspectPrices(valdisere(3377.84), "Val d'Isere");

    expect(suspect(out)).toEqual(['Lone unrated']);
    expect(reasonOf(out, 'Lone unrated')).toBe('above-search-median-unrated');
  });

  it("trusts the same slot at today's real price", () => {
    // The live search now returns $495.78 there. A rule that flagged this would
    // be flagging the ordinary case.
    expect(suspect(flagSuspectPrices(valdisere(495.78), "Val d'Isere"))).toEqual([]);
  });

  it('does NOT apply to a thin 4 or 5 star tier', () => {
    // The distinction that spares Bora Bora: a star rating is the provider
    // vouching for the price class. An unrated row carries no such evidence.
    const base = [400, 450, 480, 500, 520, 560].map((p, i) => hotel(`Three ${i}`, p, 3));
    const lone5 = hotel('Lone resort', 3377.84, 5);
    const lone4 = hotel('Lone four', 3377.84, 4);

    expect(suspect(flagSuspectPrices([...base, lone5], 'Thin'))).toEqual([]);
    expect(suspect(flagSuspectPrices([...base, lone4], 'Thin'))).toEqual([]);
  });

  it('does not apply when the whole search is too small to have a median', () => {
    const hotels = [hotel('Lone unrated', 9000, 0), hotel('Other', 200, 3)];

    expect(suspect(flagSuspectPrices(hotels, 'Tiny'))).toEqual([]);
  });

  it('prefers the row\'s own tier when it has one', () => {
    // With 4 unrated rows the tier can speak for itself, so the whole-search
    // fallback must not be what decides.
    const unrated = [400, 450, 480, 500].map((p, i) => hotel(`Unrated ${i}`, p, 0));
    const cheapRest = [100, 110, 120, 130].map((p, i) => hotel(`Cheap ${i}`, p, 3));

    // $1800 is 3.8x its own tier median ($465) so its tier trusts it, but it is
    // 12x the whole search's median — the fallback would have flagged it.
    const out = flagSuspectPrices(
      [...unrated, ...cheapRest, hotel('Dear unrated', 1800, 0)],
      'Own tier wins',
    );

    expect(suspect(out)).toEqual([]);
  });
});

/**
 * The mirror rule. Far more conservative than the ceiling (10x rather than 5x)
 * because the errors are not symmetric: flagging an over-priced row costs
 * nothing, while flagging a genuine bargain demotes the exact room a
 * price-led planner should be putting first.
 */
describe('flagSuspectPrices — under-priced against its own tier', () => {
  it('flags a row priced at a twentieth of its tier', () => {
    const tier = [1000, 1100, 1200, 1300].map((p, i) => hotel(`Suite ${i}`, p, 5));
    const odd = hotel('Suite for $55', 55, 5);

    const out = flagSuspectPrices([...tier, odd], 'Underpriced');

    expect(suspect(out)).toEqual(['Suite for $55']);
    expect(reasonOf(out, 'Suite for $55')).toBe('below-tier-median');
  });

  it('trusts an ordinary bargain', () => {
    // Half the tier median is a good deal, not a data error, and it is exactly
    // what the product should be surfacing first.
    const tier = [200, 220, 240, 260].map((p, i) => hotel(`Hotel ${i}`, p, 3));
    const deal = hotel('Genuine deal', 115, 3);

    expect(suspect(flagSuspectPrices([...tier, deal], 'Deal'))).toEqual([]);
  });

  it('trusts a row sitting exactly on the tier floor', () => {
    const tier = [1000, 1000, 1000, 1000].map((p, i) => hotel(`Suite ${i}`, p, 5));
    const onFloor = hotel('On the floor', 100, 5);
    const under = hotel('Under the floor', 99.99, 5);

    const out = flagSuspectPrices([...tier, onFloor, under], 'Floor');

    expect(suspect(out)).toEqual(['Under the floor']);
  });

  it('does not apply to a tier too thin to have a floor', () => {
    const base = [400, 450, 480, 500].map((p, i) => hotel(`Three ${i}`, p, 3));
    const pair = [hotel('Suite A', 2000, 5), hotel('Suite B', 60, 5)];

    expect(suspect(flagSuspectPrices([...base, ...pair], 'Thin'))).toEqual([]);
  });
});
