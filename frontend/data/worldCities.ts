/**
 * Curated list of major world cities for the "Add a city" typeahead on the
 * canvas. Covers capitals and major metros across every region so users can
 * branch into a different country, not just nearby cities.
 *
 * Kept as a flat { city, country } list (not exhaustive) — enough breadth to
 * feel global while staying small enough to filter client-side instantly.
 * Filtering is case- and accent-insensitive (see `searchWorldCities`).
 */

export type WorldCity = { city: string; country: string };

export const WORLD_CITIES: WorldCity[] = [
  // ── North America ──
  { city: 'New York', country: 'United States' },
  { city: 'Los Angeles', country: 'United States' },
  { city: 'San Francisco', country: 'United States' },
  { city: 'Chicago', country: 'United States' },
  { city: 'Las Vegas', country: 'United States' },
  { city: 'Miami', country: 'United States' },
  { city: 'Boston', country: 'United States' },
  { city: 'Seattle', country: 'United States' },
  { city: 'Washington', country: 'United States' },
  { city: 'New Orleans', country: 'United States' },
  { city: 'Austin', country: 'United States' },
  { city: 'Honolulu', country: 'United States' },
  { city: 'Toronto', country: 'Canada' },
  { city: 'Vancouver', country: 'Canada' },
  { city: 'Montreal', country: 'Canada' },
  { city: 'Quebec City', country: 'Canada' },
  { city: 'Mexico City', country: 'Mexico' },
  { city: 'Cancun', country: 'Mexico' },
  { city: 'Guadalajara', country: 'Mexico' },
  { city: 'Oaxaca', country: 'Mexico' },
  { city: 'Havana', country: 'Cuba' },
  { city: 'Panama City', country: 'Panama' },
  { city: 'San Jose', country: 'Costa Rica' },

  // ── South America ──
  { city: 'Rio de Janeiro', country: 'Brazil' },
  { city: 'Sao Paulo', country: 'Brazil' },
  { city: 'Buenos Aires', country: 'Argentina' },
  { city: 'Lima', country: 'Peru' },
  { city: 'Cusco', country: 'Peru' },
  { city: 'Santiago', country: 'Chile' },
  { city: 'Bogota', country: 'Colombia' },
  { city: 'Cartagena', country: 'Colombia' },
  { city: 'Medellin', country: 'Colombia' },
  { city: 'Quito', country: 'Ecuador' },
  { city: 'La Paz', country: 'Bolivia' },
  { city: 'Montevideo', country: 'Uruguay' },

  // ── Western Europe ──
  { city: 'London', country: 'United Kingdom' },
  { city: 'Edinburgh', country: 'United Kingdom' },
  { city: 'Manchester', country: 'United Kingdom' },
  { city: 'Dublin', country: 'Ireland' },
  { city: 'Paris', country: 'France' },
  { city: 'Nice', country: 'France' },
  { city: 'Lyon', country: 'France' },
  { city: 'Marseille', country: 'France' },
  { city: 'Bordeaux', country: 'France' },
  { city: 'Amsterdam', country: 'Netherlands' },
  { city: 'Rotterdam', country: 'Netherlands' },
  { city: 'Brussels', country: 'Belgium' },
  { city: 'Bruges', country: 'Belgium' },
  { city: 'Luxembourg', country: 'Luxembourg' },
  { city: 'Berlin', country: 'Germany' },
  { city: 'Munich', country: 'Germany' },
  { city: 'Frankfurt', country: 'Germany' },
  { city: 'Hamburg', country: 'Germany' },
  { city: 'Cologne', country: 'Germany' },
  { city: 'Vienna', country: 'Austria' },
  { city: 'Salzburg', country: 'Austria' },
  { city: 'Zurich', country: 'Switzerland' },
  { city: 'Geneva', country: 'Switzerland' },
  { city: 'Interlaken', country: 'Switzerland' },

  // ── Southern Europe ──
  { city: 'Rome', country: 'Italy' },
  { city: 'Florence', country: 'Italy' },
  { city: 'Venice', country: 'Italy' },
  { city: 'Milan', country: 'Italy' },
  { city: 'Naples', country: 'Italy' },
  { city: 'Bologna', country: 'Italy' },
  { city: 'Turin', country: 'Italy' },
  { city: 'Madrid', country: 'Spain' },
  { city: 'Barcelona', country: 'Spain' },
  { city: 'Seville', country: 'Spain' },
  { city: 'Valencia', country: 'Spain' },
  { city: 'Granada', country: 'Spain' },
  { city: 'Malaga', country: 'Spain' },
  { city: 'Bilbao', country: 'Spain' },
  { city: 'Lisbon', country: 'Portugal' },
  { city: 'Porto', country: 'Portugal' },
  { city: 'Athens', country: 'Greece' },
  { city: 'Santorini', country: 'Greece' },
  { city: 'Mykonos', country: 'Greece' },
  { city: 'Thessaloniki', country: 'Greece' },
  { city: 'Dubrovnik', country: 'Croatia' },
  { city: 'Split', country: 'Croatia' },
  { city: 'Zagreb', country: 'Croatia' },
  { city: 'Ljubljana', country: 'Slovenia' },
  { city: 'Valletta', country: 'Malta' },

  // ── Northern & Eastern Europe ──
  { city: 'Copenhagen', country: 'Denmark' },
  { city: 'Stockholm', country: 'Sweden' },
  { city: 'Oslo', country: 'Norway' },
  { city: 'Bergen', country: 'Norway' },
  { city: 'Helsinki', country: 'Finland' },
  { city: 'Reykjavik', country: 'Iceland' },
  { city: 'Prague', country: 'Czechia' },
  { city: 'Budapest', country: 'Hungary' },
  { city: 'Warsaw', country: 'Poland' },
  { city: 'Krakow', country: 'Poland' },
  { city: 'Bucharest', country: 'Romania' },
  { city: 'Sofia', country: 'Bulgaria' },
  { city: 'Belgrade', country: 'Serbia' },
  { city: 'Tallinn', country: 'Estonia' },
  { city: 'Riga', country: 'Latvia' },
  { city: 'Vilnius', country: 'Lithuania' },
  { city: 'Moscow', country: 'Russia' },
  { city: 'Saint Petersburg', country: 'Russia' },
  { city: 'Kyiv', country: 'Ukraine' },

  // ── Middle East ──
  { city: 'Istanbul', country: 'Turkey' },
  { city: 'Cappadocia', country: 'Turkey' },
  { city: 'Antalya', country: 'Turkey' },
  { city: 'Dubai', country: 'United Arab Emirates' },
  { city: 'Abu Dhabi', country: 'United Arab Emirates' },
  { city: 'Doha', country: 'Qatar' },
  { city: 'Tel Aviv', country: 'Israel' },
  { city: 'Jerusalem', country: 'Israel' },
  { city: 'Amman', country: 'Jordan' },
  { city: 'Petra', country: 'Jordan' },
  { city: 'Beirut', country: 'Lebanon' },
  { city: 'Riyadh', country: 'Saudi Arabia' },
  { city: 'Muscat', country: 'Oman' },

  // ── Africa ──
  { city: 'Cairo', country: 'Egypt' },
  { city: 'Marrakech', country: 'Morocco' },
  { city: 'Casablanca', country: 'Morocco' },
  { city: 'Fez', country: 'Morocco' },
  { city: 'Cape Town', country: 'South Africa' },
  { city: 'Johannesburg', country: 'South Africa' },
  { city: 'Nairobi', country: 'Kenya' },
  { city: 'Zanzibar', country: 'Tanzania' },
  { city: 'Addis Ababa', country: 'Ethiopia' },
  { city: 'Accra', country: 'Ghana' },
  { city: 'Lagos', country: 'Nigeria' },
  { city: 'Tunis', country: 'Tunisia' },

  // ── South & Central Asia ──
  { city: 'Delhi', country: 'India' },
  { city: 'Mumbai', country: 'India' },
  { city: 'Jaipur', country: 'India' },
  { city: 'Agra', country: 'India' },
  { city: 'Goa', country: 'India' },
  { city: 'Bengaluru', country: 'India' },
  { city: 'Kathmandu', country: 'Nepal' },
  { city: 'Colombo', country: 'Sri Lanka' },
  { city: 'Malé', country: 'Maldives' },
  { city: 'Tashkent', country: 'Uzbekistan' },
  { city: 'Samarkand', country: 'Uzbekistan' },

  // ── East Asia ──
  { city: 'Tokyo', country: 'Japan' },
  { city: 'Kyoto', country: 'Japan' },
  { city: 'Osaka', country: 'Japan' },
  { city: 'Hiroshima', country: 'Japan' },
  { city: 'Sapporo', country: 'Japan' },
  { city: 'Nara', country: 'Japan' },
  { city: 'Fukuoka', country: 'Japan' },
  { city: 'Seoul', country: 'South Korea' },
  { city: 'Busan', country: 'South Korea' },
  { city: 'Jeju', country: 'South Korea' },
  { city: 'Beijing', country: 'China' },
  { city: 'Shanghai', country: 'China' },
  { city: 'Xian', country: 'China' },
  { city: 'Chengdu', country: 'China' },
  { city: 'Guilin', country: 'China' },
  { city: 'Hong Kong', country: 'Hong Kong' },
  { city: 'Macau', country: 'Macau' },
  { city: 'Taipei', country: 'Taiwan' },

  // ── Southeast Asia ──
  { city: 'Bangkok', country: 'Thailand' },
  { city: 'Chiang Mai', country: 'Thailand' },
  { city: 'Phuket', country: 'Thailand' },
  { city: 'Singapore', country: 'Singapore' },
  { city: 'Kuala Lumpur', country: 'Malaysia' },
  { city: 'Bali', country: 'Indonesia' },
  { city: 'Jakarta', country: 'Indonesia' },
  { city: 'Hanoi', country: 'Vietnam' },
  { city: 'Ho Chi Minh City', country: 'Vietnam' },
  { city: 'Hoi An', country: 'Vietnam' },
  { city: 'Siem Reap', country: 'Cambodia' },
  { city: 'Phnom Penh', country: 'Cambodia' },
  { city: 'Luang Prabang', country: 'Laos' },
  { city: 'Manila', country: 'Philippines' },
  { city: 'Cebu', country: 'Philippines' },
  { city: 'Yangon', country: 'Myanmar' },

  // ── Oceania ──
  { city: 'Sydney', country: 'Australia' },
  { city: 'Melbourne', country: 'Australia' },
  { city: 'Brisbane', country: 'Australia' },
  { city: 'Perth', country: 'Australia' },
  { city: 'Cairns', country: 'Australia' },
  { city: 'Auckland', country: 'New Zealand' },
  { city: 'Queenstown', country: 'New Zealand' },
  { city: 'Wellington', country: 'New Zealand' },
  { city: 'Nadi', country: 'Fiji' },
];

// Normalizes for matching: lowercase + strip accents/diacritics.
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Filters the world-cities list by a typed query. Prefix matches rank above
 * substring matches; also matches on country so e.g. "japan" surfaces
 * Japanese cities. `exclude` drops cities already on the canvas.
 */
/**
 * Country for a known city name, or '' when we don't know it. Used to fill
 * the country line on city cards for AI-planned trips, which (unlike the
 * hand-curated Browse presets) arrive with no country data.
 */
export function countryForCity(cityName: string): string {
  const q = normalize(cityName);
  if (!q) return '';
  for (const c of WORLD_CITIES) {
    if (normalize(c.city) === q) return c.country;
  }
  return '';
}

export function searchWorldCities(
  query: string,
  exclude: string[] = [],
  limit = 8,
): WorldCity[] {
  const q = normalize(query);
  if (!q) return [];
  const excluded = new Set(exclude.map(normalize));

  const prefix: WorldCity[] = [];
  const contains: WorldCity[] = [];
  for (const c of WORLD_CITIES) {
    if (excluded.has(normalize(c.city))) continue;
    const name = normalize(c.city);
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q) || normalize(c.country).includes(q)) contains.push(c);
  }
  return [...prefix, ...contains].slice(0, limit);
}
