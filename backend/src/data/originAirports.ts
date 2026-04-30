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
 * Normalize a city name for lookup. Strips punctuation, lowercases,
 * trims whitespace. Leaves accents intact since the keys use them.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[,.]/g, '')
    .trim();
}

/**
 * Get up to N airports for a city. Returns an empty array if the city
 * isn't in the multi-airport map — callers should fall back to
 * getIataCode() for single-airport cities.
 */
export function getOriginAirports(cityName: string, max: number = 3): string[] {
  const normalized = normalize(cityName);
  const direct = MULTI_AIRPORT_CITIES[normalized];
  if (direct) return direct.slice(0, max);
  // Fallback: AI parsers commonly produce "<City> City" (e.g. New York
  // → "New York City", Quezon → "Quezon City"). When the bare suffix
  // didn't match, retry without the trailing " city" so the canonical
  // short form gets a hit. Direct lookup runs first so "mexico city"
  // is unaffected (it's already a key).
  if (normalized.endsWith(' city')) {
    const stripped = normalized.slice(0, -' city'.length);
    const list = MULTI_AIRPORT_CITIES[stripped];
    if (list) return list.slice(0, max);
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
