import {
  classifySpot,
  classifyResolved,
  properNounPrefix,
  cleanSpotQuery,
  distanceKm,
  buildCitySpots,
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
