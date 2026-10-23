import { hotelScore, rankHotels } from '@/lib/hotelScore';

/**
 * `hotels[0]` is the trip's hotel. `app/results/page.tsx` and
 * `app/canvas/[tripId]/page.tsx` both take index 0 and set
 * `selectedHotelIndex: 0`, and `lib/tripTotals.ts` builds the trip total from
 * the selected index. So whatever sorts first here IS the price the customer is
 * quoted.
 *
 * That makes the price term's direction the thing to watch. `100 / price`
 * means an over-priced row is self-punishing and sinks unaided, while an
 * under-priced one is self-rewarding and rises. Before this suite existed,
 * measured through this same `rankHotels`:
 *
 *   $0/night, rating 8.5   → score 40028.8 → FIRST
 *   -$50/night, rating 8.5 → score 40028.8 → FIRST
 *   $3/night, rating 9.2   → score 16415.7 → FIRST
 *   a legitimate hotel     → score ~235
 *   $3377.84/night         → score 11.9    → last, unaided
 *
 * Every guard written before this one was aimed at the $3377 case. The three
 * that actually became the trip's hotel were unguarded.
 */
const h = (name: string, rating: number, pricePerNight: number, extra: object = {}) => ({
  name,
  rating,
  pricePerNight,
  reviewCount: 500,
  ...extra,
});

const realistic = [
  h('Hotel David', 8.6, 204.32),
  h('Radisson Blu', 8.4, 170.31),
  h('B&B Laurus al Duomo', 8.8, 301.99),
  h('Plus Florence', 8.1, 159.87),
  h('Il Bargello', 9.0, 197.58),
];

const order = (rows: any[]) => rankHotels(rows).map((r) => r.name);

describe('hotelScore refuses to reward an unusable price', () => {
  const cases: Array<[string, number]> = [
    ['zero', 0],
    ['negative', -50],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];

  for (const [label, price] of cases) {
    it(`scores a ${label} price as 0, not as the best possible price`, () => {
      expect(hotelScore({ rating: 8.5, pricePerNight: price })).toBe(0);
    });
  }

  it('still scores a real price normally', () => {
    // Pins the formula itself, so the guard above cannot be "fixed" by
    // zeroing everything.
    // 8.5^2.8 x (100/200) = 400.29 / 2. No reviewCount prior is passed, so
    // effectiveRating is the rating itself.
    expect(hotelScore({ rating: 8.5, pricePerNight: 200 })).toBeCloseTo(200.14, 1);
  });

  it('never returns a non-finite score, whatever it is handed', () => {
    // The score is stamped onto the hotel and persisted with the trip.
    // JSON.stringify turns Infinity and NaN into null, which would corrupt a
    // saved trip rather than just mis-sort a list.
    const nasty = [
      { rating: Number.NaN, pricePerNight: 100 },
      { rating: Number.POSITIVE_INFINITY, pricePerNight: 100 },
      { rating: 8, pricePerNight: Number.MIN_VALUE },
      { rating: Number.MAX_VALUE, pricePerNight: 1 },
    ];

    for (const row of nasty) {
      const score = hotelScore(row);
      expect(Number.isFinite(score)).toBe(true);
      expect(JSON.parse(JSON.stringify({ score })).score).toBe(score);
    }
  });
});

describe('rankHotels never lets an unusable price win', () => {
  const cases: Array<[string, number]> = [
    ['$0', 0],
    ['-$50', -50],
    ['NaN', Number.NaN],
  ];

  for (const [label, price] of cases) {
    it(`sorts a ${label} row last instead of first`, () => {
      const ranked = order([...realistic, h('Garbage row', 8.5, price)]);

      expect(ranked[0]).not.toBe('Garbage row');
      expect(ranked[ranked.length - 1]).toBe('Garbage row');
    });
  }

  it('keeps the row rather than dropping it', () => {
    // Ranking's job is ordering. Removal is the backend's call, where the
    // provider context lives.
    expect(order([...realistic, h('Garbage row', 8.5, 0)])).toHaveLength(6);
  });

  it('is deterministic when several rows are unusable', () => {
    // A NaN score makes `b.score - a.score` return NaN, and a comparator that
    // returns NaN leaves the order up to the engine and the input sequence —
    // which is how a bad row could still surface first. Same input in two
    // orders must give the same winner.
    const junk = [h('J1', 8.5, 0), h('J2', 9.1, Number.NaN), h('J3', 7.5, -5)];
    const a = order([...junk, ...realistic]);
    const b = order([...realistic, ...junk]);

    expect(a[0]).toBe(b[0]);
    expect(a[0]).toBe('Il Bargello');
    expect(a.slice(-3).sort()).toEqual(['J1', 'J2', 'J3']);
  });

  it('still returns every row when all of them are unusable', () => {
    // Degenerate, but `hotels[0]` must exist — the pages index straight into it.
    const ranked = rankHotels([h('A', 8, 0), h('B', 9, Number.NaN), h('C', 7, -1)]);

    expect(ranked).toHaveLength(3);
    expect(ranked[0]).toBeDefined();
  });
});

describe('rankHotels demotes a row the backend flagged', () => {
  it('puts a suspect row last even when it would otherwise score best', () => {
    // The Val d'Isere shape after the backend's verdict: cheap enough to win
    // on price, but flagged, so it must not become the trip's hotel.
    const ranked = order([
      ...realistic,
      h('Flagged bargain', 9.5, 40, { priceSuspect: true }),
    ]);

    expect(ranked[0]).not.toBe('Flagged bargain');
    expect(ranked[ranked.length - 1]).toBe('Flagged bargain');
  });

  it('keeps a flagged row visible — nothing is deleted', () => {
    // The whole reason flagging replaced deleting: a Bora Bora search lost
    // three real overwater resorts to a delete-on-suspicion guard.
    const rows = [...realistic, h('Flagged resort', 9.4, 1942.66, { priceSuspect: true })];

    expect(order(rows)).toContain('Flagged resort');
    expect(order(rows)).toHaveLength(6);
  });

  it('treats priceSuspect: false and absent as the same', () => {
    const withFalse = order([...realistic, h('Fine', 9.2, 150, { priceSuspect: false })]);
    const withAbsent = order([...realistic, h('Fine', 9.2, 150)]);

    expect(withFalse).toEqual(withAbsent);
    expect(withFalse[0]).toBe('Fine');
  });

  it('orders flagged rows among themselves by score', () => {
    const ranked = order([
      ...realistic,
      h('Flagged dear', 9.0, 3000, { priceSuspect: true }),
      h('Flagged cheap', 9.0, 300, { priceSuspect: true }),
    ]);

    expect(ranked.slice(-2)).toEqual(['Flagged cheap', 'Flagged dear']);
  });

  it('ranks a suspect row below an unflagged one that scores worse', () => {
    // The partition is absolute, not a weighting. A flagged row does not get
    // to out-score its way back to the top.
    const ranked = order([
      h('Trusted but poor value', 7.1, 600),
      h('Flagged and excellent', 9.6, 90, { priceSuspect: true }),
    ]);

    expect(ranked).toEqual(['Trusted but poor value', 'Flagged and excellent']);
  });

  it('falls back gracefully when every row is flagged', () => {
    // Better to quote a suspicious price than to show an empty city, and the
    // backend logs every flag so this is visible rather than silent.
    const ranked = rankHotels([
      h('A', 8.0, 500, { priceSuspect: true }),
      h('B', 9.0, 200, { priceSuspect: true }),
    ]);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].name).toBe('B');
  });
});

describe('rankHotels ordering of trusted rows is unchanged', () => {
  it('ranks the realistic Florence set exactly as before', () => {
    // Regression guard: the demotion partition must not reshuffle ordinary
    // results. These positions predate this change.
    expect(order(realistic)).toEqual([
      'Il Bargello',
      'Radisson Blu',
      'Plus Florence',
      'Hotel David',
      'B&B Laurus al Duomo',
    ]);
  });

  it('still sinks an over-priced row without needing a flag', () => {
    // The direction that was always safe, pinned so nobody "strengthens" it
    // at the cost of the Bora Bora case again.
    const ranked = order([...realistic, h('Val d Isere 0-star', 8.5, 3377.84)]);

    expect(ranked[ranked.length - 1]).toBe('Val d Isere 0-star');
  });

  it('is a no-op on an empty list', () => {
    expect(rankHotels([])).toEqual([]);
  });
});
