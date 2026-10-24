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

  it('resolves "<City>, <State>" via the comma qualifier', () => {
    expect(getOriginAirports('Newark, NJ')).toEqual(['EWR', 'JFK', 'LGA']);
    expect(getOriginAirports('Jersey City, NJ')).toEqual(['EWR', 'JFK', 'LGA']);
    expect(getOriginAirports('Brooklyn, NY')).toEqual(['JFK', 'LGA', 'EWR']);
    expect(getOriginAirports('Hartford, CT')).toEqual(['BDL']);
    expect(getOriginAirports('Portland, Oregon')).toEqual(['PDX']);
  });

  it('trusts the qualifier over the city name', () => {
    // The segment after the comma is the disambiguator the user supplied,
    // so it wins. "Vancouver, WA" is Washington state, not Canada — the
    // bare key 'vancouver' would have given YVR.
    expect(getOriginAirports('Vancouver')).toEqual(['YVR']);
    expect(getOriginAirports('Vancouver, WA')).toEqual(['SEA']);
  });

  it('walks multiple comma segments right to left', () => {
    expect(getOriginAirports('Brooklyn, New York, USA')).toEqual(['JFK', 'LGA', 'EWR']);
  });

  it('never trusts the city segment, only a known qualifier', () => {
    // Each of these resolved to a WRONG airport under a rule that falls
    // back to the first segment: the unmapped states are exactly the ones
    // left out of the table on purpose, so "<WorldCity>, <that state>" is
    // a common pairing, not a rare one.
    expect(getOriginAirports('Paris, Texas')).toEqual([]);
    expect(getOriginAirports('Dublin, Ohio')).toEqual([]);
    expect(getOriginAirports('Dublin, California')).toEqual([]);
    expect(getOriginAirports('Vienna, Virginia')).toEqual([]);
    expect(getOriginAirports('Moscow, Idaho')).toEqual([]);
    expect(getOriginAirports('Berlin, New Hampshire')).toEqual([]);
    expect(getOriginAirports('Lima, Ohio')).toEqual([]);
  });

  it('rejects qualifiers that collide with ISO country codes', () => {
    // These abbreviations are table keys, but must not act as qualifiers:
    // DE Germany, IL Israel, MA Morocco, CO Colombia, AZ Azerbaijan.
    expect(getOriginAirports('Berlin, DE')).toEqual([]);
    expect(getOriginAirports('Tel Aviv, IL')).toEqual([]);
    expect(getOriginAirports('Casablanca, MA')).toEqual([]);
    expect(getOriginAirports('Bogota, CO')).toEqual([]);
    expect(getOriginAirports('Baku, AZ')).toEqual([]);
    // 'georgia' is the country here, not the US state.
    expect(getOriginAirports('Tbilisi, Georgia')).toEqual([]);
    // 'la' is Los Angeles, so Louisiana must not qualify.
    expect(getOriginAirports('Baton Rouge, LA')).toEqual([]);
  });

  it('ACCEPTED LOSS: "<City>, <Country>" still misses', () => {
    // Resolving these needs a country whitelist, since the qualifier is
    // not a state. Left out rather than guessed: it is the same [] these
    // returned before, not a regression.
    expect(getOriginAirports('Paris, France')).toEqual([]);
    expect(getOriginAirports('Mexico City, Mexico')).toEqual([]);
  });

  it('keeps "Washington, DC" working through the whole-string key', () => {
    // Comma stripping (not splitting) is what makes this a direct hit, so
    // the new segment walk must not shadow it.
    expect(getOriginAirports('Washington, DC')).toEqual(['IAD', 'DCA', 'BWI']);
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
