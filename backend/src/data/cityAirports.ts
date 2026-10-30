/**
 * Curated city → primary IATA override map. Consulted BEFORE the
 * `airport_codes` cache and Duffel's place suggestions in getIataCode().
 *
 * Why this exists: the auto-resolver occasionally returns a wrong or
 * garbage code — e.g. "Kyoto" resolved to ACC (Accra, Ghana) because Kyoto
 * has no airport of its own and the fuzzy place search mismatched. Cities
 * served by a larger metro's airports (Kyoto/Nara → the Osaka metro) need a
 * deterministic mapping so inter-city legs don't become transpacific
 * flights.
 *
 * Keys are lowercase city names. Values are the metropolitan or primary
 * international airport IATA used for flight search. Multi-airport metros
 * use the city/metropolitan code (NYC, LON, TYO…) which Duffel accepts.
 *
 * ── THE 13 ENTRIES THE RESOLVER DID NOT REPRODUCE, DECIDED ──────────────────
 *
 * The generated resolver answers the destination side as `metro ?? airports[0]`
 * and reproduces 156 of the 169 keys here. The other 13 were left for a
 * person, and this is the record. `src/tests/cityAirportsDecisions.test.ts`
 * asserts every line of it against the real artifact, and re-measures the
 * whole table so a 14th disagreement cannot appear unnoticed.
 *
 * SEVEN went to the RESOLVER, and the values below now hold its answer, so
 * deleting this file changes nothing for them:
 *
 *   kyoto, nara   KIX -> OSA   The KIX pin is an ORIGIN decision: Itami is
 *   kobe          UKB -> OSA   nearer and domestic-focused, so it must not be
 *                              what a home leg is priced from. A DESTINATION
 *                              search is the opposite problem — one code
 *                              covers every airport, and KIX-only could not
 *                              return the Tokyo-Itami shuttle that is how a
 *                              traveller on a multi-city Japan trip actually
 *                              reaches Kyoto. Kobe's own UKB was the worst of
 *                              the three: a small domestic field, while
 *                              nearly everyone arrives via KIX or ITM.
 *   seoul         ICN -> SEL   Same shape. Gimpo carries nearly all domestic
 *   beijing       PEK -> BJS   service and the Haneda/Osaka shuttles; Daxing
 *                              now carries a large share of Beijing's. A
 *                              gateway-only code silently drops them.
 *   siem reap     REP -> SAI   REP has NO ROW AT ALL in OurAirports 2026-10-24:
 *                              the old Siem Reap International closed when
 *                              Siem Reap-Angkor opened. The table was pointing
 *                              at an airport that no longer exists.
 *   phnom penh    PNH -> KTI   PNH is still filed, with
 *                              `scheduled_service: "no"` — Phnom Penh
 *                              International stopped taking commercial
 *                              traffic when Techo International opened. KTI
 *                              is where the flight lands.
 *
 * THREE went to this TABLE and are now carried by `scripts/location-data/
 * curated.ts`, so the resolver reproduces them too:
 *
 *   buenos aires  BUE   a curated alias; the province was outranking the city
 *   reykjavik     REK   a metro group; no dataset has the metro concept
 *   bucharest     BUH   a metro group; Băneasa was leading Henri Coandă
 *
 * TWO STAY HAND-WRITTEN, and this file cannot be deleted until they are
 * answered somewhere else. Both are marked at their entry below:
 *
 *   moscow        MOW   the resolver answers SVO, and the only curated
 *                       mechanism available costs more than it buys
 *   kyiv          IEV   nothing in the artifact can answer it: Ukraine has no
 *                       scheduled service in the dump, and the build REFUSES
 *                       to pin a closed airport
 *
 * The 13th, `washington`, was decided before this pass: the curated alias in
 * `curated.ts` makes the resolver answer WAS, so the entry is a bridge only.
 *
 * ── SINCE `getIataCode` ASKS THE ARTIFACT (2026-10-30) ──────────────────────
 *
 * The lookup now goes table -> artifact -> cache -> checked Duffel, and a
 * caller may pass the trip's other stops. A row here still answers first and
 * is NOT opened to the trip, because it is a decision about the famous reading
 * of a name: measured, letting the trip overrule these rows would send
 * `Vancouver` on a Seattle and Portland trip to PDX, `Rome` with Atlanta to
 * ATL, `London` with Toronto to YXU. The consequence is that a row which
 * merely repeats the artifact's answer for an ambiguous name costs the trip
 * its say, so such a row does not belong here:
 *
 *   lagos         REMOVED. It said LOS, as the artifact does with no trip, and
 *                 it sent a Lisbon and Porto trip to Nigeria.
 *
 * ── THE DEMO TOWNS AND THE PRESET CITIES (2026-10-30) ───────────────────────
 *
 * Twenty-six keys for twenty-five names, each one a town a demo trip plans
 * through or a city a preset in `data/presets/` visits. Before, none had a
 * row, so each fell to the cache and Duffel: a 404 for most, and for
 * Monteverde MVD — Montevideo, Uruguay — which production's `airport_codes`
 * still holds, along with siena->JHB, sintra->SQG and bath->BUT. A row here
 * answers before any of those rows can be read. `cityAirportsDecisions.
 * test.ts` asserts every line below.
 *
 * TEN hold the artifact's own answer, so deleting them changes nothing today;
 * they pin a demo city against a rebuild, and none has another reading a trip
 * could want (Luxor and Krabi share their label only with their own province):
 *
 *   bath BRS, sintra LIS, siena FLR, lucerne ZRH, cozumel CZM,
 *   la fortuna SJO, luxor LXR, krabi KBV, taichung RMQ, tainan TNN
 *
 * THIRTEEN keys the artifact cannot answer: towns under its 15,000 floor with
 * no airport of their own. Each names the airport a traveller flies into, and
 * where two are equally large the owner's rule — size beats distance — needed
 * a real-world tiebreak, stated:
 *
 *   interlaken    ZRH   Bern (38 km) has almost no scheduled service; Zurich
 *                       is 100 km, two hours by direct train
 *   zermatt       ZRH   car-free, reached by rail via Visp; Zurich and
 *                       Geneva are both roughly 3.5-4 h, Zurich is larger
 *   cinque terre  PSA   Pisa and Genoa tie at ~75 km; Pisa is the larger and
 *                       the usual gateway, an hour by train to La Spezia
 *   positano      NAP   33 km
 *   lake como     MIL   Malpensa, Linate and Bergamo are all 50-60 km from
 *                       the lake; the metro code searches all three, as
 *                       `milan` does
 *   hallstatt     SZG   55 km
 *   hakone        TYO   the Odakyu line from Shinjuku; Haneda is 80 km
 *   mount cook village  ZQN   Queenstown and Christchurch are both large;
 *                       Queenstown is an hour nearer by road, and the preset
 *                       arrives from there
 *   monteverde    SJO   San José and Liberia are both large and ~80 km;
 *                       San José is the nearer
 *   manuel antonio SJO  Quepos's XQP, 4 km, is a domestic strip
 *   flåm, flam    BGO   Bergen, 121 km, by the Bergen and Flåm railways;
 *                       Sogndal (33 km) is a small regional field
 *   koh phi phi   HKT   ferries run from Phuket and Krabi, both "large" in
 *                       the data; Phuket is far the busier airport
 *
 * THREE overrule the artifact, and the measured reason is stated:
 *
 *   naxos         JNX   the artifact leads with Santorini's JTR (large,
 *                       79 km) — across open sea. JNX is the island's own
 *                       airport, 2.8 km. The preset flies Santorini->Naxos,
 *                       which JTR would turn into JTR->JTR.
 *   playa del carmen CUN  the artifact leads with CZM, 20 km — on Cozumel
 *                       island, a ferry away. CUN is 51 km by road and equally
 *                       large, so distance decided, wrongly.
 *   oxford        LON   the artifact leads with Luton, 62.5 km, tied with
 *                       Heathrow at 63.3 km on rank and separated by 0.8 km.
 *                       Oxford's airport coaches run to Heathrow and Gatwick;
 *                       one metro code searches both.
 *
 * And ONE preset city has no row on purpose: `guadalajara`. The artifact
 * answers GDL, and on a Spain trip through Madrid it answers MAD for
 * Guadalajara, Spain, 55 km away. A row would send that trip to Mexico.
 */
export const CITY_AIRPORTS: Record<string, string> = {
  // North America
  'new york': 'NYC', 'los angeles': 'LAX', 'san francisco': 'SFO',
  chicago: 'CHI', 'las vegas': 'LAS', miami: 'MIA', boston: 'BOS',
  seattle: 'SEA', washington: 'WAS', 'new orleans': 'MSY', austin: 'AUS',
  honolulu: 'HNL', toronto: 'YTO', vancouver: 'YVR', montreal: 'YMQ',
  'mexico city': 'MEX', cancun: 'CUN', havana: 'HAV', 'panama city': 'PTY',
  // Demo and preset towns, decided in the header. Playa del Carmen is CUN,
  // not the island airport the artifact leads with; Monteverde and Manuel
  // Antonio have no airport of their own.
  'playa del carmen': 'CUN', cozumel: 'CZM',
  monteverde: 'SJO', 'la fortuna': 'SJO', 'manuel antonio': 'SJO',

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
  // Demo towns, decided in the header. Interlaken, Zermatt and Hallstatt
  // have no airport of their own; Oxford overrules a Luton-versus-Heathrow
  // tie of 0.8 km.
  lucerne: 'ZRH', interlaken: 'ZRH', zermatt: 'ZRH', hallstatt: 'SZG',
  oxford: 'LON', bath: 'BRS',

  // Southern Europe
  rome: 'ROM', florence: 'FLR', venice: 'VCE', milan: 'MIL', naples: 'NAP',
  // Demo and preset towns, decided in the header. Naxos is its own JNX,
  // not Santorini's JTR across the sea, which the artifact leads with.
  siena: 'FLR', 'cinque terre': 'PSA', positano: 'NAP', 'lake como': 'MIL',
  sintra: 'LIS', naxos: 'JNX',
  madrid: 'MAD', barcelona: 'BCN', seville: 'SVQ', valencia: 'VLC',
  malaga: 'AGP', bilbao: 'BIO', lisbon: 'LIS', porto: 'OPO', athens: 'ATH',
  santorini: 'JTR', mykonos: 'JMK', thessaloniki: 'SKG', dubrovnik: 'DBV',
  split: 'SPU', zagreb: 'ZAG', ljubljana: 'LJU', valletta: 'MLA',

  // Northern & Eastern Europe
  copenhagen: 'CPH', stockholm: 'STO', oslo: 'OSL', bergen: 'BGO',
  // Flåm has no airport; both spellings, since `getStaticIata` matches the
  // string as typed.
  'flåm': 'BGO', flam: 'BGO',
  helsinki: 'HEL', reykjavik: 'REK', prague: 'PRG', budapest: 'BUD',
  warsaw: 'WAW', krakow: 'KRK', bucharest: 'BUH', sofia: 'SOF',
  belgrade: 'BEG', tallinn: 'TLL', riga: 'RIX', vilnius: 'VNO',
  // HAND-WRITTEN, AND NOT YET REPLACEABLE. Both are explained in the header.
  //
  // `moscow`: the resolver's top candidate is the Moscow FEDERAL CITY region,
  // which carries no metro code and leads SVO, so the destination side would
  // search Sheremetyevo alone and never see Domodedovo or Vnukovo. The only
  // curated mechanism that reaches it is an alias onto the city — and
  // measured, that alias costs the ONE case it would be wrong about: a
  // traveller whose coordinates are in Moscow, Idaho resolves to PUW, 8.6 km
  // away, today and would get Sheremetyevo instead. That trade is the owner's
  // to make, so the entry stays.
  //
  // `kyiv`: both Kyiv airports are filed `scheduled_service: "no"` in the
  // 2026-10-24 dump, so neither is in the artifact's airport universe and the
  // resolver answers `unknown`. The curated layer cannot hold it either —
  // `addCuratedAirports` throws on an airport without scheduled service, by
  // design. This value is a deterministic stub, not a flight: it keeps
  // `getIataCode` off the Duffel guess that produced the Kyoto/Accra bug.
  // When service resumes the resolver answers it from the dump, unchanged.
  moscow: 'MOW', 'saint petersburg': 'LED', kyiv: 'IEV',

  // Middle East
  istanbul: 'IST', dubai: 'DXB', 'abu dhabi': 'AUH', doha: 'DOH',
  'tel aviv': 'TLV', amman: 'AMM', beirut: 'BEY', riyadh: 'RUH',
  muscat: 'MCT',

  // Africa
  luxor: 'LXR',
  //
  // No `lagos` row, deliberately. It said LOS, which is also what the
  // artifact answers for a bare `Lagos` (Nigeria's city, 15 million), so the
  // row decided nothing — except that, consulted first, it beat the trip:
  // a Lisbon and Porto trip through Lagos, the Algarve town, was searched
  // into Nigeria. Without it `getIataCode` asks the resolver, which still
  // answers LOS with no trip and FAO, 63 km, when the trip is in Portugal.
  cairo: 'CAI', marrakech: 'RAK', casablanca: 'CMN', fez: 'FEZ',
  'cape town': 'CPT', johannesburg: 'JNB', nairobi: 'NBO', zanzibar: 'ZNZ',
  'addis ababa': 'ADD', accra: 'ACC', tunis: 'TUN',

  // South & Central Asia
  delhi: 'DEL', mumbai: 'BOM', jaipur: 'JAI', agra: 'AGR', goa: 'GOI',
  bengaluru: 'BLR', kathmandu: 'KTM', colombo: 'CMB', male: 'MLE',
  tashkent: 'TAS',

  // East Asia — Kyoto, Nara and Kobe are all served by the Osaka metro (OSA:
  // Kansai, Itami and Kobe), which is the destination-side answer; the
  // origin-side KIX pin lives in curated.ts, where leading with Itami would
  // cost real money. Seoul and Beijing use their metro codes for the same
  // reason: Gimpo and Daxing are not optional airports to a traveller.
  tokyo: 'TYO', kyoto: 'OSA', osaka: 'OSA', nara: 'OSA', kobe: 'OSA',
  hiroshima: 'HIJ', sapporo: 'CTS', fukuoka: 'FUK', nagoya: 'NGO',
  okinawa: 'OKA', seoul: 'SEL', busan: 'PUS', jeju: 'CJU', beijing: 'BJS',
  shanghai: 'PVG', xian: 'XIY', chengdu: 'CTU', guilin: 'KWL',
  'hong kong': 'HKG', macau: 'MFM', taipei: 'TPE',
  // Preset cities, decided in the header. Hakone has no airport.
  hakone: 'TYO', taichung: 'RMQ', tainan: 'TNN',

  // Southeast Asia
  bangkok: 'BKK', 'chiang mai': 'CNX', phuket: 'HKT', singapore: 'SIN',
  // Preset cities, decided in the header. Koh Phi Phi has no airport.
  krabi: 'KBV', 'koh phi phi': 'HKT',
  'kuala lumpur': 'KUL', bali: 'DPS', jakarta: 'JKT', hanoi: 'HAN',
  // Cambodia replaced both of its airports. REP (the old Siem Reap
  // International) has no row left in OurAirports at all, and PNH is filed
  // with scheduled_service "no" since Techo International (KTI) opened.
  'ho chi minh city': 'SGN', 'siem reap': 'SAI', 'phnom penh': 'KTI',
  // Hoi An has no airport — served by Da Nang.
  'hoi an': 'DAD', 'da nang': 'DAD', 'luang prabang': 'LPQ',
  manila: 'MNL', yangon: 'RGN',

  // Oceania
  sydney: 'SYD', melbourne: 'MEL', brisbane: 'BNE', perth: 'PER',
  // Preset town, decided in the header. No airport of its own.
  'mount cook village': 'ZQN',
  cairns: 'CNS', auckland: 'AKL', queenstown: 'ZQN', wellington: 'WLG',
  nadi: 'NAN',
};

/**
 * Returns the curated IATA code for a city name (case/whitespace
 * insensitive), or undefined if the city isn't in the override map.
 */
export function getStaticIata(cityName: string): string | undefined {
  // NFC, so `Flåm` matches its row whether the å arrived composed or as
  // `a` plus a combining ring, which copy-paste from some sources produces.
  return CITY_AIRPORTS[cityName.normalize('NFC').trim().toLowerCase()];
}
