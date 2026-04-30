/**
 * Mirror of backend/src/data/originAirports.ts. Used on the planning
 * flow to pre-fill `originAirports` when the user types a home city,
 * so the backend doesn't have to re-lookup and the UI can show which
 * airports will be searched.
 *
 * Keep in sync with the backend list. If they drift, the backend still
 * works (it has its own lookup) — frontend will just miss an airport
 * in the pre-fill, not break.
 */

const MULTI_AIRPORT_CITIES: Record<string, string[]> = {
  'new york': ['JFK', 'LGA', 'EWR'],
  nyc: ['JFK', 'LGA', 'EWR'],
  'los angeles': ['LAX', 'BUR', 'LGB'],
  la: ['LAX', 'BUR', 'LGB'],
  'san francisco': ['SFO', 'OAK', 'SJC'],
  'bay area': ['SFO', 'OAK', 'SJC'],
  chicago: ['ORD', 'MDW'],
  washington: ['IAD', 'DCA', 'BWI'],
  'washington dc': ['IAD', 'DCA', 'BWI'],
  dc: ['IAD', 'DCA', 'BWI'],
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
  sydney: ['SYD'],
  melbourne: ['MEL'],
  dubai: ['DXB', 'DWC'],
  'abu dhabi': ['AUH'],
  doha: ['DOH'],
  johannesburg: ['JNB'],
  'cape town': ['CPT'],
  cairo: ['CAI'],
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

function normalize(name: string): string {
  return name.toLowerCase().replace(/[,.]/g, '').trim();
}

export function getOriginAirports(cityName: string, max: number = 3): string[] {
  if (!cityName) return [];
  const key = normalize(cityName);
  // Direct hit first. Cities like "mexico city" / "new york city" key
  // differently — "mexico city" lives in the table, "new york city"
  // doesn't (it's keyed as "new york").
  const direct = MULTI_AIRPORT_CITIES[key];
  if (direct) return direct.slice(0, max);
  // Fallback: AI parsers commonly produce "<City> City" (e.g. New York
  // → "New York City", Quezon → "Quezon City"). When the bare suffix
  // didn't match, retry without the trailing " city" so the canonical
  // short form ("new york") gets a hit. Direct lookup always runs first
  // so "mexico city" is unaffected.
  if (key.endsWith(' city')) {
    const stripped = key.slice(0, -' city'.length);
    const list = MULTI_AIRPORT_CITIES[stripped];
    if (list) return list.slice(0, max);
  }
  return [];
}
