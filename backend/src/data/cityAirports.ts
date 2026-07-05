/**
 * Curated city → primary IATA override map. Consulted BEFORE the
 * `airport_codes` cache and Duffel's place suggestions in getIataCode().
 *
 * Why this exists: the auto-resolver occasionally returns a wrong or
 * garbage code — e.g. "Kyoto" resolved to ACC (Accra, Ghana) because Kyoto
 * has no airport of its own and the fuzzy place search mismatched. Cities
 * served by a larger metro's airport (Kyoto/Nara → Osaka's Kansai) need a
 * deterministic mapping so inter-city legs don't become transpacific
 * flights.
 *
 * Keys are lowercase city names. Values are the metropolitan or primary
 * international airport IATA used for flight search. Multi-airport metros
 * use the city/metropolitan code (NYC, LON, TYO…) which Duffel accepts.
 */
export const CITY_AIRPORTS: Record<string, string> = {
  // North America
  'new york': 'NYC', 'los angeles': 'LAX', 'san francisco': 'SFO',
  chicago: 'CHI', 'las vegas': 'LAS', miami: 'MIA', boston: 'BOS',
  seattle: 'SEA', washington: 'WAS', 'new orleans': 'MSY', austin: 'AUS',
  honolulu: 'HNL', toronto: 'YTO', vancouver: 'YVR', montreal: 'YMQ',
  'mexico city': 'MEX', cancun: 'CUN', havana: 'HAV', 'panama city': 'PTY',

  // South America
  'rio de janeiro': 'RIO', 'sao paulo': 'SAO', 'buenos aires': 'BUE',
  lima: 'LIM', cusco: 'CUZ', santiago: 'SCL', bogota: 'BOG',
  cartagena: 'CTG', medellin: 'MDE', quito: 'UIO', 'la paz': 'LPB',
  montevideo: 'MVD',

  // Western Europe
  london: 'LON', edinburgh: 'EDI', manchester: 'MAN', dublin: 'DUB',
  paris: 'PAR', nice: 'NCE', lyon: 'LYS', marseille: 'MRS',
  amsterdam: 'AMS', brussels: 'BRU', luxembourg: 'LUX', berlin: 'BER',
  munich: 'MUC', frankfurt: 'FRA', hamburg: 'HAM', cologne: 'CGN',
  vienna: 'VIE', salzburg: 'SZG', zurich: 'ZRH', geneva: 'GVA',

  // Southern Europe
  rome: 'ROM', florence: 'FLR', venice: 'VCE', milan: 'MIL', naples: 'NAP',
  madrid: 'MAD', barcelona: 'BCN', seville: 'SVQ', valencia: 'VLC',
  malaga: 'AGP', bilbao: 'BIO', lisbon: 'LIS', porto: 'OPO', athens: 'ATH',
  santorini: 'JTR', mykonos: 'JMK', thessaloniki: 'SKG', dubrovnik: 'DBV',
  split: 'SPU', zagreb: 'ZAG', ljubljana: 'LJU', valletta: 'MLA',

  // Northern & Eastern Europe
  copenhagen: 'CPH', stockholm: 'STO', oslo: 'OSL', bergen: 'BGO',
  helsinki: 'HEL', reykjavik: 'REK', prague: 'PRG', budapest: 'BUD',
  warsaw: 'WAW', krakow: 'KRK', bucharest: 'BUH', sofia: 'SOF',
  belgrade: 'BEG', tallinn: 'TLL', riga: 'RIX', vilnius: 'VNO',
  moscow: 'MOW', 'saint petersburg': 'LED', kyiv: 'IEV',

  // Middle East
  istanbul: 'IST', dubai: 'DXB', 'abu dhabi': 'AUH', doha: 'DOH',
  'tel aviv': 'TLV', amman: 'AMM', beirut: 'BEY', riyadh: 'RUH',
  muscat: 'MCT',

  // Africa
  cairo: 'CAI', marrakech: 'RAK', casablanca: 'CMN', fez: 'FEZ',
  'cape town': 'CPT', johannesburg: 'JNB', nairobi: 'NBO', zanzibar: 'ZNZ',
  'addis ababa': 'ADD', accra: 'ACC', lagos: 'LOS', tunis: 'TUN',

  // South & Central Asia
  delhi: 'DEL', mumbai: 'BOM', jaipur: 'JAI', agra: 'AGR', goa: 'GOI',
  bengaluru: 'BLR', kathmandu: 'KTM', colombo: 'CMB', male: 'MLE',
  tashkent: 'TAS',

  // East Asia — Kyoto/Nara are served by Osaka's Kansai (KIX); Tokyo/Osaka
  // use their metro codes.
  tokyo: 'TYO', kyoto: 'KIX', osaka: 'OSA', nara: 'KIX', kobe: 'UKB',
  hiroshima: 'HIJ', sapporo: 'CTS', fukuoka: 'FUK', nagoya: 'NGO',
  okinawa: 'OKA', seoul: 'ICN', busan: 'PUS', jeju: 'CJU', beijing: 'PEK',
  shanghai: 'PVG', xian: 'XIY', chengdu: 'CTU', guilin: 'KWL',
  'hong kong': 'HKG', macau: 'MFM', taipei: 'TPE',

  // Southeast Asia
  bangkok: 'BKK', 'chiang mai': 'CNX', phuket: 'HKT', singapore: 'SIN',
  'kuala lumpur': 'KUL', bali: 'DPS', jakarta: 'JKT', hanoi: 'HAN',
  'ho chi minh city': 'SGN', 'siem reap': 'REP', 'phnom penh': 'PNH',
  // Hoi An has no airport — served by Da Nang.
  'hoi an': 'DAD', 'da nang': 'DAD', 'luang prabang': 'LPQ',
  manila: 'MNL', yangon: 'RGN',

  // Oceania
  sydney: 'SYD', melbourne: 'MEL', brisbane: 'BNE', perth: 'PER',
  cairns: 'CNS', auckland: 'AKL', queenstown: 'ZQN', wellington: 'WLG',
  nadi: 'NAN',
};

/**
 * Returns the curated IATA code for a city name (case/whitespace
 * insensitive), or undefined if the city isn't in the override map.
 */
export function getStaticIata(cityName: string): string | undefined {
  return CITY_AIRPORTS[cityName.trim().toLowerCase()];
}
