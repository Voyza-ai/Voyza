/**
 * Airports with no airline passenger service that the location artifact
 * still lists as a home airport for a major city.
 *
 * The artifact keeps an airport when OurAirports flags it
 * `scheduled_service: yes`, and for these that flag is stale. Each one sat
 * in a top-80 city's origin list on 2026-10-30. Duffel's test mode invents a
 * fare from any airport, so one of them could "win" a city's home flight
 * (production: a Boston trip departing "Laurence G Hanscom Field"); a live
 * key returns nothing and just spends a search.
 *
 * General-aviation or restricted fields only — every entry here is one a
 * traveller cannot buy an airline seat from. Airports with even thin airline
 * service (Allegiant, Cape Air, regional turboprops) are NOT listed.
 */
export const NO_AIRLINE_SERVICE: ReadonlySet<string> = new Set([
  'BED', // Laurence G. Hanscom Field — Boston
  'GYY', // Gary/Chicago International — Chicago
  'FTW', // Fort Worth Meacham — Dallas, Fort Worth
  'OPF', // Miami-Opa Locka Executive — Miami
  'BFI', // King County International (Boeing Field) — Seattle
  'PDK', // DeKalb-Peachtree — Atlanta
  'LUK', // Cincinnati Municipal (Lunken Field) — Cincinnati
  'BJC', // Rocky Mountain Metropolitan — Denver
  'CCR', // Buchanan Field — Sacramento
  'BLD', // Boulder City Municipal — Las Vegas
  'CAT', // Cascais — Lisbon
  'MHG', // Mannheim City — Frankfurt
  'LUP', // Kalaupapa (restricted settlement) — Honolulu
]);
