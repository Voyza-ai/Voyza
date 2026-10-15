import {
  classifySpot,
  classifyResolved,
  properNounPrefix,
  cleanSpotQuery,
  distanceKm,
  buildCitySpots,
  headWords,
  isSettlement,
  normalizeName,
  samePlace,
  buildRecommendedSpots,
  MAX_SPOT_KM,
} from '@/lib/citySpots';
import type { Trip } from '@/lib/types';

const hotel = (name: string, area = 'Centre') => ({
  name,
  rating: 8,
  pricePerNight: 100,
  area,
});

function tripWith(overrides: Partial<Trip> = {}, cityOverrides: any = {}): Trip {
  const city: any = {
    name: 'Paris',
    country: 'France',
    dates: { arrival: '2027-09-10', departure: '2027-09-13' },
    transportIn: { mode: 'flight', operator: '', duration: '', price: 0 },
    transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
    hotel: hotel('Hôtel Malte Opéra'),
    hotels: [hotel('Hôtel Malte Opéra')],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    ...cityOverrides,
  };
  return {
    title: 'Test',
    status: 'planning',
    totalCost: 0,
    savings: 0,
    travelers: 2,
    cities: [city],
    savingsTips: [],
    ...overrides,
  } as Trip;
}

describe('classifySpot', () => {
  it('treats landmarks as sightseeing', () => {
    expect(classifySpot('Louvre Museum early-entry')).toBe('sightseeing');
    expect(classifySpot('Sacré-Cœur Basilica')).toBe('sightseeing');
    expect(classifySpot('Schönbrunn Palace tour')).toBe('sightseeing');
    expect(classifySpot('Charles Bridge at sunrise')).toBe('sightseeing');
  });

  it('treats things you do as activities', () => {
    expect(classifySpot('Canal ring bike loop')).toBe('activity');
    expect(classifySpot('Jordaan neighborhood café crawl')).toBe('activity');
    expect(classifySpot('Wine tasting in Montmartre')).toBe('activity');
  });
});

describe('classifyResolved', () => {
  it('trusts OSM over the wording — the real "Louvre" bug', () => {
    // "Louvre early-entry morning" has no landmark word, so the keyword guess
    // called it an activity. OSM knows it is tourism=museum.
    expect(classifySpot('Louvre early-entry morning')).toBe('activity');
    expect(classifyResolved('Louvre early-entry morning', 'tourism', 'museum')).toBe(
      'sightseeing',
    );
  });

  it('keeps genuine activities as activities', () => {
    expect(classifyResolved('Canal ring bike loop', 'highway', 'cycleway')).toBe('activity');
    expect(classifyResolved('Jordaan café crawl', 'amenity', 'cafe')).toBe('activity');
  });

  it('counts historic places and worship sites as sights', () => {
    expect(classifyResolved('Charles Bridge', 'historic', 'bridge')).toBe('sightseeing');
    expect(classifyResolved('Sacré-Cœur', 'amenity', 'place_of_worship')).toBe('sightseeing');
  });

  it('counts parks and gardens as sights', () => {
    expect(classifyResolved('Vondelpark stroll', 'leisure', 'park')).toBe('sightseeing');
  });

  it('falls back to the wording when OSM says nothing', () => {
    expect(classifyResolved('Van Gogh Museum visit')).toBe('sightseeing');
    expect(classifyResolved('street food tour')).toBe('activity');
  });
});

describe('cleanSpotQuery', () => {
  it('strips timing filler that misleads the geocoder', () => {
    expect(cleanSpotQuery('Louvre early-entry morning')).toBe('Louvre');
    expect(cleanSpotQuery('Colosseum guided tickets')).toBe('Colosseum');
  });

  it('does not leave a dangling preposition behind', () => {
    expect(cleanSpotQuery('Montmartre at sunset')).toBe('Montmartre');
    expect(cleanSpotQuery('Sacré-Cœur in the evening')).toBe('Sacré-Cœur');
  });

  it('keeps the place words intact', () => {
    expect(cleanSpotQuery('Van Gogh Museum')).toBe('Van Gogh Museum');
    expect(cleanSpotQuery('Hôtel Malte Opéra')).toBe('Hôtel Malte Opéra');
  });

  it('never returns trailing punctuation', () => {
    expect(cleanSpotQuery('Colosseum tickets,')).not.toMatch(/[,\-–—]$/);
  });
});

describe('properNounPrefix', () => {
  it('keeps the place name and drops the description', () => {
    // Real activity text that failed to geocode in one go.
    expect(properNounPrefix('Senso-ji Temple and Asakusa old town')).toBe('Senso-ji Temple');
    expect(properNounPrefix('TeamLab Planets digital art museum')).toBe('TeamLab Planets');
    expect(properNounPrefix('Shibuya Crossing at golden hour')).toBe('Shibuya Crossing');
    expect(properNounPrefix('Tsukiji Outer Market breakfast crawl')).toBe('Tsukiji Outer Market');
    expect(properNounPrefix('Montmartre and Sacré-Cœur at sunset')).toBe('Montmartre');
  });

  it('gives nothing when the text has no leading proper noun', () => {
    // No better query exists, so the caller should just drop it.
    expect(properNounPrefix('street food tour')).toBe('');
    expect(properNounPrefix('canal ring bike loop')).toBe('');
  });

  it('leaves an already-clean name alone', () => {
    expect(properNounPrefix('Van Gogh Museum')).toBe('Van Gogh Museum');
  });
});

describe('distanceKm', () => {
  it('is ~0 for the same point', () => {
    expect(distanceKm({ lat: 48.85, lon: 2.35 }, { lat: 48.85, lon: 2.35 })).toBeCloseTo(0, 5);
  });

  it('measures Paris→Amsterdam at roughly 430km', () => {
    const d = distanceKm({ lat: 48.853, lon: 2.348 }, { lat: 52.373, lon: 4.892 });
    expect(d).toBeGreaterThan(400);
    expect(d).toBeLessThan(460);
  });

  it('puts a cross-continent mismatch far outside the spot radius', () => {
    // The guard that stops "Central Park, Paris" pinning in New York.
    const d = distanceKm({ lat: 48.853, lon: 2.348 }, { lat: 40.78, lon: -73.97 });
    expect(d).toBeGreaterThan(MAX_SPOT_KM);
  });
});

describe('buildCitySpots', () => {
  it('scopes every query to the city and country', () => {
    const trip = tripWith({}, { activities: ['Louvre'], restaurants: [{ name: 'Chartier', cuisine: 'French', priceRange: '$' }] });
    const spots = buildCitySpots(trip, 0);
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots.filter((x) => x.kind !== 'airport')) {
      expect(s.query).toContain('Paris, France');
    }
  });

  it('emits hotel, sight, activity and restaurant kinds', () => {
    const trip = tripWith(
      {},
      {
        activities: ['Louvre Museum', 'Seine bike loop'],
        restaurants: [{ name: 'Chartier', cuisine: 'French', priceRange: '$' }],
      },
    );
    const kinds = buildCitySpots(trip, 0).map((s) => s.kind);
    expect(kinds).toContain('hotel');
    expect(kinds).toContain('sightseeing');
    expect(kinds).toContain('activity');
    expect(kinds).toContain('restaurant');
  });

  it('pins the CITY’s own airport, not the far-away origin airport', () => {
    const withAirport = tripWith({ origin: { city: 'New York', airports: ['JFK'] } } as any);
    const airport = buildCitySpots(withAirport, 0).find((s) => s.kind === 'airport');
    expect(airport).toBeDefined();
    // Must be scoped to Paris — querying the origin (JFK/New York) would
    // resolve thousands of km from the city and get dropped.
    // "<city> airport, <country>" is the form that actually resolves — a bare
    // "Amsterdam airport" returns an airfield in South Africa, and
    // "airport, <city>, <country>" returns nothing at all.
    expect(airport!.query).toBe('Paris airport, France');
  });

  it('omits the airport when the trip has no home origin', () => {
    const noOrigin = tripWith({ origin: undefined } as any);
    expect(buildCitySpots(noOrigin, 0).map((s) => s.kind)).not.toContain('airport');
  });

  it('prefers a custom hotel over the ranked list', () => {
    const trip = tripWith({}, { customHotel: { name: 'Friend’s flat', mode: 'total', amount: 0, area: 'Marais' } });
    const h = buildCitySpots(trip, 0).find((s) => s.kind === 'hotel');
    expect(h?.name).toBe('Friend’s flat');
  });

  it('skips the placeholder hotel', () => {
    const trip = tripWith({}, { hotel: hotel('Select hotel'), hotels: [hotel('Select hotel')] });
    expect(buildCitySpots(trip, 0).some((s) => s.kind === 'hotel')).toBe(false);
  });

  it('de-dupes repeated places', () => {
    const trip = tripWith({}, { activities: ['Louvre', 'Louvre'] });
    const louvres = buildCitySpots(trip, 0).filter((s) => /louvre/i.test(s.name));
    expect(louvres).toHaveLength(1);
  });

  it('returns nothing for a city index that does not exist', () => {
    expect(buildCitySpots(tripWith(), 5)).toEqual([]);
  });

  it('survives missing activities/restaurants', () => {
    const trip = tripWith({}, { activities: undefined, restaurants: undefined });
    expect(() => buildCitySpots(trip, 0)).not.toThrow();
  });
});

// The two-word head is the last resort for names where every word is
// capitalised, so `properNounPrefix` has no descriptive tail to trim. Query
// forms below were all confirmed against live Nominatim.
describe('headWords', () => {
  it('shortens an all-capitalised title that the full query cannot resolve', () => {
    // "Todai-ji Great Buddha Hall, Nara, Japan" misses; "Todai-ji Great" finds 東大寺.
    expect(headWords('Todai-ji Great Buddha Hall')).toBe('Todai-ji Great');
  });

  it('keeps two words for a landmark whose full name misses', () => {
    // "Golden Gate Bridge Vista Point" misses; "Golden Gate" resolves.
    expect(headWords('Golden Gate Bridge Vista Point')).toBe('Golden Gate');
  });

  it('never returns a single word', () => {
    // One word is the trap: "Tokyo" resolves to Tokyo Station, which would pin
    // "Tokyo Skytree Observation Deck" kilometres from the tower.
    expect(headWords('Tokyo Skytree Observation Deck')).toBe('Tokyo Skytree');
  });

  it('gives nothing when the name is already short enough', () => {
    // Nothing to shorten — earlier passes already asked for exactly this.
    expect(headWords('Todai-ji')).toBe('');
    expect(headWords('Nara Park')).toBe('');
  });

  it('cuts at a bracket rather than emitting a dangling fragment', () => {
    // Naively the head would be "Kinkaku-ji (Golden". Cutting at the bracket
    // leaves one word, which the earlier pass already tried — so: nothing new.
    expect(headWords('Kinkaku-ji (Golden Pavilion) at dawn')).toBe('');
  });

  it('handles extra whitespace', () => {
    expect(headWords('  Todai-ji   Great   Buddha  Hall ')).toBe('Todai-ji Great');
  });
});

describe('isSettlement', () => {
  it('rejects a city that a shortened query landed on', () => {
    expect(isSettlement('place', 'city')).toBe(true);
    expect(isSettlement('boundary', 'administrative')).toBe(true);
  });

  it('accepts real places you can visit', () => {
    expect(isSettlement('historic', 'heritage')).toBe(false);
    expect(isSettlement('tourism', 'attraction')).toBe(false);
    expect(isSettlement('amenity', 'place_of_worship')).toBe(false);
    expect(isSettlement('leisure', 'park')).toBe(false);
    expect(isSettlement('bridge', 'yes')).toBe(false);
  });

  it('does not reject a non-administrative boundary', () => {
    expect(isSettlement('boundary', 'national_park')).toBe(false);
  });

  it('copes with missing OSM fields', () => {
    expect(isSettlement(undefined, undefined)).toBe(false);
  });
});

describe('normalizeName / samePlace', () => {
  it('ignores accents, case and punctuation', () => {
    expect(samePlace('Café de Flore', 'cafe de flore')).toBe(true);
    expect(samePlace('Sacré-Cœur', 'Sacre Coeur')).toBe(true);
  });

  it('treats a bracketed alias as the same place', () => {
    // The suggestion engine and the itinerary spell these differently.
    expect(samePlace('Kinkaku-ji (Golden Pavilion)', 'Kinkaku-ji')).toBe(true);
  });

  it('treats a fuller form as the same place', () => {
    expect(samePlace('Todai-ji', 'Todai-ji Great Buddha Hall')).toBe(true);
  });

  it('keeps genuinely different places apart', () => {
    expect(samePlace('Kinkaku-ji', 'Ginkaku-ji')).toBe(false);
    expect(samePlace('Nara Park', 'Ueno Park')).toBe(false);
  });

  it('does not match on empty input', () => {
    expect(samePlace('', 'Louvre')).toBe(false);
  });
});

describe('buildRecommendedSpots', () => {
  const city = (over: any = {}) => ({
    name: 'Kyoto',
    country: 'Japan',
    activities: ['Kinkaku-ji (Golden Pavilion)'],
    restaurants: [{ name: 'Nishiki Warai', cuisine: 'Okonomiyaki', priceRange: '$' }],
    hotel: hotel('Royal Park Kyoto Sanjo'),
    hotels: [hotel('Royal Park Kyoto Sanjo')],
    selectedHotelIndex: 0,
    ...over,
  }) as any;

  it('marks every seed as recommended and scopes the query', () => {
    const seeds = buildRecommendedSpots(city(), [{ name: 'Ginkaku-ji' }]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].recommended).toBe(true);
    expect(seeds[0].query).toContain('Kyoto, Japan');
  });

  it('never suggests something already in the itinerary', () => {
    const seeds = buildRecommendedSpots(city(), [
      { name: 'Kinkaku-ji' },          // already planned, differently spelled
      { name: 'Nishiki Warai' },       // already a restaurant here
      { name: 'Royal Park Kyoto Sanjo' }, // already the hotel
      { name: 'Ginkaku-ji' },          // genuinely new
    ]);
    expect(seeds.map((s) => s.name)).toEqual(['Ginkaku-ji']);
  });

  it('de-dupes suggestions against each other', () => {
    const seeds = buildRecommendedSpots(city(), [
      { name: 'Ginkaku-ji' },
      { name: 'ginkaku-ji' },
    ]);
    expect(seeds).toHaveLength(1);
  });

  it('caps the number of pins', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Place ${i}` }));
    expect(buildRecommendedSpots(city(), many).length).toBeLessThanOrEqual(6);
    expect(buildRecommendedSpots(city(), many, 3)).toHaveLength(3);
  });

  it('keeps a supplied kind and detail', () => {
    const seeds = buildRecommendedSpots(city(), [
      { name: 'Menbaka Fire Ramen', detail: 'Ramen · $$', kindHint: 'restaurant' },
    ]);
    expect(seeds[0].kind).toBe('restaurant');
    expect(seeds[0].detail).toBe('Ramen · $$');
  });

  it('classifies from the wording when no kind is given', () => {
    expect(buildRecommendedSpots(city(), [{ name: 'Nijo Castle' }])[0].kind).toBe('sightseeing');
  });

  it('survives a missing city and blank names', () => {
    expect(buildRecommendedSpots(undefined, [{ name: 'X' }])).toEqual([]);
    expect(buildRecommendedSpots(city(), [{ name: '  ' }])).toEqual([]);
  });
});
