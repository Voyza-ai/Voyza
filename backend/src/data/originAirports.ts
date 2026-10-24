/**
 * Multi-airport lookup for origin cities. When a user says "flying from
 * New York", we search flights from JFK/LGA/EWR in parallel and pick the
 * cheapest — huge for users in metros where different airports have very
 * different prices for the same route.
 *
 * Keys are normalized (lowercase, no punctuation, common aliases). Order
 * within each airport array is: primary international hub first, then
 * secondaries by passenger volume.
 *
 * Anywhere NOT in this map: resolved via getIataCode() to a single IATA
 * code — functional for smaller cities, just no multi-airport comparison.
 *
 * Adding a city: drop in a new entry, confirm IATA codes are ones Duffel
 * actually returns offers for, keep the array <=3 long (diminishing
 * returns and more offer-requests = more $$ / rate-limit pressure).
 *
 * Alias coverage (states, regions, metro aliases)
 * ------------------------------------------------
 * Someone typing "from New Jersey" / "Newark" / "Long Island" used to get
 * NO home flight at all and no error: the lookup missed, `originAirports`
 * came back empty, and the home-flight search was skipped silently.
 *
 * A WRONG airport is worse than none — the traveller gets priced from the
 * wrong place — so entries are added under two rules:
 *
 *   1. SAME-METRO SECONDARIES ONLY. Extra airports are added only when
 *      they sit in the same metropolitan area as the primary (the existing
 *      'new york', 'bay area' and 'dc' entries set this precedent), never
 *      merely "within driving distance". That's why 'connecticut' is BDL
 *      alone and not BDL+BOS, and 'rhode island' is PVD alone.
 *   2. ONE DOMINANT REFERENT. A name is only keyed when its plain reading
 *      overwhelmingly means one place.
 *
 * Deliberately NOT keyed, because no single airport is right:
 *   - States with two or more competing hubs: California (LAX/SFO),
 *     Texas (DFW/IAH/AUS), Florida (MIA/MCO/TPA), Pennsylvania (PHL/PIT),
 *     Ohio (CLE/CMH/CVG), North Carolina (CLT/RDU), Virginia (IAD/RIC/ORF),
 *     Tennessee (BNA/MEM), Missouri (STL/MCI), Wisconsin (MKE/ORD),
 *     Maine and New Hampshire (PWM/MHT vs BOS).
 *   - Names that denote two far-apart cities: "Portland" (OR ~2.5M vs ME
 *     ~0.55M — not dominant enough), "San Jose" (CA vs Costa Rica),
 *     "Arlington" (VA vs TX), "Alexandria" (VA vs Egypt).
 *   - Fuzzy regions: "Southern California" (LAX/SAN/SNA),
 *     "Northern California" (SFO/SMF), "Tri-State", "DMV".
 *   - Abbreviations that are common English words, where a mis-hit would
 *     return a wrong airport: IN, OR, HI, ME. ('LA' is already keyed to
 *     Los Angeles, so Louisiana is not keyed either.)
 */

const MULTI_AIRPORT_CITIES: Record<string, string[]> = {
  // ── North America
  'new york': ['JFK', 'LGA', 'EWR'],
  nyc: ['JFK', 'LGA', 'EWR'],
  'los angeles': ['LAX', 'BUR', 'LGB'],
  la: ['LAX', 'BUR', 'LGB'],
  'san francisco': ['SFO', 'OAK', 'SJC'],
  'bay area': ['SFO', 'OAK', 'SJC'],
  chicago: ['ORD', 'MDW'],
  'washington': ['IAD', 'DCA', 'BWI'],
  'washington dc': ['IAD', 'DCA', 'BWI'],
  'dc': ['IAD', 'DCA', 'BWI'],
  miami: ['MIA', 'FLL'],
  houston: ['IAH', 'HOU'],
  dallas: ['DFW', 'DAL'],
  seattle: ['SEA'],
  boston: ['BOS'],
  denver: ['DEN'],
  atlanta: ['ATL'],
  toronto: ['YYZ', 'YTZ'],
  montreal: ['YUL'],
  vancouver: ['YVR'],
  'mexico city': ['MEX', 'NLU'],

  // ── North America: additional US metros. These were missing entirely,
  // so "from Philadelphia" fell through to the Duffel/getIataCode path
  // (a network call + an airport_codes DB write) instead of resolving
  // here. They also back the state aliases below.
  philadelphia: ['PHL'],
  baltimore: ['BWI'],
  phoenix: ['PHX'],
  'las vegas': ['LAS'],
  'salt lake city': ['SLC'],
  minneapolis: ['MSP'],
  'twin cities': ['MSP'],
  detroit: ['DTW'],
  honolulu: ['HNL'],
  providence: ['PVD'],
  hartford: ['BDL'],

  // ── US metro aliases: places that ARE a known metro, just under a
  // different name. Only included where the name has one dominant
  // referent (see the "deliberately excluded" note in the header).
  newark: ['EWR', 'JFK', 'LGA'],
  'jersey city': ['EWR', 'JFK', 'LGA'],
  hoboken: ['EWR', 'JFK', 'LGA'],
  'staten island': ['EWR', 'JFK', 'LGA'],
  brooklyn: ['JFK', 'LGA', 'EWR'],
  queens: ['JFK', 'LGA', 'EWR'],
  manhattan: ['JFK', 'LGA', 'EWR'],
  bronx: ['JFK', 'LGA', 'EWR'],
  'the bronx': ['JFK', 'LGA', 'EWR'],
  'long island': ['JFK', 'LGA'],
  oakland: ['OAK', 'SFO', 'SJC'],
  'silicon valley': ['SJC', 'SFO', 'OAK'],
  'fort worth': ['DFW', 'DAL'],
  'ft worth': ['DFW', 'DAL'],
  'fort lauderdale': ['FLL', 'MIA'],

  // ── US states + USPS abbreviations. Only states with ONE dominant
  // airport/metro are here; see the header for the ones left out and why.
  // NOTE: 'washington' above is Washington DC and must stay that way —
  // the state is keyed 'washington state' / 'wa'.
  'new jersey': ['EWR', 'JFK', 'LGA'],
  nj: ['EWR', 'JFK', 'LGA'],
  'new york state': ['JFK', 'LGA', 'EWR'],
  ny: ['JFK', 'LGA', 'EWR'],
  connecticut: ['BDL'],
  ct: ['BDL'],
  'rhode island': ['PVD'],
  ri: ['PVD'],
  massachusetts: ['BOS'],
  ma: ['BOS'],
  'new england': ['BOS'],
  delaware: ['PHL'],
  de: ['PHL'],
  maryland: ['BWI'],
  md: ['BWI'],
  illinois: ['ORD', 'MDW'],
  il: ['ORD', 'MDW'],
  georgia: ['ATL'],
  ga: ['ATL'],
  arizona: ['PHX'],
  az: ['PHX'],
  nevada: ['LAS'],
  nv: ['LAS'],
  utah: ['SLC'],
  ut: ['SLC'],
  colorado: ['DEN'],
  co: ['DEN'],
  minnesota: ['MSP'],
  mn: ['MSP'],
  michigan: ['DTW'],
  mi: ['DTW'],
  hawaii: ['HNL'],
  oregon: ['PDX'],
  vermont: ['BTV'],
  vt: ['BTV'],
  'washington state': ['SEA'],
  wa: ['SEA'],

  // ── Europe
  london: ['LHR', 'LGW', 'STN'],
  paris: ['CDG', 'ORY'],
  moscow: ['SVO', 'DME', 'VKO'],
  istanbul: ['IST', 'SAW'],
  milan: ['MXP', 'LIN'],
  rome: ['FCO', 'CIA'],
  berlin: ['BER'],
  madrid: ['MAD'],
  barcelona: ['BCN'],
  amsterdam: ['AMS'],
  frankfurt: ['FRA'],
  munich: ['MUC'],
  zurich: ['ZRH'],
  vienna: ['VIE'],
  dublin: ['DUB'],
  lisbon: ['LIS'],
  stockholm: ['ARN', 'BMA'],

  // ── Asia
  tokyo: ['HND', 'NRT'],
  osaka: ['KIX', 'ITM'],
  seoul: ['ICN', 'GMP'],
  beijing: ['PEK', 'PKX'],
  shanghai: ['PVG', 'SHA'],
  'hong kong': ['HKG'],
  taipei: ['TPE', 'TSA'],
  singapore: ['SIN'],
  bangkok: ['BKK', 'DMK'],
  'kuala lumpur': ['KUL'],
  jakarta: ['CGK', 'HLP'],
  manila: ['MNL'],
  delhi: ['DEL'],
  mumbai: ['BOM'],

  // ── Oceania / Middle East / Africa
  sydney: ['SYD'],
  melbourne: ['MEL'],
  dubai: ['DXB', 'DWC'],
  'abu dhabi': ['AUH'],
  doha: ['DOH'],
  johannesburg: ['JNB'],
  'cape town': ['CPT'],
  cairo: ['CAI'],

  // ── South America
  'são paulo': ['GRU', 'CGH'],
  'sao paulo': ['GRU', 'CGH'],
  'rio de janeiro': ['GIG', 'SDU'],
  rio: ['GIG', 'SDU'],
  'buenos aires': ['EZE', 'AEP'],
  santiago: ['SCL'],
  lima: ['LIM'],
  bogotá: ['BOG'],
  bogota: ['BOG'],
};

/**
 * Keys that may be trusted as the QUALIFIER after a comma ("Newark, NJ").
 *
 * Only state-level keys appear here, and the city segment before the comma
 * is never trusted. Both restrictions are load-bearing — a looser rule was
 * measured against this table and produced 14 wrong airports out of 20
 * probes:
 *
 *   - Trusting the city segment maps any "<WorldCity>, <unmapped US state>"
 *     onto the foreign city: "Dublin, Ohio" -> DUB, "Vienna, Virginia" ->
 *     VIE, "Moscow, Idaho" -> SVO, "Berlin, New Hampshire" -> BER, "Lima,
 *     Ohio" -> LIM, "Paris, Texas" -> CDG. That pairing is common rather
 *     than rare, because the unmapped states are exactly the ones left out
 *     of this table on purpose.
 *   - Accepting any key as a qualifier trips over 'la' (Los Angeles, so
 *     "Baton Rouge, LA" -> LAX) and over the state abbreviations that are
 *     also ISO 3166-1 country codes.
 *
 * So these abbreviations are deliberately ABSENT below even though they are
 * keys in the table above: DE (Germany), IL (Israel), MA (Morocco), CO
 * (Colombia), AZ (Azerbaijan), MD (Moldova), GA (Gabon), MN (Mongolia).
 * Without that, "Berlin, DE" prices from Philadelphia and "Bogota, CO" from
 * Denver. 'georgia' is out for the same reason — the country, so "Tbilisi,
 * Georgia" must not resolve to ATL.
 *
 * The bare keys are kept, because a lone "CO" in an origin field is a US
 * state far more often than Colombia, and the full state name always works.
 * After a comma the odds invert, which is the whole reason for this set.
 */
const COMMA_QUALIFIER_KEYS = new Set<string>([
  'new jersey',
  'nj',
  // Both readings of a trailing "New York" — the state, or the city for
  // "Brooklyn, New York" — resolve to the same metro, so it is safe here.
  'new york',
  'new york state',
  'ny',
  'connecticut',
  'ct',
  'rhode island',
  'ri',
  'massachusetts',
  'new england',
  'delaware',
  'maryland',
  'illinois',
  'arizona',
  'nevada',
  'nv',
  'utah',
  'ut',
  'colorado',
  'minnesota',
  'michigan',
  'mi',
  'hawaii',
  'oregon',
  'vermont',
  'vt',
  'washington state',
  'wa',
]);

/**
 * Normalize a city name for lookup. Strips punctuation, lowercases,
 * trims whitespace. Leaves accents intact since the keys use them.
 * Stripping '.' also means "N.J." normalizes onto the 'nj' key.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[,.]/g, '')
    .trim();
}

/**
 * Every key this table answers.
 *
 * Exported for `scripts/build-location-hotset.ts`, which seeds the browser hot
 * set from it: the resolver cannot replace this table until the hot set
 * answers everything the table answered, offline, and that is asserted rather
 * than assumed. Nothing at runtime reads this.
 */
export const MULTI_AIRPORT_CITY_KEYS: readonly string[] = Object.keys(MULTI_AIRPORT_CITIES);

/**
 * Get up to N airports for a city. Returns an empty array if the city
 * isn't in the multi-airport map — callers should fall back to
 * getIataCode() for single-airport cities.
 */
export function getOriginAirports(cityName: string, max: number = 3): string[] {
  if (!cityName) return [];
  const normalized = normalize(cityName);
  const direct = MULTI_AIRPORT_CITIES[normalized];
  if (direct) return direct.slice(0, max);
  // Fallback: AI parsers commonly produce "<City> City" (e.g. New York
  // → "New York City", Quezon → "Quezon City"). When the bare suffix
  // didn't match, retry without the trailing " city" so the canonical
  // short form gets a hit. Direct lookup runs first so "mexico city",
  // "salt lake city" and "jersey city" are unaffected (they're keys).
  //
  // There is deliberately NO equivalent " state" strip: "washington
  // state" would strip to "washington", which is Washington DC here and
  // would price a Seattle traveller out of Dulles. It's keyed directly.
  if (normalized.endsWith(' city')) {
    const stripped = normalized.slice(0, -' city'.length);
    const list = MULTI_AIRPORT_CITIES[stripped];
    if (list) return list.slice(0, max);
  }
  // Fallback: "<City>, <State>" is the shape the AI most often produces for
  // a US origin ("Newark, NJ", "Vancouver, WA"). normalize() strips the
  // comma rather than splitting on it, so the whole string becomes the one
  // dead key "newark nj" and misses.
  //
  // Walk the comma segments right to left and accept ONLY a
  // COMMA_QUALIFIER_KEYS hit. Right-to-left matters: the part after the
  // comma is the disambiguator the user deliberately supplied, so it should
  // beat the city name ("Vancouver, WA" is Washington state, not Canada).
  // Restricting to qualifiers is what makes it safe — a city key can never
  // act as a qualifier, so "Paris, Texas" and "Dublin, Ohio" miss cleanly
  // instead of resolving to CDG and DUB. See COMMA_QUALIFIER_KEYS.
  if (cityName.includes(',')) {
    const segments = cityName.split(',').map(normalize).filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      if (!COMMA_QUALIFIER_KEYS.has(segments[i])) continue;
      const list = MULTI_AIRPORT_CITIES[segments[i]];
      if (list) return list.slice(0, max);
    }
  }
  return [];
}

/**
 * True if the city has multiple known airports (i.e. comparing across
 * them is worthwhile). Small cities with only 1 airport return false
 * and we skip the multi-origin search path.
 */
export function isMultiAirportCity(cityName: string): boolean {
  return getOriginAirports(cityName).length > 1;
}
