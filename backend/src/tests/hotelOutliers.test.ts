jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

import {
  dropUnusablePrices,
  flagSuspectPrices,
  pickByRating,
  pickDestination,
  trustedFirst,
} from '../services/hotels';

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
    const hotels = [hotel('Real', 180, 3), hotel('Half a cent', 0.005, 3)];

    expect(names(dropUnusablePrices(hotels, 'Florence'))).toEqual(['Real']);
  });

  it('does NOT delete a cheap-but-positive price', () => {
    // $3/night is almost certainly a glitch, but this function deletes and so
    // must bind on certainty alone. A cheap row is the relative floor's
    // business, where the verdict is reversible. The previous $5 floor deleted
    // these outright.
    const hotels = [hotel('Three dollars', 3, 3), hotel('Hostel', 12, 1), hotel('Normal', 180, 3)];

    expect(dropUnusablePrices(hotels, 'Bangkok')).toHaveLength(3);
  });

  it('keeps a price sitting exactly on the floor', () => {
    const hotels = [hotel('Edge', 1, 1), hotel('Under', 0.99, 1)];

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
    // Boundary: 8x the tier median is allowed, only strictly above it is
    // flagged. Median of [100, 100, 100, 800] is 100, so the ceiling is 800.
    const onCeiling = [hotel('A', 100, 2), hotel('B', 100, 2), hotel('C', 100, 2), hotel('D', 800, 2)];
    expect(suspect(flagSuspectPrices(onCeiling, 'Edge'))).toEqual([]);

    const over = [hotel('A', 100, 2), hotel('B', 100, 2), hotel('C', 100, 2), hotel('D', 800.01, 2)];
    expect(suspect(flagSuspectPrices(over, 'Edge'))).toEqual(['D']);
  });

  it('leaves a thin 5-star tier alone — stars are independent evidence of price class', () => {
    const budget = [100, 110, 120, 130].map((p, i) => hotel(`Budget ${i}`, p, 0));
    const pair = [hotel('Suite A', 400, 5), hotel('Suite B', 4000, 5)];

    expect(suspect(flagSuspectPrices([...budget, ...pair], 'Thin'))).toEqual([]);
  });

  it('flags one tier while leaving another untouched in the same search', () => {
    const big = [100, 105, 110, 115].map((p, i) => hotel(`Big ${i}`, p, 2));
    // 1500 against a tier median of 107.5 is 14x — clear of the 8x ceiling
    // rather than sitting just over it.
    const bigOutlier = hotel('Big outlier', 1500, 2);
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

  it('keeps a star-ceiling violator out of its own tier statistics', () => {
    // A row the absolute rule has already condemned must not get a vote on
    // where its tier's ceiling and floor sit. The guards this replaced got
    // this for free by DELETING such rows in an earlier pass; flagging instead
    // of deleting quietly lost it.
    //
    // The observable consequence is padding, not masking: without the
    // exclusion the $5000 violator takes the 3-star tier from 2 real rows to 3
    // — over MIN_RESULTS_TO_FILTER once the cheap row is counted — which
    // manufactures a floor ($10.50) that then flags a legitimate $8 room. With
    // it, the tier is correctly too thin to judge anything and the cheap row
    // is left alone.
    const hotels = [
      hotel('Normal A', 100, 3),
      hotel('Normal B', 110, 3),
      hotel('Violator', 5000, 3),
      hotel('Cheap but real', 8, 3),
    ];

    const out = flagSuspectPrices(hotels, 'Padding');

    expect(suspect(out)).toEqual(['Violator']);
    expect(reasonOf(out, 'Violator')).toBe('above-star-ceiling');
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
    const hotels = [hotel('Edge', 2000, 3), hotel('Over', 2000.01, 3)];

    expect(suspect(flagSuspectPrices(hotels, 'Edge'))).toEqual(['Over']);
  });

  it('trusts peak-season Alpine 3-star stock', () => {
    // The $1000 ceiling condemned every one of these, which also stripped the
    // tier of the statistics needed to catch a real glitch in it.
    const chalets = [1200, 1400, 1600, 1800].map((p, i) => hotel(`Chalet ${i}`, p, 3));

    expect(suspect(flagSuspectPrices(chalets, "Val d'Isere"))).toEqual([]);
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

    // $1800 is 3.75x its own tier median ($480, which includes it) so its tier
    // trusts it, but it is 12x the whole search's median — the fallback would
    // have flagged it.
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

/**
 * The ordering guarantee, and why it is the backend's job.
 *
 * The first version of this change put demotion entirely in the frontend's
 * `rankHotels` and claimed that was the single boundary every consumer passes
 * through. It was not: `backend/src/routes/canvas.ts` calls `searchHotels`
 * directly when a city is saved with no hotels and takes `hotels[0]` out of
 * raw provider order, and `tripShape.ts` reads it back without re-ranking.
 *
 * The guards this replaced survived that path by accident — they DELETED the
 * bad row, so index 0 was safe however it was chosen. Flagging handed that path
 * back its worst case: measured on the production Florence set in provider
 * order, index 0 went from Radisson Blu at $170.31 to Hotel Aldobrandini at
 * $5383.47. These pin the fix.
 */
describe('trustedFirst', () => {
  it('keeps the Florence outlier out of index 0 in provider order', () => {
    // Provider order, exactly as the live API returned it — Aldobrandini first.
    const florence = flagSuspectPrices(
      [
        hotel('Hotel Aldobrandini', 5383.47, 3),
        hotel('Radisson Blu Hotel, Florence', 170.31, 4),
        hotel('B&B Hotel Firenze Laurus Al Duomo', 301.99, 4),
        hotel('Plus Florence Hotel & Hostel', 159.87, 4),
        hotel('Hotel David', 204.32, 4),
        hotel('Bed & Breakfast Il Bargello', 197.58, 4),
      ],
      'Florence',
    );

    // Before the fix this was the $17,039 headline.
    expect(florence[0].name).toBe('Hotel Aldobrandini');

    const ordered = trustedFirst(florence);
    expect(ordered[0].name).toBe('Radisson Blu Hotel, Florence');
    expect(ordered[0].pricePerNight).toBe(170.31);
    expect(ordered[ordered.length - 1].name).toBe('Hotel Aldobrandini');
    // Nothing deleted.
    expect(ordered).toHaveLength(6);
  });

  it('preserves provider order within each group', () => {
    const rows = [
      { ...hotel('A', 100, 3) },
      { ...hotel('B', 200, 3), priceSuspect: true },
      { ...hotel('C', 300, 3) },
      { ...hotel('D', 400, 3), priceSuspect: true },
      { ...hotel('E', 500, 3) },
    ];

    expect(trustedFirst(rows).map((h) => h.name)).toEqual(['A', 'C', 'E', 'B', 'D']);
  });

  it('leaves an all-suspect list alone — a suspicious price beats an empty city', () => {
    const rows = [
      { ...hotel('A', 100, 3), priceSuspect: true },
      { ...hotel('B', 200, 3), priceSuspect: true },
    ];

    expect(trustedFirst(rows).map((h) => h.name)).toEqual(['A', 'B']);
  });

  it('treats priceSuspect: false the same as absent', () => {
    const rows = [
      { ...hotel('Flagged', 100, 3), priceSuspect: true },
      { ...hotel('Explicitly fine', 200, 3), priceSuspect: false },
    ];

    expect(trustedFirst(rows).map((h) => h.name)).toEqual(['Explicitly fine', 'Flagged']);
  });

  it('is a no-op on an empty list', () => {
    expect(trustedFirst([])).toEqual([]);
  });
});

/**
 * Eleven destinations returned ZERO hotels in production because the lookup
 * accepted only `dest_type === 'city'` and the caller swallows the throw into
 * an empty list. Santorini is one of them, and it ships in a preset itinerary.
 */
describe('pickDestination', () => {
  const loc = (dest_type: string, dest_id: string | number = '123') => ({ dest_type, dest_id });

  it('prefers a city over everything else', () => {
    const picked = pickDestination(
      [loc('country', '1'), loc('region', '2'), loc('city', '3'), loc('district', '4')],
      'Florence',
    );
    expect(picked).toEqual({ dest_id: '3', dest_type: 'city', certain: true });
  });

  it('resolves a region when there is no city — the Tuscany case', () => {
    expect(pickDestination([loc('country', '1'), loc('region', '2')], 'Tuscany')).toEqual({
      dest_id: '2',
      dest_type: 'region',
      certain: true,
    });
  });

  it('resolves a country when that is all there is — the Maldives case', () => {
    expect(pickDestination([loc('country', '9')], 'Maldives')).toEqual({
      dest_id: '9',
      dest_type: 'country',
      certain: true,
    });
  });

  it('resolves an island — the Santorini case', () => {
    expect(pickDestination([loc('island', '7'), loc('hotel', '8')], 'Santorini')).toEqual({
      dest_id: '7',
      dest_type: 'island',
      certain: true,
    });
  });

  it('never points a search at a single hotel or an airport', () => {
    // A one-property search dressed up as a city is worse than a clear failure.
    expect(pickDestination([loc('hotel', '1'), loc('airport', '2')], 'Somewhere')).toBeNull();
  });

  it('falls through to the provider ranking for an unrecognised kind', () => {
    // Our list of names must not be the thing that decides a search is
    // impossible — Booking's own ordering is better than our vocabulary.
    expect(pickDestination([loc('municipality', '5')], 'Elsewhere')).toEqual({
      dest_id: '5',
      dest_type: 'municipality',
      certain: true,
    });
  });

  it('is monotonic: a city match resolves identically to the old behaviour', () => {
    // The only behaviour that may change is a lookup that previously threw.
    const locations = [loc('region', '1'), loc('city', '2'), loc('country', '3')];
    const old = locations.find((l) => l.dest_type === 'city');

    expect(pickDestination(locations, 'Florence')?.dest_id).toBe(String(old!.dest_id));
  });

  it('returns null on junk rather than throwing', () => {
    expect(pickDestination(null, 'X')).toBeNull();
    expect(pickDestination([], 'X')).toBeNull();
    expect(pickDestination({ error: 'nope' }, 'X')).toBeNull();
    expect(pickDestination([{ dest_type: 'city' }], 'X')).toBeNull(); // no dest_id
  });

  it('coerces a numeric dest_id to a string', () => {
    expect(pickDestination([loc('city', 4242)], 'X')).toEqual({
      dest_id: '4242',
      dest_type: 'city',
      certain: true,
    });
  });
});

/** `stars` is an untyped provider field run through parseInt, so it can be anything. */
describe('flagSuspectPrices normalises the star class', () => {
  it('treats a negative star class as unrated, not as luxury', () => {
    // stars: -1 used to escape BOTH ceilings — `>= 1 && <= 3` missed it and
    // `=== 0` missed it too, so it landed in the "4-5 star, trust it" bucket.
    // The same row with stars absent was correctly flagged.
    const tier = [200, 210, 190, 220].map((p, i) => hotel(`Normal ${i}`, p, 0));
    const negative = hotel('Negative stars', 5383.47, -1);

    const out = flagSuspectPrices([...tier, negative], 'Florence');

    expect(suspect(out)).toEqual(['Negative stars']);
  });

  it('treats an out-of-range or fractional star class as unrated', () => {
    const tier = [200, 210, 190, 220].map((p, i) => hotel(`Normal ${i}`, p, 0));

    for (const bad of [6, 99, 2.5, Number.NaN]) {
      const out = flagSuspectPrices([...tier, hotel('Odd stars', 5383.47, bad)], 'Florence');
      expect(suspect(out)).toEqual(['Odd stars']);
    }
  });

  it('still honours a legitimate 1-5 star class', () => {
    const tier = [200, 210, 190, 220].map((p, i) => hotel(`Normal ${i}`, p, 0));
    // 5 stars is independent evidence of price class, so it is left alone.
    const out = flagSuspectPrices([...tier, hotel('Real resort', 5383.47, 5)], 'Tokyo');

    expect(suspect(out)).toEqual([]);
  });
});

/**
 * The 0-star "tier" is not a price class — it means Booking assigned no star
 * rating, which lumps hostel private rooms in with B&Bs, apartments and whole
 * villas. A relative floor there condemns real budget stock.
 */
describe('the under-price floor skips unrated tiers', () => {
  it('trusts genuine budget rooms in a bimodal unrated market', () => {
    // Real Bangkok shape: hostel private rooms beside serviced apartments.
    // Median 165, so a floor of 16.50 would condemn all three cheap rooms and
    // hand hotels[0] to the $150 apartment — 18x the cheapest room found.
    const bangkok = [8, 10, 12, 150, 180, 200, 220, 250].map((p, i) =>
      hotel(`Unrated ${i}`, p, 0),
    );

    const out = flagSuspectPrices(bangkok, 'Bangkok');

    expect(suspect(out)).toEqual([]);
    expect(trustedFirst(out)[0].pricePerNight).toBe(8);
  });

  it('still applies the floor where stars make the tier a price class', () => {
    // Val d'Isere in February: 3-star chalets, and one glitched from-price.
    const chalets = [1200, 1400, 1600, 1800].map((p, i) => hotel(`Chalet ${i}`, p, 3));
    const glitch = hotel('Six dollar chalet', 6, 3);

    const out = flagSuspectPrices([...chalets, glitch], "Val d'Isere");

    expect(suspect(out)).toContain('Six dollar chalet');
    expect(reasonOf(out, 'Six dollar chalet')).toBe('below-tier-median');
  });
});

/** The floor deletes, so it must bind on certainty alone. */
describe('dropUnusablePrices floor is set below real inventory', () => {
  it('keeps a genuinely cheap converted room', () => {
    // 100,000 VND is $4.00 and 70,000 IDR is $4.43. The previous $5 floor
    // deleted both, in the one function that is supposed to have no false
    // positives.
    const hotels = [hotel('Hanoi room', 4.0, 1), hotel('Bali room', 4.43, 1)];

    expect(dropUnusablePrices(hotels, 'Hanoi')).toHaveLength(2);
  });

  it('still deletes the near-zero values the floor exists for', () => {
    const hotels = [hotel('Real', 180, 3), hotel('Cent', 0.01, 3), hotel('Zero', 0, 3)];

    expect(names(dropUnusablePrices(hotels, 'Florence'))).toEqual(['Real']);
  });
});

/**
 * A resolution with no `dest_type` to go on is a guess, and a guess must not be
 * cached. `getDestinationId` upserts into `booking_locations`, so writing one
 * would freeze it for that city name for good — every later search inheriting
 * a single bad response.
 */
describe('pickDestination reports whether it is certain', () => {
  it('is certain about a real dest_type', () => {
    const picked = pickDestination([{ dest_type: 'region', dest_id: '2' }], 'Tuscany');
    expect(picked?.certain).toBe(true);
  });

  it('is NOT certain when the provider gave no dest_type', () => {
    // This used to be the only silent branch, and the one that most needed a
    // log line: `String(undefined ?? 'city')` made the warn condition false
    // and cached the guess as a city.
    const picked = pickDestination([{ dest_id: '8' }], 'Nowhere');

    expect(picked).toEqual({ dest_id: '8', dest_type: 'city', certain: false });
  });

  it('is not certain about an empty-string dest_type either', () => {
    expect(pickDestination([{ dest_type: '', dest_id: '8' }], 'Nowhere')?.certain).toBe(false);
  });

  it('still prefers a real city over an entry with no dest_type', () => {
    const picked = pickDestination(
      [{ dest_id: '8' }, { dest_type: 'city', dest_id: '9' }],
      'Florence',
    );

    expect(picked).toEqual({ dest_id: '9', dest_type: 'city', certain: true });
  });
});

/**
 * The absolute star ceiling is the one rule with no comparison set and no
 * thin-result-set escape, which made it the last way for every row in a search
 * to be flagged — and then `trustedFirst` has nothing to promote and
 * `hotels[0]` is suspect, voiding the guarantee the design rests on.
 */
describe('the star ceiling yields when it would condemn a whole tier', () => {
  it('trusts a peak-season market that sits entirely above the ceiling', () => {
    // Nine realistic New-Year ski chalets. Every one is over $2000, so the
    // ceiling would flag all nine and leave nothing to select.
    const chalets = [2180, 2300, 2450, 2600, 2750, 2900, 3050, 3180, 3260].map((p, i) =>
      hotel(`Chalet ${i}`, p, 3),
    );

    const out = flagSuspectPrices(chalets, "Val d'Isere");

    expect(suspect(out)).toEqual([]);
    expect(trustedFirst(out)[0].priceSuspect).toBeFalsy();
  });

  it('still catches one absurd row among normal ones', () => {
    // The case the ceiling was built for must keep working.
    const normal = [180, 200, 220, 240].map((p, i) => hotel(`Normal ${i}`, p, 3));
    const glitch = hotel('Hotel Aldobrandini', 5383.47, 3);

    expect(suspect(flagSuspectPrices([...normal, glitch], 'Florence'))).toEqual([
      'Hotel Aldobrandini',
    ]);
  });

  it('does not yield for a tier too thin to speak for itself', () => {
    // Two rows over the ceiling is not evidence of a market.
    const pair = [hotel('A', 2500, 3), hotel('B', 2600, 3)];

    expect(suspect(flagSuspectPrices(pair, 'Thin'))).toEqual(['A', 'B']);
  });

  it('yields per tier, not across the search', () => {
    const chalets = [2180, 2300, 2450, 2600].map((p, i) => hotel(`Chalet ${i}`, p, 3));
    const budget = [100, 110, 120, 130].map((p, i) => hotel(`Budget ${i}`, p, 2));
    const budgetGlitch = hotel('Budget glitch', 4000, 2);

    const out = flagSuspectPrices([...chalets, ...budget, budgetGlitch], 'Mixed');

    expect(suspect(out)).toEqual(['Budget glitch']);
  });
});

/**
 * The 7.0 review-score bar is OURS, not the provider's, and on a thin search it
 * worked against us twice: fewer options for the traveller, AND fewer peers for
 * every price check. A Val d'Isère search came back with exactly one hotel at
 * $3377.84/night, and one row cannot be an outlier — the median of a one-row
 * set is that row.
 *
 * So the bar bends when, and only when, there is not enough to compare.
 */
describe('pickByRating', () => {
  const rated = (name: string, rating: number) =>
    ({ ...hotel(name, 200, 3), rating }) as any;

  it('keeps the bar at 7.0 when there are enough good hotels', () => {
    const rows = [
      rated('A', 9.1),
      rated('B', 8.4),
      rated('C', 7.9),
      rated('D', 7.2),
      rated('Mediocre', 5.5),
    ];

    expect(names(pickByRating(rows, 'Rome'))).toEqual(['A', 'B', 'C', 'D']);
  });

  it('relaxes only as far as it needs to', () => {
    // Three rows clear 7.0, one more clears 6.0, one more clears 5.0. Stopping
    // at 6.0 reaches four, so the 5.2 stays out.
    const rows = [
      rated('A', 9.1),
      rated('B', 8.4),
      rated('C', 7.9),
      rated('Six', 6.4),
      rated('Five', 5.2),
    ];

    const kept = names(pickByRating(rows, 'Rome'));
    expect(kept).toContain('Six');
    expect(kept).not.toContain('Five');
    expect(kept).toHaveLength(4);
  });

  it('takes everything rather than leave a lone unverifiable hotel', () => {
    // The Val d'Isere shape: one row clears the bar and nothing can check it.
    const rows = [rated('Lone good', 9.6), rated('Poor', 4.1), rated('Worse', 3.0)];

    expect(pickByRating(rows, "Val d'Isere")).toHaveLength(3);
  });

  it('keeps an unrated row when that is all there is', () => {
    const rows = [rated('Unrated', 0), rated('Also unrated', 0)];

    expect(pickByRating(rows, 'Nowhere')).toHaveLength(2);
  });

  it('does not invent rows it was not given', () => {
    expect(pickByRating([], 'Empty')).toEqual([]);
  });

  it('treats a non-finite rating as unrated rather than crashing', () => {
    const rows = [rated('NaN rating', Number.NaN), rated('Good', 8.5)];

    expect(pickByRating(rows, 'Odd')).toHaveLength(2);
  });

  it('gives the price checks something to work with', () => {
    // The whole point: widening turns an uncheckable search into a checkable
    // one. Four rows in a tier is where flagSuspectPrices starts working, so
    // the glitch below is caught only because the bar bent.
    const rows = [
      rated('Normal A', 8.1),
      rated('Normal B', 7.4),
      { ...rated('Mediocre', 5.9), pricePerNight: 210 },
      { ...rated('Also mediocre', 5.1), pricePerNight: 190 },
      { ...rated('Glitch', 8.8), pricePerNight: 9000 },
    ];

    const widened = pickByRating(rows as any, "Val d'Isere");
    expect(widened).toHaveLength(5);
    expect(suspect(flagSuspectPrices(widened, "Val d'Isere"))).toEqual(['Glitch']);
  });
});
