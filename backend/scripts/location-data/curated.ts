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
];
