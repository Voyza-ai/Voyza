/**
 * ════════════════════════════════════════════════════════════════════════════
 *  HAND-MAINTAINED. Not generated. Edit this file by hand; the build reads it.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The curated layer exists because three things no open dataset contains are
 * load-bearing for this product:
 *
 *  1. COLLOQUIAL NAMES. Verified against the GeoNames dump: `the bay area`,
 *     `silicon valley` and `dc` return ZERO rows — name, ascii name and
 *     alternate names alike. (`nyc` and `la` do appear in GeoNames alternate
 *     names, contrary to the brief; they are kept here anyway because `la` is
 *     two characters and the generator refuses auto-aliases shorter than
 *     three, and because losing either to an upstream edit would be silent.)
 *
 *  2. METRO GROUPING. OurAirports has no metro concept at all. LTN/STN/SEN do
 *     not group to London and EWR does not group to New York in the source
 *     data. The geographic join recovers most of this, but not the cases where
 *     the airport sits in another city's gravity well (EWR is 14 km from New
 *     York City and 5 km from Newark) or another country.
 *
 *  3. AIRPORT ORDER. `airports[0]` is load-bearing: `estimateHomeLegCost`
 *     prices every route permutation from it alone. The only openly-licensed
 *     prominence signal is the OurAirports `type` ordinal, which has THREE
 *     levels — it cannot separate LHR from LCY, or JFK from LGA. Measured,
 *     type-then-distance puts LCY ahead of LHR for London and LGA ahead of
 *     JFK for New York. So the multi-airport metros are ordered by hand.
 *     Annual passenger counts would derive this, and are not openly licensed
 *     globally; that was confirmed and is not to be re-litigated.
 *
 * Migrated from `src/data/originAirports.ts` and `src/data/cityAirports.ts`.
 * The second of those exists because "Kyoto" once resolved to ACC, Accra,
 * Ghana — Kyoto has no airport and the fuzzy place search mismatched. Those
 * overrides are kept verbatim below.
 *
 * Every reference in this file is resolved against the GeoNames dump at build
 * time and the build FAILS on a reference that matches nothing. A silent
 * curated miss would be the same class of bug as the one this replaces.
 */

/** A city in the GeoNames dump, by the name it is filed under. */
export type CityRef = {
  /** Matched against GeoNames name, ascii name or an alternate name. */
  name: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** GeoNames admin1 code, where it is needed to disambiguate. */
  admin?: string;
};

/** A place that is not a city in any dataset: a metro area or a named region. */
export type CuratedPlace = {
  /** Stable id suffix. `cur:<slug>`. Never change one in place. */
  slug: string;
  name: string;
  aliases: string[];
  kind: 'metro' | 'region';
  country: string;
  admin: string | null;
  lat: number;
  lon: number;
  /** IATA metropolitan code, where one exists. */
  metro: string | null;
  /** Ordered. Index 0 is what a non-asking caller prices from. */
  airports: string[];
  why: string;
};

/**
 * A group of real cities that share one airport pool.
 *
 * Every member gets the group's `metro` code and the group's airports, in the
 * group's order, all with `servesPlace: true` — which is the owner's rule and
 * is NOT "inside the border": Newark is in New Jersey and is one of New York
 * City's three airports.
 */
export type MetroGroup = {
  key: string;
  /** IATA metropolitan code, or null where IATA publishes none. */
  metro: string | null;
  members: CityRef[];
  airports: string[];
  why: string;
};

/** An extra name for a real city. */
export type CuratedAlias = {
  alias: string;
  target: CityRef;
};

/**
 * An ordered airport list for one city, overriding the derived order.
 *
 * `exhaustive: true` replaces the derived list entirely — use it when the
 * geographic join attaches an airport a traveller would not actually use.
 * Otherwise the listed codes lead and the derived ones follow.
 */
export type AirportOverride = {
  place: CityRef;
  airports: string[];
  exhaustive?: boolean;
  why: string;
};

/** Airports for an admin1 region, where the derived set is wrong or empty. */
export type RegionAirportOverride = {
  /** GeoNames admin1 code, e.g. "US.DE". */
  admin1: string;
  airports: string[];
  why: string;
};

// ─── Metro groups ────────────────────────────────────────────────────────────

export const METRO_GROUPS: MetroGroup[] = [
  {
    key: 'new-york',
    metro: 'NYC',
    members: [
      { name: 'New York City', country: 'US', admin: 'NY' },
      { name: 'Newark', country: 'US', admin: 'NJ' },
      { name: 'Jersey City', country: 'US', admin: 'NJ' },
      { name: 'Hoboken', country: 'US', admin: 'NJ' },
      { name: 'Brooklyn', country: 'US', admin: 'NY' },
      { name: 'Queens', country: 'US', admin: 'NY' },
      { name: 'Manhattan', country: 'US', admin: 'NY' },
      { name: 'The Bronx', country: 'US', admin: 'NY' },
      { name: 'Staten Island', country: 'US', admin: 'NY' },
      { name: 'Yonkers', country: 'US', admin: 'NY' },
    ],
    airports: ['JFK', 'LGA', 'EWR'],
    why:
      'EWR is in New Jersey. Border logic drops it from New York City and the ' +
      'traveller loses the cheapest of the three. Order matches the legacy ' +
      'originAirports table: international hub first, then by passenger volume.',
  },
  {
    key: 'london',
    metro: 'LON',
    members: [
      { name: 'London', country: 'GB', admin: 'ENG' },
      { name: 'Luton', country: 'GB', admin: 'ENG' },
      { name: 'Southend-on-Sea', country: 'GB', admin: 'ENG' },
    ],
    airports: ['LHR', 'LGW', 'STN', 'LTN', 'LCY', 'SEN'],
    why:
      'OurAirports files LTN as "Luton, Luton" and SEN as "Southend-on-Sea, ' +
      'Essex", so neither strings nor gravity attach them to London on their ' +
      'own. Order is by hand: type-then-distance puts LCY (medium, 13 km) ' +
      'ahead of LHR (large, 24 km), which would price every London trip from ' +
      'City.',
  },
  {
    key: 'paris',
    metro: 'PAR',
    members: [{ name: 'Paris', country: 'FR', admin: '11' }],
    airports: ['CDG', 'ORY', 'BVA'],
    why: 'CDG is filed as "Paris (Roissy-en-France, Val-d\'Oise)". BVA is marketed as Paris Beauvais.',
  },
  {
    key: 'milan',
    metro: 'MIL',
    members: [{ name: 'Milan', country: 'IT', admin: '09' }],
    airports: ['MXP', 'LIN', 'BGY'],
    why: 'No Milan airport carries "Milan" in its municipality: Ferno (VA), Segrate (MI), Orio al Serio (BG).',
  },
  {
    key: 'rome',
    metro: 'ROM',
    members: [{ name: 'Rome', country: 'IT', admin: '07' }],
    airports: ['FCO', 'CIA'],
    why: 'Both are large/medium and close; hand order puts Fiumicino first.',
  },
  {
    key: 'washington',
    metro: 'WAS',
    members: [
      { name: 'Washington', country: 'US', admin: 'DC' },
      { name: 'Arlington', country: 'US', admin: 'VA' },
      { name: 'Alexandria', country: 'US', admin: 'VA' },
    ],
    airports: ['IAD', 'DCA', 'BWI'],
    why: 'BWI is a Baltimore airport that serves the DC metro. Order migrated from originAirports.',
  },
  {
    key: 'chicago',
    metro: 'CHI',
    members: [{ name: 'Chicago', country: 'US', admin: 'IL' }],
    airports: ['ORD', 'MDW'],
    why: 'Both large; ORD must lead.',
  },
  {
    key: 'los-angeles',
    metro: null,
    members: [{ name: 'Los Angeles', country: 'US', admin: 'CA' }],
    airports: ['LAX', 'BUR', 'LGB', 'SNA', 'ONT'],
    why:
      'BUR is a large_airport 20 km out and LAX is a large_airport 19 km out, ' +
      'so type-then-distance is a coin flip between them. The architecture ' +
      'document names this exact failure: alphabetical or near-tie ordering ' +
      'prices every Los Angeles trip from Burbank.',
  },
  {
    key: 'san-francisco',
    metro: null,
    members: [
      { name: 'San Francisco', country: 'US', admin: 'CA' },
      { name: 'Oakland', country: 'US', admin: 'CA' },
      { name: 'Berkeley', country: 'US', admin: 'CA' },
    ],
    airports: ['SFO', 'OAK', 'SJC'],
    why: 'Three separate cities, one fare market. Migrated from originAirports.',
  },
  {
    key: 'tokyo',
    metro: 'TYO',
    members: [{ name: 'Tokyo', country: 'JP', admin: '40' }],
    airports: ['HND', 'NRT'],
    why: 'NRT is filed under Narita, 64 km out. HND must lead for pricing.',
  },
  {
    key: 'osaka',
    metro: 'OSA',
    members: [
      { name: 'Osaka', country: 'JP', admin: '32' },
      { name: 'Kyoto', country: 'JP', admin: '22' },
      { name: 'Nara-shi', country: 'JP', admin: '28' },
      { name: 'Kobe', country: 'JP', admin: '13' },
    ],
    airports: ['KIX', 'ITM', 'UKB'],
    why:
      'THE KYOTO BUG. Kyoto has no airport of its own and once resolved to ' +
      'ACC, Accra, Ghana, turning an inter-city leg into a transpacific ' +
      'flight. Kyoto and Nara are served by Kansai. Carried over from ' +
      'cityAirports.ts verbatim.',
  },
  {
    key: 'seoul',
    metro: 'SEL',
    members: [{ name: 'Seoul', country: 'KR', admin: '11' }],
    airports: ['ICN', 'GMP'],
    why: 'ICN is 48 km out and GMP 17 km; distance ordering would lead with Gimpo.',
  },
  {
    key: 'beijing',
    metro: 'BJS',
    members: [{ name: 'Beijing', country: 'CN', admin: '22' }],
    airports: ['PEK', 'PKX'],
    why: 'Both large; PEK leads.',
  },
  {
    key: 'shanghai',
    metro: null,
    members: [{ name: 'Shanghai', country: 'CN', admin: '23' }],
    airports: ['PVG', 'SHA'],
    why: 'PVG is the international gateway at 34 km; SHA is closer at 12 km and would lead on distance.',
  },
  {
    key: 'moscow',
    metro: 'MOW',
    members: [{ name: 'Moscow', country: 'RU', admin: '48' }],
    airports: ['SVO', 'DME', 'VKO'],
    why: 'Order migrated from originAirports.',
  },
  {
    key: 'istanbul',
    metro: null,
    members: [{ name: 'Istanbul', country: 'TR', admin: '34' }],
    airports: ['IST', 'SAW'],
    why: 'Both ~33 km out on opposite sides of the city; distance ordering is a coin flip.',
  },
  {
    key: 'toronto',
    metro: 'YTO',
    members: [{ name: 'Toronto', country: 'CA', admin: '08' }],
    airports: ['YYZ', 'YTZ'],
    why: 'YTZ (Billy Bishop) is 9 km out and YYZ 19 km; distance ordering would lead with the island airport.',
  },
  {
    key: 'montreal',
    metro: 'YMQ',
    members: [{ name: 'Montreal', country: 'CA', admin: '10' }],
    airports: ['YUL'],
    why: 'Migrated from originAirports; keeps the metro code production already uses.',
  },
  {
    key: 'stockholm',
    metro: 'STO',
    members: [{ name: 'Stockholm', country: 'SE', admin: '26' }],
    airports: ['ARN', 'BMA', 'NYO'],
    why: 'ARN is 36 km out and BMA 8 km; distance ordering would lead with Bromma.',
  },
  {
    key: 'sao-paulo',
    metro: 'SAO',
    members: [{ name: 'São Paulo', country: 'BR', admin: '27' }],
    airports: ['GRU', 'CGH'],
    why: 'CGH (Congonhas) is the closer one and must not lead.',
  },
  {
    key: 'rio-de-janeiro',
    metro: 'RIO',
    members: [{ name: 'Rio de Janeiro', country: 'BR', admin: '21' }],
    airports: ['GIG', 'SDU'],
    why: 'SDU (Santos Dumont) is the closer one and must not lead.',
  },
  {
    key: 'buenos-aires',
    metro: 'BUE',
    members: [{ name: 'Buenos Aires', country: 'AR', admin: '07' }],
    airports: ['EZE', 'AEP'],
    why: 'AEP (Aeroparque) is the closer one and must not lead.',
  },
  {
    key: 'mexico-city',
    metro: null,
    members: [{ name: 'Mexico City', country: 'MX', admin: '09' }],
    airports: ['MEX', 'NLU'],
    why: 'Migrated from originAirports.',
  },
  {
    key: 'houston',
    metro: null,
    members: [{ name: 'Houston', country: 'US', admin: 'TX' }],
    airports: ['IAH', 'HOU'],
    why: 'HOU (Hobby) is closer and must not lead.',
  },
  {
    key: 'dallas',
    metro: null,
    members: [
      { name: 'Dallas', country: 'US', admin: 'TX' },
      { name: 'Fort Worth', country: 'US', admin: 'TX' },
    ],
    airports: ['DFW', 'DAL'],
    why: 'DAL (Love Field) is closer to downtown Dallas and must not lead.',
  },
  {
    key: 'miami',
    metro: null,
    members: [
      { name: 'Miami', country: 'US', admin: 'FL' },
      { name: 'Fort Lauderdale', country: 'US', admin: 'FL' },
    ],
    airports: ['MIA', 'FLL'],
    why: 'One fare market across two cities. Migrated from originAirports.',
  },
  {
    key: 'bangkok',
    metro: null,
    members: [{ name: 'Bangkok', country: 'TH', admin: '40' }],
    airports: ['BKK', 'DMK'],
    why: 'DMK (Don Mueang) is closer and must not lead.',
  },
  {
    key: 'taipei',
    metro: null,
    members: [{ name: 'Taipei', country: 'TW', admin: '04' }],
    airports: ['TPE', 'TSA'],
    why: 'TSA (Songshan) is the in-city airport and must not lead.',
  },
  {
    key: 'jakarta',
    metro: 'JKT',
    members: [{ name: 'Jakarta', country: 'ID', admin: '04' }],
    airports: ['CGK', 'HLP'],
    why: 'HLP (Halim) is closer and must not lead.',
  },
  {
    key: 'dubai',
    metro: null,
    members: [{ name: 'Dubai', country: 'AE', admin: '03' }],
    airports: ['DXB', 'DWC'],
    why: 'Migrated from originAirports.',
  },
  {
    key: 'basel',
    metro: null,
    members: [
      { name: 'Basel', country: 'CH', admin: 'BS' },
      { name: 'Mulhouse', country: 'FR', admin: '44' },
    ],
    airports: ['BSL'],
    why:
      'CROSS-BORDER. EuroAirport is filed by OurAirports in FR as "Bâle / ' +
      'Mulhouse". The generic join is same-country only — that one rule is ' +
      'what stops BUF attaching to Hamilton, Ontario, HKG to Shenzhen and TLL ' +
      'to Helsinki across the Gulf of Finland — so a Swiss city cannot reach a ' +
      'French airport without being named here.',
  },
];

// ─── Curated places that exist in no dataset ─────────────────────────────────

export const CURATED_PLACES: CuratedPlace[] = [
  {
    slug: 'sf-bay-area',
    name: 'San Francisco Bay Area',
    aliases: ['the bay area', 'bay area', 'sf bay area', 'the bay', 'norcal'],
    kind: 'metro',
    country: 'US',
    admin: 'CA',
    lat: 37.6,
    lon: -122.15,
    metro: null,
    airports: ['SFO', 'OAK', 'SJC'],
    why: 'GeoNames returns zero rows for "bay area" in name, ascii name and alternate names.',
  },
  {
    slug: 'silicon-valley',
    name: 'Silicon Valley',
    aliases: ['silicon valley', 'the valley', 'south bay'],
    kind: 'metro',
    country: 'US',
    admin: 'CA',
    lat: 37.37,
    lon: -122.04,
    metro: null,
    airports: ['SJC', 'SFO', 'OAK'],
    why:
      'Zero rows in GeoNames. Order differs from the Bay Area entry on ' +
      'purpose: San Jose is the valley\'s own airport. Migrated from ' +
      'originAirports.',
  },
  {
    slug: 'long-island',
    name: 'Long Island',
    aliases: ['long island'],
    kind: 'region',
    country: 'US',
    admin: 'NY',
    lat: 40.79,
    lon: -73.13,
    metro: null,
    airports: ['JFK', 'LGA', 'ISP'],
    why: 'Zero rows in GeoNames. Migrated from originAirports, which had JFK+LGA; ISP is its own scheduled airport.',
  },
  {
    slug: 'new-england',
    name: 'New England',
    aliases: ['new england'],
    kind: 'region',
    country: 'US',
    admin: null,
    lat: 42.36,
    lon: -71.06,
    metro: null,
    airports: ['BOS', 'PVD', 'MHT', 'BDL'],
    why:
      'Zero rows in GeoNames. originAirports keyed this to BOS alone under its ' +
      '"same-metro secondaries only" rule; here the extra airports are safe ' +
      'because every one is shown with its distance and the traveller picks.',
  },
  {
    slug: 'santorini',
    name: 'Santorini',
    aliases: ['santorini', 'thira', 'thera'],
    kind: 'region',
    country: 'GR',
    admin: 'ESYE42',
    lat: 36.4,
    lon: 25.43,
    metro: null,
    airports: ['JTR'],
    why:
      'GeoNames has the island\'s town as "Firá" (pop 2,376) and no row named ' +
      'Santorini at all. Migrated from cityAirports.ts.',
  },
  {
    slug: 'bali',
    name: 'Bali',
    aliases: ['bali'],
    kind: 'region',
    country: 'ID',
    admin: '02',
    lat: -8.65,
    lon: 115.22,
    metro: null,
    airports: ['DPS'],
    why:
      'The only GeoNames rows named "Bali" are in Cameroon, China and India. ' +
      'The island is served by Denpasar. Migrated from cityAirports.ts.',
  },
];

// ─── Colloquial names and abbreviations ──────────────────────────────────────

export const CURATED_ALIASES: CuratedAlias[] = [
  { alias: 'nyc', target: { name: 'New York City', country: 'US', admin: 'NY' } },
  { alias: 'new york', target: { name: 'New York City', country: 'US', admin: 'NY' } },
  { alias: 'the big apple', target: { name: 'New York City', country: 'US', admin: 'NY' } },
  { alias: 'la', target: { name: 'Los Angeles', country: 'US', admin: 'CA' } },
  { alias: 'l a', target: { name: 'Los Angeles', country: 'US', admin: 'CA' } },
  // A bare `washington` is the capital, not the state.
  //
  // This is the one input where the resolver and the hand-written table it
  // replaces disagreed about WHICH PLACE is meant, and the table is right for
  // an origin field: `originAirports.ts` keys `washington` to IAD, DCA, BWI,
  // and `nearestAirport.ts` names its DC row exactly `Washington`, so every
  // "use my location" tap in the DC metro produces this string.
  //
  // Without it, prominence puts Washington State first (0.370 against 0.329)
  // and a caller that cannot stop to ask — which is all of them today — gets
  // Seattle for someone in DC. A curated alias is a decision, which is what
  // this layer is for, and it makes the flip to `live` reproduce all 132 of
  // the table's answers instead of 131.
  //
  // It does NOT swallow the state: `Washington State` goes through the
  // admin-suffix path, which filters to state and region kinds, and
  // `Vancouver, Washington` still qualifies through the state, because a city
  // key may never act as a qualifier.
  { alias: 'washington', target: { name: 'Washington', country: 'US', admin: 'DC' } },
  { alias: 'dc', target: { name: 'Washington', country: 'US', admin: 'DC' } },
  { alias: 'washington dc', target: { name: 'Washington', country: 'US', admin: 'DC' } },
  { alias: 'd c', target: { name: 'Washington', country: 'US', admin: 'DC' } },
  { alias: 'sf', target: { name: 'San Francisco', country: 'US', admin: 'CA' } },
  { alias: 'philly', target: { name: 'Philadelphia', country: 'US', admin: 'PA' } },
  { alias: 'nola', target: { name: 'New Orleans', country: 'US', admin: 'LA' } },
  { alias: 'vegas', target: { name: 'Las Vegas', country: 'US', admin: 'NV' } },
  { alias: 'twin cities', target: { name: 'Minneapolis', country: 'US', admin: 'MN' } },
  { alias: 'chi town', target: { name: 'Chicago', country: 'US', admin: 'IL' } },
  { alias: 'the bronx', target: { name: 'The Bronx', country: 'US', admin: 'NY' } },
  { alias: 'nara', target: { name: 'Nara-shi', country: 'JP', admin: '28' } },
  { alias: 'hoi an', target: { name: 'Hoi An', country: 'VN', admin: '48' } },
  { alias: 'saigon', target: { name: 'Ho Chi Minh City', country: 'VN', admin: '79' } },
  { alias: 'bombay', target: { name: 'Mumbai', country: 'IN', admin: '16' } },
  { alias: 'bangalore', target: { name: 'Bengaluru', country: 'IN', admin: '19' } },
  { alias: 'calcutta', target: { name: 'Kolkata', country: 'IN', admin: '28' } },
  { alias: 'madras', target: { name: 'Chennai', country: 'IN', admin: '25' } },
  { alias: 'peking', target: { name: 'Beijing', country: 'CN', admin: '22' } },
  { alias: 'cuzco', target: { name: 'Cusco', country: 'PE', admin: '08' } },
];

// ─── Airport overrides for individual cities ─────────────────────────────────

export const AIRPORT_OVERRIDES: AirportOverride[] = [
  {
    place: { name: 'Hoi An', country: 'VN', admin: '48' },
    airports: ['DAD'],
    why: 'Hoi An has no airport and is served by Da Nang, 25 km away. Migrated from cityAirports.ts.',
  },
  {
    place: { name: 'Zanzibar', country: 'TZ', admin: '25' },
    airports: ['ZNZ'],
    why: 'Migrated from cityAirports.ts; the island\'s airport is filed under a different municipality.',
  },
  // KYOTO AND NARA ARE AUTHORED, NOT INHERITED.
  //
  // Both are members of the `osaka` metro group, whose `why` names them
  // explicitly ("Kyoto and Nara are served by Kansai"). They used to get KIX
  // first by riding the group's hand order, which is the same propagation that
  // put New York's JFK on Newark — so the order has to be written for these
  // two places or it is not theirs.
  //
  // It cannot be left to the derived sort. Measured from each centre, ITM is
  // simply nearer (Kyoto: ITM 39 km, KIX 81; Nara: ITM 35 km, KIX 51), so
  // serves-then-rank-then-distance leads with Itami — which is domestic-focused
  // and carries almost no long-haul. Kansai is the international gateway both
  // cities actually fly from, which is what the override protects.
  {
    place: { name: 'Kyoto', country: 'JP', admin: '22' },
    airports: ['KIX'],
    why:
      'THE KYOTO BUG, authored for Kyoto itself. Kyoto has no airport and once ' +
      'resolved to ACC, Accra, Ghana. ITM is nearer (39 km vs 81) but ' +
      'domestic-focused; Kansai is the gateway. Only KIX is pinned — ITM and ' +
      'UKB follow by the derived sort.',
  },
  {
    place: { name: 'Nara-shi', country: 'JP', admin: '28' },
    airports: ['KIX'],
    why:
      'Same as Kyoto: ITM is nearer (35 km vs 51) and domestic-focused, and ' +
      'Nara is served by Kansai. Authored here rather than inherited from the ' +
      'osaka group.',
  },
  // ─── GATEWAY VERSUS CLOSE-IN AIRPORT, AUTHORED PER CITY ────────────────────
  //
  // Every entry below is the three-level `type` ordinal failing in exactly the
  // way point 3 of this file's header describes. In each case BOTH airports are
  // `large_airport`, so the ordinal cannot separate them, `km` decides, and the
  // nearer one is the domestic or secondary field while the farther one is the
  // city's only international gateway. Distances are measured from each city
  // centre on the current dump, pre-pin lead first.
  //
  // These are not new opinions. Each one is a decision already written down in
  // the tables this layer replaces — `src/data/originAirports.ts` and
  // `src/data/cityAirports.ts` — which the derived order had started to
  // contradict. Only the gateway is pinned; the rest of each list follows the
  // derived serves-then-rank-then-distance sort, as with Kyoto above.
  {
    place: { name: 'Manhattan', country: 'US', admin: 'NY' },
    airports: ['JFK'],
    why:
      'LGA 7.9 km led JFK 22.5 on distance alone — the JFK-versus-LGA case ' +
      'this file\'s header names. LaGuardia carries no long-haul. ' +
      'originAirports.ts keys `manhattan` to JFK, LGA, EWR; the artifact had ' +
      'stopped agreeing.',
  },
  {
    place: { name: 'The Bronx', country: 'US', admin: 'NY' },
    airports: ['JFK'],
    why:
      'Same as Manhattan: LGA 8.1 km led JFK 24.5. originAirports.ts keys ' +
      '`bronx` and `the bronx` to JFK, LGA, EWR. Authored for this place, not ' +
      'copied from New York City — Brooklyn, Queens, Staten Island and Jersey ' +
      'City already lead correctly on the derived sort and are left alone.',
  },
  {
    place: { name: 'Kuala Lumpur', country: 'MY', admin: '14' },
    airports: ['KUL'],
    why:
      'SZB (Subang) 15.3 km led KUL (Sepang) 44.1. Subang is the turboprop and ' +
      'business-aviation field; Kuala Lumpur International is the gateway. ' +
      'cityAirports.ts and originAirports.ts both key `kuala lumpur` to KUL.',
  },
  {
    place: { name: 'Doha', country: 'QA', admin: '01' },
    airports: ['DOH'],
    why:
      'DIA is the OLD Doha International, still filed large_airport with ' +
      'scheduled service, and at 4.5 km it led Hamad (DOH) at 7.9 — 3.4 km ' +
      'decided which airport every Qatar trip was priced from. cityAirports.ts ' +
      'keys `doha` to DOH.',
  },
  {
    place: { name: 'Amman', country: 'JO', admin: '16' },
    airports: ['AMM'],
    why:
      'ADJ (Marka, the civil and military field) 4.8 km led Queen Alia (AMM) ' +
      '26.3. Queen Alia is Jordan\'s only international gateway. ' +
      'cityAirports.ts keys `amman` to AMM.',
  },
  {
    place: { name: 'Colombo', country: 'LK', admin: '36' },
    airports: ['CMB'],
    why:
      'RML (Ratmalana) 13.3 km led Bandaranaike (CMB) 27.6. Ratmalana is ' +
      'domestic. cityAirports.ts keys `colombo` to CMB.',
  },
  // The two below are NEW claims — no legacy table covered either city — and
  // are here because the measurement is the same shape and is not a close call.
  {
    place: { name: 'Tehran', country: 'IR', admin: '26' },
    airports: ['IKA'],
    why:
      'THR (Mehrabad) 9.7 km led Imam Khomeini (IKA) 39.4. Mehrabad is the ' +
      'domestic airport; essentially all international service is at IKA, so ' +
      'the derived order priced every Iranian trip from an airport that cannot ' +
      'fly it.',
  },
  {
    place: { name: 'Incheon', country: 'KR', admin: '12' },
    airports: ['ICN'],
    why:
      'ICN is Incheon\'s OWN airport — OurAirports files it under municipality ' +
      '"Incheon" — and Korea\'s gateway, but GMP (Seoul\'s domestic airport) ' +
      'at 13.6 km led it at 22.5. Scoped to Incheon alone: Suwon and the other ' +
      'Seoul satellites have no claim on ICN and are left on the derived sort.',
  },
];

// ─── Airport overrides for states and regions ────────────────────────────────

export const REGION_AIRPORT_OVERRIDES: RegionAirportOverride[] = [
  {
    admin1: 'US.DE',
    airports: ['PHL'],
    why:
      'THE DELAWARE CASE. Delaware\'s only scheduled airport is ILG (Wilmington); ' +
      'Philadelphia is the airport a traveller from Delaware actually uses. The ' +
      'owner\'s answer is to show PHL with its drive distance rather than invent ' +
      'a rule about it, so it is attached with servesPlace true and a real km. ' +
      'Migrated from originAirports, where `delaware` and `de` both mapped to PHL.',
  },
  {
    admin1: 'US.DC',
    airports: ['IAD', 'DCA', 'BWI'],
    why:
      'The District of Columbia inherits nothing useful from the derived sort: ' +
      'DCA is a large airport 5 km from the centroid and IAD a large airport ' +
      '37 km out, so type-then-distance leads with Reagan. Pinned to match the ' +
      'Washington metro group, because "dc" resolves to both.',
  },
  {
    admin1: 'IN.33',
    airports: ['GOI'],
    why: 'GeoNames has no city row named Goa; the state is the name travellers use. Migrated from cityAirports.ts.',
  },
  // THE KYOTO AND NARA PREFECTURES, AUTHORED RATHER THAN INHERITED.
  //
  // "Kyoto" and "Nara" each name a city and a prefecture, and the prefecture is
  // the more populous of the two — so a traveller typing either can land on the
  // region. Both centroids are nearer Itami than Kansai (Kyoto: ITM 35 km, KIX
  // 77; Nara: ITM 38 km, KIX 51), so the derived sort leads with ITM, which is
  // domestic-focused and carries almost no long-haul.
  //
  // Same reasoning as US.DC below it: a region does NOT inherit its leading
  // metro's order any more, so where the close-in airport is the wrong lead it
  // has to be written down for that region. Only KIX is pinned; ITM and UKB
  // follow by the derived sort.
  {
    admin1: 'JP.22',
    airports: ['KIX'],
    why:
      'Kyoto prefecture, matching the Kyoto city override. Kansai is the ' +
      'international gateway; Itami is nearer but domestic-focused, and a ' +
      'long-haul planner must not lead with it.',
  },
  {
    admin1: 'JP.28',
    airports: ['KIX'],
    why: 'Nara prefecture, matching the Nara-shi override. Same Kansai-vs-Itami reasoning as JP.22.',
  },
  // ─── THE MULTI-AIRPORT-METRO REGIONS ──────────────────────────────────────
  //
  // A region orders by the derived sort and inherits no order from the metro
  // inside it. That is right nearly everywhere, and wrong for exactly one
  // shape: the region's population-weighted centroid lands beside the metro's
  // CLOSE-IN SECONDARY airport, both airports are `large_airport` so the
  // three-level ordinal cannot separate them, and `km` then picks the
  // secondary. Measured on this dump, that priced an intercontinental trip
  // from Orly, Ciampino, Linate, Gimpo, Hongqiao, Halim, Don Mueang,
  // Aeroparque, Viracopos, Itami, Taichung, Birmingham, Burbank, Midway,
  // Newark, Vnukovo, Subang, Marka, Mehrabad, old Doha International or
  // Ratmalana — one level up from the city, where the city's own pin cannot
  // reach because a pin is never inherited.
  //
  // km below is from that region's centroid, pre-pin lead first. Only the
  // gateway is pinned; everything after it follows the derived sort.
  //
  // A DERIVED RULE WAS TRIED HERE AND MEASURED NOT TO PAY. Promoting the most
  // populous member city's own lead airport fixes these cases and REGRESSES
  // ten US states — Florida to JAX 327 km (Jacksonville's consolidated
  // city-county figure beats Miami), Connecticut to LGA 106 km (in New York),
  // Virginia to ORF, Missouri to MCI, Alabama to HSV, Kansas to ICT, Montana
  // to BIL, North Dakota to FAR, South Carolina to CAE, Wyoming to CYS — plus
  // Buenos Aires province to MDQ (rank 2, 307 km, against EZE at 74). "Most
  // populous city proper" is as bad a proxy for a region's gateway as centroid
  // distance is, and no scalar separates Texas (+145 km, right) from Florida
  // (+230 km, wrong). So the handful that matter are authored here instead.
  { admin1: 'FR.11', airports: ['CDG'], why: 'Île-de-France: ORY 13.7 led CDG 23.2. Orly carries little long-haul; Roissy is the gateway. Matches the paris metro group.' },
  { admin1: 'IT.07', airports: ['FCO'], why: 'Lazio: CIA 3.4 led FCO 27.3. Ciampino is the low-cost field; Fiumicino is the gateway. Matches the rome group.' },
  { admin1: 'IT.09', airports: ['MXP'], why: 'Lombardy: LIN 8.5 and BGY 35.4 both led MXP 46.9. Linate is the city-centre airport; Malpensa is the gateway. Matches the milan group.' },
  { admin1: 'GB.ENG', airports: ['LHR'], why: 'England: BHX 51.2, LTN 64.4 and EMA 64.9 all led LHR 98 — the centroid sits in the Midlands. Heathrow is the gateway. Matches the london group.' },
  { admin1: 'RU.48', airports: ['SVO'], why: 'Moscow federal city: VKO 27.9 led SVO 28.4 by half a kilometre. Sheremetyevo leads in the moscow group and in originAirports.ts.' },
  { admin1: 'KR.11', airports: ['ICN'], why: 'Seoul: GMP 16.5 led ICN 47.7. Gimpo is domestic-focused; Incheon is the gateway. Matches the seoul group.' },
  { admin1: 'KR.12', airports: ['ICN'], why: 'Incheon: GMP 13.5 led ICN 22.3 — Seoul\'s domestic airport ahead of the gateway that sits inside this region. Matches the Incheon city override.' },
  { admin1: 'CN.23', airports: ['PVG'], why: 'Shanghai: SHA 8.9 led PVG 36.8. Hongqiao is the domestic airport; Pudong is the gateway. Matches the shanghai group.' },
  { admin1: 'JP.32', airports: ['KIX'], why: 'Osaka prefecture: ITM 13.9 and UKB 27.6 both led KIX 37.5. Itami is domestic-focused; Kansai is the gateway. Matches the osaka group and the JP.22/JP.28 pins.' },
  { admin1: 'TW.04', airports: ['TPE'], why: 'Taiwan province: RMQ 51 led TPE 70.1. Taichung is regional; Taoyuan is the gateway. Matches the taipei group.' },
  { admin1: 'TR.34', airports: ['IST'], why: 'Istanbul: IST 33.2 leads SAW 34.3 by 1.1 km with no pin at all, so an upstream coordinate nudge flips a traveller from the gateway to the low-cost field on the far side of the Bosphorus. Pinned for stability rather than to change the answer — it is already right, and 1.1 km is not a margin.' },
  { admin1: 'TH.40', airports: ['BKK'], why: 'Bangkok: DMK 19.8 led BKK 24.8. Don Mueang is the low-cost field; Suvarnabhumi is the gateway. Matches the bangkok group.' },
  { admin1: 'ID.04', airports: ['CGK'], why: 'Jakarta: HLP 7.7 led CGK 23.2. Halim is the secondary; Soekarno-Hatta is the gateway. Matches the jakarta group.' },
  { admin1: 'MY.14', airports: ['KUL'], why: 'Kuala Lumpur federal territory: SZB 15 led KUL 45. Subang is the turboprop field; KLIA is the gateway. Matches the Kuala Lumpur city override.' },
  { admin1: 'IR.26', airports: ['IKA'], why: 'Tehran province: THR 7.1 led IKA 33.1. Mehrabad is domestic; Imam Khomeini is the gateway. Matches the Tehran city override.' },
  { admin1: 'JO.16', airports: ['AMM'], why: 'Amman governorate: ADJ 7.1 led AMM 25.4. Marka is the civil/military field; Queen Alia is the gateway. Matches the Amman city override.' },
  { admin1: 'QA.01', airports: ['DOH'], why: 'Doha municipality: DIA 4.4 led DOH 7.8 — the old Doha International ahead of Hamad. Matches the Doha city override.' },
  { admin1: 'LK.36', airports: ['CMB'], why: 'Western Province, Sri Lanka: RML 10.5 led CMB 29.4. Ratmalana is domestic; Bandaranaike is the gateway. Matches the Colombo city override.' },
  { admin1: 'BR.27', airports: ['GRU'], why: 'São Paulo state: VCP 6.5 led GRU 79.8 — the centroid lands by Viracopos in Campinas. Guarulhos is the gateway. Matches the sao-paulo group.' },
  { admin1: 'AR.07', airports: ['EZE'], why: 'Buenos Aires F.D.: AEP 6.9 led EZE 27.4. Aeroparque is the domestic airport; Ezeiza is the gateway. Matches the buenos-aires group.' },
  {
    admin1: 'US.CA',
    airports: ['LAX', 'SFO', 'SAN'],
    why:
      'California has three distinct major metros and the derived order ' +
      'reaches none of them properly: the state centroid sits near ' +
      'Bakersfield, so distance led BUR 146.9 (the named Burbank failure, one ' +
      'level up from the city) and filled the rest with FAT and LGB. Only ' +
      'THREE airports survive the MAX_HOME_AIRPORTS cap, so a single pin ' +
      'spent all three slots inside Greater Los Angeles and a traveller in ' +
      'San Francisco typing `California` was priced from LA. Pinned to cover ' +
      'Los Angeles, the Bay Area and San Diego instead \u2014 all rank 3 and all ' +
      'attached. originAirports.ts deliberately keys no California entry, ' +
      'calling it ambiguous, so this is an authored judgement rather than a ' +
      'migration: change the list if you want different metros.',
  },
  { admin1: 'US.IL', airports: ['ORD'], why: 'Illinois: MDW 41.5 led ORD 49.1, both rank 3. originAirports.ts keys `illinois` to ORD then MDW. Matches the chicago group.' },
  { admin1: 'US.NY', airports: ['JFK'], why: 'New York state: EWR 30.1 and LGA 33.4 both led JFK 49.5. originAirports.ts keys `new york state` and `ny` to JFK, LGA, EWR.' },
  {
    admin1: 'US.TX',
    airports: ['DFW', 'IAH', 'AUS'],
    why:
      'Same shape as California, and it is why the earlier single pin was ' +
      'wrong twice over. The centroid sits by Killeen, so distance led AUS ' +
      '93 with DAL 212, DFW 213, IAH 238 and HOU 264 all rank 3 behind it. ' +
      'Pinning DFW alone made the priced three DFW, AUS, SAT and pushed ' +
      'HOUSTON \u2014 the largest metro in the state \u2014 outside the cap; pinning ' +
      'IAH alone did the same to Dallas. No single choice fits both. Pinned ' +
      'to Dallas, Houston and Austin. CORRECTED TWICE: an earlier version ' +
      'pinned IAH on the stated grounds that originAirports.ts keys Texas to ' +
      'it. It does not key Texas at all \u2014 it lists DFW/IAH/AUS under its ' +
      '"deliberately NOT keyed" set as competing hubs, which is exactly the ' +
      'three pinned here.',
  },
];
