import { getOriginAirports, isMultiAirportCity } from '../data/originAirports';

describe('getOriginAirports: the originally broken inputs', () => {
  // Each of these returned [] before, which made originAirports empty and
  // skipped the home-flight search silently — no error, no day-1 transport.
  it.each([
    ['New Jersey', ['EWR', 'JFK', 'LGA']],
    ['Newark', ['EWR', 'JFK', 'LGA']],
    ['Long Island', ['JFK', 'LGA']],
    ['Connecticut', ['BDL']],
  ])('resolves %s', (input, expected) => {
    expect(getOriginAirports(input)).toEqual(expected);
  });

  it('no longer returns an empty list for any of them', () => {
    for (const input of ['New Jersey', 'Newark', 'Long Island', 'Connecticut']) {
      expect(getOriginAirports(input).length).toBeGreaterThan(0);
    }
  });
});

describe('getOriginAirports: US states and abbreviations', () => {
  it.each([
    ['New Jersey', ['EWR', 'JFK', 'LGA']],
    ['NJ', ['EWR', 'JFK', 'LGA']],
    ['Connecticut', ['BDL']],
    ['CT', ['BDL']],
    ['Rhode Island', ['PVD']],
    ['RI', ['PVD']],
    ['Massachusetts', ['BOS']],
    ['MA', ['BOS']],
    ['Delaware', ['PHL']],
    ['DE', ['PHL']],
    ['Maryland', ['BWI']],
    ['MD', ['BWI']],
    ['Illinois', ['ORD', 'MDW']],
    ['IL', ['ORD', 'MDW']],
    ['Georgia', ['ATL']],
    ['GA', ['ATL']],
    ['Arizona', ['PHX']],
    ['AZ', ['PHX']],
    ['Nevada', ['LAS']],
    ['NV', ['LAS']],
    ['Utah', ['SLC']],
    ['UT', ['SLC']],
    ['Colorado', ['DEN']],
    ['CO', ['DEN']],
    ['Minnesota', ['MSP']],
    ['MN', ['MSP']],
    ['Michigan', ['DTW']],
    ['MI', ['DTW']],
    ['Hawaii', ['HNL']],
    ['Oregon', ['PDX']],
    ['Vermont', ['BTV']],
    ['VT', ['BTV']],
    ['New York', ['JFK', 'LGA', 'EWR']],
    ['NY', ['JFK', 'LGA', 'EWR']],
  ])('resolves the state %s', (input, expected) => {
    expect(getOriginAirports(input)).toEqual(expected);
  });

  it('keeps "Washington" as Washington DC, not the state', () => {
    // 'washington' predates this change and means DC. Resolving it to SEA
    // would price every DC traveller out of Seattle.
    expect(getOriginAirports('Washington')).toEqual(['IAD', 'DCA', 'BWI']);
    expect(getOriginAirports('Washington DC')).toEqual(['IAD', 'DCA', 'BWI']);
    expect(getOriginAirports('DC')).toEqual(['IAD', 'DCA', 'BWI']);
  });

  it('resolves the state of Washington only under an explicit key', () => {
    expect(getOriginAirports('Washington State')).toEqual(['SEA']);
    expect(getOriginAirports('WA')).toEqual(['SEA']);
  });

  it('does not strip a trailing " state" generically', () => {
    // A generic strip would turn "washington state" into "washington" (DC).
    // Unknown "<X> state" must miss rather than fall back to a wrong metro.
    expect(getOriginAirports('Oregon State')).toEqual([]);
    expect(getOriginAirports('New York State')).toEqual(['JFK', 'LGA', 'EWR']);
  });
});

describe('getOriginAirports: regions and metro aliases', () => {
  it.each([
    ['Long Island', ['JFK', 'LGA']],
    ['Brooklyn', ['JFK', 'LGA', 'EWR']],
    ['Queens', ['JFK', 'LGA', 'EWR']],
    ['Manhattan', ['JFK', 'LGA', 'EWR']],
    ['Bronx', ['JFK', 'LGA', 'EWR']],
    ['The Bronx', ['JFK', 'LGA', 'EWR']],
    ['Staten Island', ['EWR', 'JFK', 'LGA']],
    ['Jersey City', ['EWR', 'JFK', 'LGA']],
    ['Hoboken', ['EWR', 'JFK', 'LGA']],
    ['Newark', ['EWR', 'JFK', 'LGA']],
    ['Silicon Valley', ['SJC', 'SFO', 'OAK']],
    ['Oakland', ['OAK', 'SFO', 'SJC']],
    ['Bay Area', ['SFO', 'OAK', 'SJC']],
    ['Twin Cities', ['MSP']],
    ['New England', ['BOS']],
    ['Fort Worth', ['DFW', 'DAL']],
    ['Ft Worth', ['DFW', 'DAL']],
    ['Fort Lauderdale', ['FLL', 'MIA']],
  ])('resolves the region/alias %s', (input, expected) => {
    expect(getOriginAirports(input)).toEqual(expected);
  });

  it.each([
    ['Philadelphia', ['PHL']],
    ['Baltimore', ['BWI']],
    ['Phoenix', ['PHX']],
    ['Las Vegas', ['LAS']],
    ['Salt Lake City', ['SLC']],
    ['Minneapolis', ['MSP']],
    ['Detroit', ['DTW']],
    ['Honolulu', ['HNL']],
    ['Providence', ['PVD']],
    ['Hartford', ['BDL']],
  ])('resolves the newly added metro %s', (input, expected) => {
    expect(getOriginAirports(input)).toEqual(expected);
  });
});

describe('getOriginAirports: ambiguous names stay unmapped', () => {
  // A wrong airport is worse than none: these are left out on purpose, and
  // the empty result is the contract. See the header of originAirports.ts.
  it.each([
    'California',
    'Texas',
    'Florida',
    'Pennsylvania',
    'Ohio',
    'North Carolina',
    'Virginia',
    'Tennessee',
    'Missouri',
    'Wisconsin',
    'Maine',
    'New Hampshire',
    'Portland',
    'San Jose',
    'Arlington',
    'Alexandria',
    'Southern California',
    'Northern California',
    'Tri-State',
    'DMV',
  ])('leaves %s unmapped', (input) => {
    expect(getOriginAirports(input)).toEqual([]);
  });

  it.each(['in', 'or', 'hi', 'me'])(
    'does not key the English-word abbreviation %s',
    (input) => {
      expect(getOriginAirports(input)).toEqual([]);
    },
  );

  it('keeps LA as Los Angeles, so Louisiana is not silently mapped', () => {
    expect(getOriginAirports('LA')).toEqual(['LAX', 'BUR', 'LGB']);
    expect(getOriginAirports('Louisiana')).toEqual([]);
  });
});

describe('getOriginAirports: normalization', () => {
  it('is case insensitive', () => {
    expect(getOriginAirports('NEW JERSEY')).toEqual(['EWR', 'JFK', 'LGA']);
    expect(getOriginAirports('new jersey')).toEqual(['EWR', 'JFK', 'LGA']);
    expect(getOriginAirports('New Jersey')).toEqual(['EWR', 'JFK', 'LGA']);
  });

  it('strips commas and periods, so "N.J." hits the nj key', () => {
    expect(getOriginAirports('N.J.')).toEqual(['EWR', 'JFK', 'LGA']);
  });

  it('KNOWN LIMITATION: "City, Qualifier" strings still miss', () => {
    // Commas are stripped, not split, so "Newark, NJ" normalizes to the
    // single key "newark nj" and misses. Splitting on the comma was
    // considered and deliberately left out: trying segments in either
    // order creates wrong-airport hits that cannot happen today
    // ("Vancouver, WA" -> YVR in Canada if the city segment wins;
    // "Paris, Texas" -> CDG if the qualifier segment loses). Documented
    // in the PR as a follow-up rather than guessed at here.
    expect(getOriginAirports('Newark, NJ')).toEqual([]);
    expect(getOriginAirports('Vancouver, WA')).toEqual([]);
  });

  it('trims surrounding whitespace', () => {
    expect(getOriginAirports('  Long Island  ')).toEqual(['JFK', 'LGA']);
  });

  it('returns [] for empty and missing input instead of throwing', () => {
    expect(getOriginAirports('')).toEqual([]);
    expect(getOriginAirports('   ')).toEqual([]);
    expect(() =>
      getOriginAirports(undefined as unknown as string),
    ).not.toThrow();
    expect(getOriginAirports(undefined as unknown as string)).toEqual([]);
    expect(getOriginAirports(null as unknown as string)).toEqual([]);
  });

  it('still resolves "<City> City" through the suffix fallback', () => {
    expect(getOriginAirports('New York City')).toEqual(['JFK', 'LGA', 'EWR']);
    expect(getOriginAirports('Mexico City')).toEqual(['MEX', 'NLU']);
    // Direct hits win over the fallback for the new multi-word keys.
    expect(getOriginAirports('Jersey City')).toEqual(['EWR', 'JFK', 'LGA']);
    expect(getOriginAirports('Salt Lake City')).toEqual(['SLC']);
    // The fallback must not invent a hit for an unmapped "<X> City".
    expect(getOriginAirports('Kansas City')).toEqual([]);
    expect(getOriginAirports('Oklahoma City')).toEqual([]);
  });

  it('honours the max argument', () => {
    expect(getOriginAirports('New Jersey', 1)).toEqual(['EWR']);
    expect(getOriginAirports('New Jersey', 2)).toEqual(['EWR', 'JFK']);
    expect(getOriginAirports('New York City', 1)).toEqual(['JFK']);
  });
});

describe('isMultiAirportCity', () => {
  it('is true for the multi-airport aliases', () => {
    expect(isMultiAirportCity('New Jersey')).toBe(true);
    expect(isMultiAirportCity('Long Island')).toBe(true);
    expect(isMultiAirportCity('Brooklyn')).toBe(true);
  });

  it('is false for single-airport aliases', () => {
    expect(isMultiAirportCity('Connecticut')).toBe(false);
    expect(isMultiAirportCity('Rhode Island')).toBe(false);
    expect(isMultiAirportCity('Philadelphia')).toBe(false);
  });

  it('is false for unmapped names', () => {
    expect(isMultiAirportCity('Texas')).toBe(false);
    expect(isMultiAirportCity('')).toBe(false);
  });
});
