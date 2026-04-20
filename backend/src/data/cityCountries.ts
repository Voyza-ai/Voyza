/**
 * Static map of popular travel cities to their ISO 3166-1 alpha-2 country
 * code. Used by the optimizer to enforce the "keep same-country cities
 * contiguous" routing constraint so we never suggest itineraries like
 * Tokyo → Shanghai → Osaka → Beijing.
 *
 * Lookup is case-insensitive and tolerant of common accents.
 * If a city isn't in the map, the caller should treat its country as
 * unknown (and typically skip the clustering filter rather than drop
 * permutations that might be fine).
 */

const entries: Array<[string, string]> = [
  // Japan
  ['tokyo', 'JP'], ['kyoto', 'JP'], ['osaka', 'JP'], ['hiroshima', 'JP'],
  ['nara', 'JP'], ['nagoya', 'JP'], ['sapporo', 'JP'], ['fukuoka', 'JP'],
  ['yokohama', 'JP'], ['hakone', 'JP'], ['nikko', 'JP'], ['kanazawa', 'JP'],
  ['sendai', 'JP'], ['nagano', 'JP'], ['kobe', 'JP'], ['okinawa', 'JP'],

  // South Korea
  ['seoul', 'KR'], ['busan', 'KR'], ['jeju', 'KR'], ['incheon', 'KR'],
  ['gyeongju', 'KR'], ['daegu', 'KR'], ['gwangju', 'KR'],

  // China
  ['beijing', 'CN'], ['shanghai', 'CN'], ['xian', 'CN'], ['chengdu', 'CN'],
  ['hangzhou', 'CN'], ['suzhou', 'CN'], ['nanjing', 'CN'], ['guangzhou', 'CN'],
  ['shenzhen', 'CN'], ['chongqing', 'CN'], ['harbin', 'CN'],

  // Hong Kong / Macau / Taiwan (treated as separate country entries for
  // clustering purposes — travelers consider these distinct trips)
  ['hongkong', 'HK'], ['hong kong', 'HK'], ['macau', 'MO'],
  ['taipei', 'TW'], ['kaohsiung', 'TW'], ['taichung', 'TW'], ['tainan', 'TW'],

  // Thailand
  ['bangkok', 'TH'], ['chiang mai', 'TH'], ['phuket', 'TH'], ['krabi', 'TH'],
  ['koh samui', 'TH'], ['pattaya', 'TH'], ['hua hin', 'TH'],

  // Vietnam
  ['hanoi', 'VN'], ['ho chi minh city', 'VN'], ['saigon', 'VN'],
  ['da nang', 'VN'], ['hoi an', 'VN'], ['ha long bay', 'VN'],

  // Indonesia
  ['bali', 'ID'], ['jakarta', 'ID'], ['yogyakarta', 'ID'], ['ubud', 'ID'],

  // Philippines
  ['manila', 'PH'], ['cebu', 'PH'], ['palawan', 'PH'], ['boracay', 'PH'],

  // Singapore / Malaysia
  ['singapore', 'SG'],
  ['kuala lumpur', 'MY'], ['penang', 'MY'], ['langkawi', 'MY'],

  // India
  ['delhi', 'IN'], ['mumbai', 'IN'], ['bangalore', 'IN'], ['bengaluru', 'IN'],
  ['jaipur', 'IN'], ['agra', 'IN'], ['goa', 'IN'], ['kolkata', 'IN'],
  ['chennai', 'IN'], ['varanasi', 'IN'], ['udaipur', 'IN'], ['kerala', 'IN'],

  // UAE / Turkey
  ['dubai', 'AE'], ['abu dhabi', 'AE'],
  ['istanbul', 'TR'], ['cappadocia', 'TR'], ['antalya', 'TR'],

  // Italy
  ['rome', 'IT'], ['milan', 'IT'], ['florence', 'IT'], ['venice', 'IT'],
  ['naples', 'IT'], ['pisa', 'IT'], ['siena', 'IT'], ['bologna', 'IT'],
  ['cinque terre', 'IT'], ['amalfi', 'IT'], ['palermo', 'IT'], ['catania', 'IT'],

  // France
  ['paris', 'FR'], ['nice', 'FR'], ['lyon', 'FR'], ['marseille', 'FR'],
  ['bordeaux', 'FR'], ['strasbourg', 'FR'], ['toulouse', 'FR'], ['cannes', 'FR'],

  // Spain / Portugal
  ['madrid', 'ES'], ['barcelona', 'ES'], ['seville', 'ES'], ['valencia', 'ES'],
  ['granada', 'ES'], ['san sebastian', 'ES'], ['malaga', 'ES'], ['bilbao', 'ES'],
  ['lisbon', 'PT'], ['porto', 'PT'], ['algarve', 'PT'], ['sintra', 'PT'],

  // UK / Ireland
  ['london', 'GB'], ['edinburgh', 'GB'], ['glasgow', 'GB'], ['manchester', 'GB'],
  ['bath', 'GB'], ['oxford', 'GB'], ['cambridge', 'GB'], ['belfast', 'GB'],
  ['dublin', 'IE'], ['galway', 'IE'], ['cork', 'IE'], ['killarney', 'IE'],

  // Germany / Austria / Switzerland
  ['berlin', 'DE'], ['munich', 'DE'], ['hamburg', 'DE'], ['frankfurt', 'DE'],
  ['cologne', 'DE'], ['dresden', 'DE'], ['heidelberg', 'DE'],
  ['vienna', 'AT'], ['salzburg', 'AT'], ['innsbruck', 'AT'], ['hallstatt', 'AT'],
  ['zurich', 'CH'], ['geneva', 'CH'], ['lucerne', 'CH'], ['interlaken', 'CH'],
  ['zermatt', 'CH'], ['bern', 'CH'],

  // Netherlands / Belgium
  ['amsterdam', 'NL'], ['rotterdam', 'NL'], ['the hague', 'NL'], ['utrecht', 'NL'],
  ['brussels', 'BE'], ['bruges', 'BE'], ['ghent', 'BE'], ['antwerp', 'BE'],

  // Scandinavia
  ['stockholm', 'SE'], ['gothenburg', 'SE'],
  ['copenhagen', 'DK'],
  ['oslo', 'NO'], ['bergen', 'NO'],
  ['helsinki', 'FI'],
  ['reykjavik', 'IS'],

  // Central / Eastern Europe
  ['prague', 'CZ'], ['cesky krumlov', 'CZ'],
  ['budapest', 'HU'],
  ['warsaw', 'PL'], ['krakow', 'PL'], ['gdansk', 'PL'],
  ['athens', 'GR'], ['santorini', 'GR'], ['mykonos', 'GR'], ['crete', 'GR'],
  ['rhodes', 'GR'], ['corfu', 'GR'],
  ['dubrovnik', 'HR'], ['split', 'HR'], ['zagreb', 'HR'],

  // Russia / Ukraine
  ['moscow', 'RU'], ['saint petersburg', 'RU'], ['st petersburg', 'RU'],
  ['kyiv', 'UA'], ['kiev', 'UA'],

  // North America — USA
  ['new york', 'US'], ['new york city', 'US'], ['nyc', 'US'],
  ['los angeles', 'US'], ['san francisco', 'US'], ['chicago', 'US'],
  ['miami', 'US'], ['seattle', 'US'], ['boston', 'US'], ['washington dc', 'US'],
  ['austin', 'US'], ['denver', 'US'], ['las vegas', 'US'], ['new orleans', 'US'],
  ['nashville', 'US'], ['portland', 'US'], ['philadelphia', 'US'],
  ['honolulu', 'US'], ['maui', 'US'], ['orlando', 'US'], ['san diego', 'US'],

  // Canada
  ['toronto', 'CA'], ['vancouver', 'CA'], ['montreal', 'CA'], ['quebec city', 'CA'],
  ['calgary', 'CA'], ['banff', 'CA'], ['ottawa', 'CA'],

  // Mexico / Central America / Caribbean
  ['mexico city', 'MX'], ['cancun', 'MX'], ['tulum', 'MX'], ['playa del carmen', 'MX'],
  ['puerto vallarta', 'MX'], ['cabo san lucas', 'MX'], ['oaxaca', 'MX'],
  ['havana', 'CU'],
  ['san jose', 'CR'], ['tamarindo', 'CR'],
  ['panama city', 'PA'],

  // South America
  ['rio de janeiro', 'BR'], ['sao paulo', 'BR'], ['salvador', 'BR'],
  ['buenos aires', 'AR'], ['mendoza', 'AR'], ['bariloche', 'AR'], ['ushuaia', 'AR'],
  ['lima', 'PE'], ['cusco', 'PE'], ['machu picchu', 'PE'], ['arequipa', 'PE'],
  ['santiago', 'CL'],
  ['bogota', 'CO'], ['medellin', 'CO'], ['cartagena', 'CO'],
  ['quito', 'EC'], ['galapagos', 'EC'],

  // Africa
  ['cape town', 'ZA'], ['johannesburg', 'ZA'],
  ['cairo', 'EG'], ['luxor', 'EG'],
  ['marrakech', 'MA'], ['casablanca', 'MA'], ['fes', 'MA'],
  ['nairobi', 'KE'],
  ['zanzibar', 'TZ'],

  // Oceania
  ['sydney', 'AU'], ['melbourne', 'AU'], ['brisbane', 'AU'], ['cairns', 'AU'],
  ['perth', 'AU'], ['gold coast', 'AU'],
  ['auckland', 'NZ'], ['queenstown', 'NZ'], ['wellington', 'NZ'],
  ['christchurch', 'NZ'],
];

const MAP = new Map(entries);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[ō]/g, 'o')
    .replace(/[ū]/g, 'u')
    .replace(/[ā]/g, 'a')
    .replace(/[ē]/g, 'e')
    .replace(/[ī]/g, 'i')
    .replace(/[áàäâ]/g, 'a')
    .replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u')
    .replace(/\s+/g, ' ');
}

/**
 * Return the ISO country code for a city, or undefined if unknown.
 * Callers (e.g. the optimizer) should treat undefined as "skip clustering
 * check for this city" rather than blocking the route.
 */
export function getCityCountry(cityName: string): string | undefined {
  if (!cityName) return undefined;
  return MAP.get(normalize(cityName));
}
