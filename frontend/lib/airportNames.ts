/**
 * IATA code → human-readable airport name.
 *
 * Covers the airports listed in `originAirports.ts` plus a handful of
 * major destination airports that show up in home legs. Kept frontend-
 * only for now — terminal info isn't here because our current flight
 * data source doesn't return it. If we move to Amadeus/Duffel later,
 * we should pull airport + terminal from the API response instead.
 *
 * Lookups are case-insensitive. Returns an object with `name` (short
 * marketing name, e.g. "John F. Kennedy") and `full` (formal name,
 * e.g. "John F. Kennedy International Airport").
 */

type AirportInfo = {
  name: string;
  full: string;
};

const AIRPORTS: Record<string, AirportInfo> = {
  // United States
  JFK: { name: 'John F. Kennedy', full: 'John F. Kennedy International Airport' },
  LGA: { name: 'LaGuardia', full: 'LaGuardia Airport' },
  EWR: { name: 'Newark Liberty', full: 'Newark Liberty International Airport' },
  LAX: { name: 'Los Angeles Intl.', full: 'Los Angeles International Airport' },
  BUR: { name: 'Hollywood Burbank', full: 'Hollywood Burbank Airport' },
  LGB: { name: 'Long Beach', full: 'Long Beach Airport' },
  SFO: { name: 'San Francisco Intl.', full: 'San Francisco International Airport' },
  OAK: { name: 'Oakland Intl.', full: 'Oakland International Airport' },
  SJC: { name: 'San José', full: 'Norman Y. Mineta San José International Airport' },
  ORD: { name: "O'Hare", full: "O'Hare International Airport" },
  MDW: { name: 'Midway', full: 'Chicago Midway International Airport' },
  IAD: { name: 'Dulles', full: 'Washington Dulles International Airport' },
  DCA: { name: 'Reagan National', full: 'Ronald Reagan Washington National Airport' },
  BWI: { name: 'BWI Marshall', full: 'Baltimore/Washington International Thurgood Marshall Airport' },
  MIA: { name: 'Miami Intl.', full: 'Miami International Airport' },
  FLL: { name: 'Fort Lauderdale', full: 'Fort Lauderdale-Hollywood International Airport' },
  IAH: { name: 'George Bush Intercontinental', full: 'George Bush Intercontinental Airport' },
  HOU: { name: 'William P. Hobby', full: 'William P. Hobby Airport' },
  DFW: { name: 'DFW', full: 'Dallas/Fort Worth International Airport' },
  DAL: { name: 'Dallas Love Field', full: 'Dallas Love Field' },
  SEA: { name: 'Seattle-Tacoma', full: 'Seattle-Tacoma International Airport' },
  BOS: { name: 'Boston Logan', full: 'Boston Logan International Airport' },
  DEN: { name: 'Denver Intl.', full: 'Denver International Airport' },
  ATL: { name: 'Hartsfield-Jackson', full: 'Hartsfield-Jackson Atlanta International Airport' },

  // Canada
  YYZ: { name: 'Toronto Pearson', full: 'Toronto Pearson International Airport' },
  YTZ: { name: 'Billy Bishop', full: 'Billy Bishop Toronto City Airport' },
  YUL: { name: 'Montréal-Trudeau', full: 'Montréal-Pierre Elliott Trudeau International Airport' },
  YVR: { name: 'Vancouver Intl.', full: 'Vancouver International Airport' },

  // Mexico
  MEX: { name: 'Mexico City Intl.', full: 'Mexico City International Airport' },
  NLU: { name: 'Felipe Ángeles', full: 'Felipe Ángeles International Airport' },

  // UK & Ireland
  LHR: { name: 'Heathrow', full: 'London Heathrow Airport' },
  LGW: { name: 'Gatwick', full: 'London Gatwick Airport' },
  STN: { name: 'Stansted', full: 'London Stansted Airport' },
  DUB: { name: 'Dublin', full: 'Dublin Airport' },

  // Europe
  CDG: { name: 'Charles de Gaulle', full: 'Paris Charles de Gaulle Airport' },
  ORY: { name: 'Orly', full: 'Paris Orly Airport' },
  MXP: { name: 'Malpensa', full: 'Milan Malpensa Airport' },
  LIN: { name: 'Linate', full: 'Milan Linate Airport' },
  FCO: { name: 'Fiumicino', full: 'Leonardo da Vinci–Fiumicino Airport' },
  CIA: { name: 'Ciampino', full: 'Rome Ciampino Airport' },
  BER: { name: 'Berlin Brandenburg', full: 'Berlin Brandenburg Airport' },
  MAD: { name: 'Madrid-Barajas', full: 'Adolfo Suárez Madrid–Barajas Airport' },
  BCN: { name: 'Barcelona-El Prat', full: 'Josep Tarradellas Barcelona-El Prat Airport' },
  AMS: { name: 'Schiphol', full: 'Amsterdam Airport Schiphol' },
  FRA: { name: 'Frankfurt', full: 'Frankfurt Airport' },
  MUC: { name: 'Munich', full: 'Munich Airport' },
  ZRH: { name: 'Zurich', full: 'Zurich Airport' },
  VIE: { name: 'Vienna', full: 'Vienna International Airport' },
  LIS: { name: 'Lisbon Humberto Delgado', full: 'Humberto Delgado Airport' },
  ARN: { name: 'Stockholm Arlanda', full: 'Stockholm Arlanda Airport' },
  BMA: { name: 'Bromma', full: 'Stockholm Bromma Airport' },
  FLR: { name: 'Florence', full: 'Florence Airport, Peretola' },
  PSA: { name: 'Pisa', full: 'Pisa International Airport' },

  // Russia / Turkey
  SVO: { name: 'Sheremetyevo', full: 'Sheremetyevo International Airport' },
  DME: { name: 'Domodedovo', full: 'Domodedovo International Airport' },
  VKO: { name: 'Vnukovo', full: 'Vnukovo International Airport' },
  IST: { name: 'Istanbul', full: 'Istanbul Airport' },
  SAW: { name: 'Sabiha Gökçen', full: 'Istanbul Sabiha Gökçen International Airport' },

  // Asia
  HND: { name: 'Haneda', full: 'Tokyo Haneda Airport' },
  NRT: { name: 'Narita', full: 'Narita International Airport' },
  KIX: { name: 'Kansai', full: 'Kansai International Airport' },
  ITM: { name: 'Itami', full: 'Osaka International Airport (Itami)' },
  ICN: { name: 'Incheon', full: 'Incheon International Airport' },
  GMP: { name: 'Gimpo', full: 'Gimpo International Airport' },
  PEK: { name: 'Beijing Capital', full: 'Beijing Capital International Airport' },
  PKX: { name: 'Daxing', full: 'Beijing Daxing International Airport' },
  PVG: { name: 'Pudong', full: 'Shanghai Pudong International Airport' },
  SHA: { name: 'Hongqiao', full: 'Shanghai Hongqiao International Airport' },
  HKG: { name: 'Hong Kong Intl.', full: 'Hong Kong International Airport' },
  TPE: { name: 'Taoyuan', full: 'Taiwan Taoyuan International Airport' },
  TSA: { name: 'Taipei Songshan', full: 'Taipei Songshan Airport' },
  SIN: { name: 'Changi', full: 'Singapore Changi Airport' },
  BKK: { name: 'Suvarnabhumi', full: 'Suvarnabhumi Airport' },
  DMK: { name: 'Don Mueang', full: 'Don Mueang International Airport' },
  KUL: { name: 'Kuala Lumpur Intl.', full: 'Kuala Lumpur International Airport' },
  CGK: { name: 'Soekarno-Hatta', full: 'Soekarno-Hatta International Airport' },
  HLP: { name: 'Halim', full: 'Halim Perdanakusuma International Airport' },
  MNL: { name: 'Ninoy Aquino', full: 'Ninoy Aquino International Airport' },
  DEL: { name: 'Indira Gandhi', full: 'Indira Gandhi International Airport' },
  BOM: { name: 'Chhatrapati Shivaji', full: 'Chhatrapati Shivaji Maharaj International Airport' },

  // Oceania
  SYD: { name: 'Sydney Kingsford Smith', full: 'Sydney Kingsford Smith Airport' },
  MEL: { name: 'Melbourne', full: 'Melbourne Airport' },

  // Middle East / Africa
  DXB: { name: 'Dubai Intl.', full: 'Dubai International Airport' },
  DWC: { name: 'Al Maktoum', full: 'Al Maktoum International Airport' },
  AUH: { name: 'Zayed Intl.', full: 'Zayed International Airport' },
  DOH: { name: 'Hamad Intl.', full: 'Hamad International Airport' },
  JNB: { name: 'OR Tambo', full: 'O. R. Tambo International Airport' },
  CPT: { name: 'Cape Town Intl.', full: 'Cape Town International Airport' },
  CAI: { name: 'Cairo Intl.', full: 'Cairo International Airport' },

  // South America
  GRU: { name: 'São Paulo-Guarulhos', full: 'São Paulo/Guarulhos International Airport' },
  CGH: { name: 'Congonhas', full: 'São Paulo/Congonhas Airport' },
  GIG: { name: 'Galeão', full: 'Rio de Janeiro/Galeão International Airport' },
  SDU: { name: 'Santos Dumont', full: 'Santos Dumont Airport' },
  EZE: { name: 'Ezeiza', full: 'Ministro Pistarini International Airport' },
  AEP: { name: 'Aeroparque', full: 'Jorge Newbery Airfield' },
  SCL: { name: 'Arturo Merino Benítez', full: 'Arturo Merino Benítez International Airport' },
  LIM: { name: 'Jorge Chávez', full: 'Jorge Chávez International Airport' },
  BOG: { name: 'El Dorado', full: 'El Dorado International Airport' },
};

export function getAirportName(iata: string): string | null {
  if (!iata) return null;
  const info = AIRPORTS[iata.toUpperCase()];
  return info ? info.name : null;
}

export function getAirportFullName(iata: string): string | null {
  if (!iata) return null;
  const info = AIRPORTS[iata.toUpperCase()];
  return info ? info.full : null;
}
