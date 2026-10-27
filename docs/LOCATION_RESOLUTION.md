# Location resolution architecture

Status: **v2, revised after review.** Nothing is built yet.

Turning free text into airports, without ever silently guessing wrong.

> **v1 was wrong in two load-bearing places.** An adversarial review and a data
> research pass both landed before implementation started, and between them they
> invalidated the ambiguity threshold and the context signal. Both are rewritten
> below. The measurements that forced each change are kept inline, because the
> next person to touch this will otherwise re-derive the same wrong answer.

---

## The problem

Every location arrives as free text, from the traveller or from an AI parser:
`New Jersey`, `Paris`, `Paris, France`, `Buffalo, NY`, `the bay area`, `Paros`,
`LAX`. Today a hand-written table of 132 keys handles some of these and fails
the rest in three ways, worst first:

1. **Silently wrong.** `"New Jersey"` resolved to the junk IATA code `"NEW"`.
2. **Silently coarse.** Measured on the live table — `Buffalo, Albany,
   Rochester, Syracuse, Reno, Spokane, Atlantic City` all relocate the traveller
   to the state hub, hundreds of miles away, each one having its own airport.
3. **Silently thin.** `"Paris, France"` returns nothing, falls through to a
   single-airport Duffel lookup, and the traveller loses multi-airport price
   comparison without being told.

## What the traveller gets

Decided with the owner:

- **A place resolves to a list of airports with distances, and the traveller
  picks.** Not one airport. A 2-hour drive is acceptable *as long as it is shown*.
- **Airports that SERVE a place, not airports inside its borders.** Newark is in
  New Jersey and is one of New York City's three airports. Border logic would
  drop it; serving logic keeps it.
- **A bare state or region gives every airport that serves it** — `NY` offers
  JFK, LGA, EWR, BUF, ALB, ROC, SYR and the rest, ranked, with distances.
- **When we genuinely cannot tell, we ask.** In that order: their location
  first, then the trip they are planning, and only then a question.

## Three results

```
resolved   — here are the airports, ranked, each with its distance.
ambiguous  — several real places match. Ask which.
unknown    — nothing matched. Ask, and offer near-misses.
```

A silent empty and a confident wrong are both bugs. The system may not know; it
may not pretend.

v1 proposed a fourth result for "resolved but the airport is far away". It is
not needed: distance is a field on every airport in every result, and the
traveller chooses. That is the owner's answer to the Delaware case — show PHL
with its drive time rather than inventing a rule about it.

## `Paros` is not a typo

The brief suggested correcting `Paros` to `Paris`. It must not.

**Paros is a real Greek island, population 5,289, with scheduled service at
PAS.** A traveller planning Santorini and Mykonos who types Paros means Paros.

The research pass found the trap underneath this: **Paros is absent from
GeoNames `cities15000`**. So a population-thresholded table silently converts a
real destination into a clean typo correction — producing a confident wrong
answer with no way to notice. This is why the trim rule below is a union and
not a threshold.

Rules that follow: exact always beats fuzzy; fuzzy runs only on an exact miss;
fuzzy proposes, never substitutes.

---

## Data

| Source | Use | License |
|---|---|---|
| **OurAirports** `airports.csv` | airports, IATA, lat/lon, scheduled-service flag | **Public domain** |
| **GeoNames** `cities*` + `admin1CodesASCII` | cities, regions, population, alternate names | **CC BY 4.0** — attribution required |
| Curated alias layer (ours) | `the bay area`, `silicon valley`, `nyc`, metro groupings | ours |

Attribution for GeoNames goes in the repo and in the app credits. The licence
version is pinned in GeoNames' `readme.txt`, not on its web page.

**Rejected, with reasons worth keeping:**

- `country-state-city` (npm, 385k downloads/week) is **GPL-3.0**. Disqualifying.
- **OpenFlights is ODbL** (share-alike) *and* frozen since June 2014. Usable to
  measure with, never to ship.
- Wikipedia's airport lists are **CC BY-SA**. Wikidata is CC0 — use Wikidata.
- `node-symspell` has **no licence field at all**, which means all rights
  reserved.
- Every dedicated airport npm package is abandoned (`airports` 2015,
  `airport-codes` 2015, `airport-data` 2017 — all missing airports that opened
  six years ago) or of unverified provenance. Generate from source instead.

### Scale, measured

- **9,054** airports carry an IATA code; **4,008** have IATA *and* scheduled
  service, excluding heliports and seaplane bases.
- **~1,567 cities cover 95% of route-weighted origins.** Covering 95% of
  *population* would take 23,484. That gap is the argument for weighting by
  traffic, not headcount.
- A 10,000-row table measures **1.38 MiB JSON, 7.2 MiB Node heap**.

### The trim rule is a union, never a threshold

```
include = (top N cities by prominence) ∪ (every city with a scheduled IATA airport)
```

A `cities15000` floor **drops 697 airport-serving cities (20.6%)** —
Campbeltown, Unalaska, Kununurra, Gaspé, Emerald. And Paros. A place with an
airport is an origin candidate whatever its population, because having an
airport is the only thing that matters here.

v1's 5 MB disk budget is **deleted**. It was unmotivated — the artifact never
ships whole to a browser — and it would have forced exactly the population floor
this rule rejects. The memory budget stays.

### Joining cities to airports is real work, not a lookup

The research pass found this and it will consume most of the pipeline effort:

- `municipality == "Paris"` returns **zero** scheduled-IATA airports. CDG is
  filed as `"Paris (Roissy-en-France, Val-d'Oise)"`. 6.0% of values carry
  parentheticals or commas (measured on the 2026-10-24 dump).
- After cleaning, `"London"` matches **London, Ontario**.
- OurAirports **has no metro concept**. LTN, STN and SEN do not group to London;
  EWR does not group to New York.
- `keywords` is not an alias field — 40% populated, mostly FAA identifiers.

So the join is geographic plus a curated metro override layer, verified against
a golden set. Not a string match.

### Three corrections, from building it

**1. "GeoNames spells it Milano" was wrong.** The dump's `name` and `asciiname`
are `Milan` — likewise Rome, Naples, Florence, Turin, Genoa. The local spellings
live in `alternatenames` only. The golden test asserts **both** directions so it
survives a flip back. Same correction for the alias layer: `nyc` and `la` *are*
in `alternatenames`; only `the bay area`, `silicon valley` and `dc` are genuinely
absent.

**2. "Largest city within radius" breaks Paros — do not use it.** It was the
documented rule and it is wrong: raw largest-within-100km sends PAS to
Ermoúpolis 50 km away, AMS to Rotterdam, SFO and OAK to San Jose, SOU to a
London borough.

The shipped rule is **distance-decayed prominence**:

```
score = population / (1 + (km / 25)²)
```

Still prominence-driven rather than nearest — it keeps every case the
"largest, not nearest" rule existed for (LTN/STN/SEN→London, BVA→Paris,
SNA/ONT→Los Angeles, NRT→Tokyo, SWF→New York) — but differs on **21 of 70**
hand-checkable airports and is right on all 21.

**3. Same-country assignment is worth more than any radius tuning.** One rule
removes BUF→Hamilton Ontario, HKG→Shenzhen, SAN→Tijuana, ELP→Ciudad Juárez,
TLL→Helsinki across the Gulf, FAO→Huelva, EIN→Brussels, BTS→Vienna.

**Plus a municipality anchor.** Gravity alone recovers only 566 airport-serving
cities (17.6%); adding "the airport's own `municipality` names a city within
30 km in the same country" gives **773 (21.0%)**. Without it Campbeltown
(pop 4,500, 5 km from CAL) loses to Ayr (pop 46,260, 66 km away).

**The join universe is `cities1000`, not `cities5000`.** Campbeltown (4,500),
Unalaska (4,491) and Kununurra (4,515) are all below 5,000 — three of the five
canaries the trim rule exists for. 346 airport-serving cities sit below the
`cities5000` line.

### A state's lead airport: a measured negative result

`airports[]` sorts by `servesPlace` desc, then the OurAirports `type` ordinal
desc, then `km` asc, with an authored pin ahead of all three. For a **bare
state or region** that key can lead with a secondary airport of the state's
dominant metro: California leads **BUR**, not LAX, and both are rank 3, so the
ordinal cannot separate them and the km tiebreak picks Burbank — 147 km from the
population-weighted centroid against LAX's 170.

**Rule tried:** lead a state with the primary airport of its most prominent
member city, promoted only if already in the state's list. It needs no hand
data and it reproduced every judgement the old table encoded.

**Measured, and it does not pay.** 2,571 states/regions got a promotion, but
only **343 reordered anything**; of those 239 promoted a lower-rank airport.
Across US states it fixed 5 and regressed 10:

| Fixed | Regressed |
|---|---|
| California BUR→**LAX** | Florida MCO(97 km)→**JAX(327 km)** |
| Illinois MDW→**ORD** | Connecticut BDL(60)→**LGA(106)** — LGA is in New York |
| New York EWR→**JFK** | Alabama BHM(r3,59)→**HSV(r2,178)** |
| Texas AUS→**IAH** | Virginia RIC(27)→**ORF(128)** |
| North Carolina GSO→**CLT** | Kansas, Missouri, Montana, N. Dakota, S. Carolina, Wyoming |

**Why.** "Most populous city proper" is as bad a proxy for "the state's main
gateway" as centroid distance is. Jacksonville's 1,009,833 is a consolidated
city-county figure that outweighs Miami's 487,014, so Florida led with JAX from
index 9 of its own list — the same class of error the rule was meant to fix,
with a different bad proxy. Huntsville over Birmingham and Virginia Beach over
Richmond are the same story.

**Guards measured over the 343 effective promotions**, none of which rescue it:

| Guard | Keeps | Blocks |
|---|---|---|
| must not lower the rank | 104 | 239 |
| lead within derived top 3 | 321 | 22 |
| lead within derived top 5 | 341 | 2 |
| rank + top 5 | 103 | 240 |

The rank guard is blunt and also kills genuine wins (Cat Island leading its own
strip ATC at 0.8 km instead of ZSA at 132 km). The surgical top-5 guard blocks
exactly two promotions artifact-wide — Florida and `PL.84` — and rescues **only
Florida**: Connecticut, Virginia, Alabama, Kansas, Missouri, Montana, North
Dakota, South Carolina and Wyoming are all same-rank promotions inside the
derived top 5, so no measured guard touches them. Fixing 5 states and breaking
9 is a wash, and a wash does not justify a new artifact field plus a guard.

A third proxy — a derived hub score counting how many places lead with each
airport — fails too: LGA leads for every city in the New York metro, so it
would outcount BDL and win Connecticut outright.

**What would actually fix it is per-airport passenger volume**, which is not
openly licensed globally. That is a data-acquisition question, not a sorting
one. Until then the state key stays as it is.

**Why that is safe to leave imperfect.** `airports[0]` only drives the cheap
permutation-ranking signal in `estimateHomeLegCost`; `buildHomeLeg` then prices
every origin airport that survives the `MAX_HOME_AIRPORTS` cap and takes the
cheapest. California leading BUR therefore costs a traveller **nothing in
fare** — it gives a slightly worse route ordering for a bare state-name origin,
a rare input. There is also no parity regression against the hand-written table
for California or Texas, which it answered with nothing; only Illinois and New
York differ, and both are same-metro swaps the fan-out covers.

## The model

```ts
type Place = {
  id: string;                  // stable across rebuilds
  name: string;
  aliases: string[];           // v1 described these and then omitted the field
  kind: 'city' | 'metro' | 'region' | 'state' | 'country';
  country: string;             // ISO 3166-1 alpha-2
  admin: string | null;
  lat: number;
  lon: number;
  population: number | null;   // RAW, not normalised — see below
  airportRank: number | null;  // RAW
  metro: string | null;        // IATA metro code: NYC, LON, TYO, PAR
  airports: Array<{
    iata: string;
    km: number;                // distance from the place
    servesPlace: boolean;      // true even when outside the border — EWR for NYC
  }>;
};
```

**Raw weights, not normalised.** v1 specified `weight: 0..1`. Normalisation
anchors the scale to the dataset's extremes, so adding one city rescales every
weight, moves every score, and silently invalidates any tuned threshold on the
next rebuild. Store raw; scale at query time with fixed constants. It also makes
the artifact diff readable as an airport changelog instead of noise.

**`metro` is separate from `airports`.** Production already depends on IATA
metropolitan codes (`NYC`, `LON`, `TYO`, `PAR`) on the destination side, where
one search covers every airport, while the origin side needs individual codes so
prices can be compared per airport. Collapsing them breaks one or the other.

**Order is load-bearing.** `estimateHomeLegCost` prices every route permutation
from `originAirports[0]` only. If that order comes out alphabetical, every Los
Angeles trip prices from Burbank instead of LAX and the chosen itinerary
silently changes. Sort key: annual passengers descending, then distance. Tested.

## Indexes

| Index | Shape | For |
|---|---|---|
| `exact` | `Map<key, KeyMatch[]>` | the common path — the match carries its provenance |
| `qualifier` | `Map<key, PlaceId[]>` | country/state names and codes |
| `iata` | `Map<code, PlaceId>` | `LAX` typed directly — a real input today |
| `fuzzy` | **trigram inverted index** | typos, only on an exact miss |

**`qualifier` must be multi-valued.** v1 typed it `Map<key, PlaceId>`, which
cannot hold both Georgia-the-state and Georgia-the-country. A one-character fix
now and a wrong-continent bug later.

**`iata` is not optional.** `LAX` is accepted as an origin today. Without this
index it falls to fuzzy and matches **Lae, Papua New Guinea** at distance 1.

### A key carries its provenance, and that decides contests

**This is the largest correction integration produced, and nothing in the
fixture could have found it.** `Place.aliases` mixed two things that are not
comparable:

- hand-written entries from `curated.ts` — `nyc`, `la`, `the bay area`. These
  are **decisions** about what travellers mean.
- GeoNames alternate names — crowd-sourced, and dirty enough to matter.

Measured on the 36,009-place artifact, with the old flat list:

| Input | Answer | Why |
|---|---|---|
| `Venice` | **Dayton, Ohio** | GeoNames gives Dayton an alternate name folding to `venice`, and Dayton outranks both real Venices |
| `Rome` | offered **Lomé, Togo** | Lomé carries the literal alternate name `rome`; prominence gap to Rome, Italy **0.001** |
| `Washington` | offered Reisterstown MD, South River NJ, Piqua OH, Macomb IL | four towns whose only claim is an alternate name |
| `la` | offered **Laos**, **Lautém, Timor-Leste** | the curated decision tied with three official codes |
| `Rome` + trip `Florence, Venice` | **Rome, New York** | the centroid of Florence IT and *Dayton* is 53.0°N 38.4°W, mid-Atlantic |

So every key is indexed with a tier, and a contest keeps only the best tier
present:

| Tier | Source | Beats |
|---|---|---|
| `curated` | `curated.ts`, by hand | everything |
| `canonical` | the place's own name, or its official ISO/USPS code | aliases |
| `alias` | a dataset alternate name | nothing |

One narrowing fixed all five rows above with **no per-city exceptions**. It also
removed 2,937 keys and 0.8 MiB from the trigram index.

The cost is real and worth stating plainly: a place reachable **only** by a
dataset alias now loses to any place matching the same string canonically. That
is the same direction as the qualifier guard — it fails toward a question
rather than toward Togo. Lomé still resolves from `Lome`; it just stops winning
`Rome`.

**A tier narrows; it never decides.** `Venice` still asks (Italy vs Florida,
both canonical) and `Paris` still asks. Provenance removes claims that were
never real; it does not pick winners among real ones.

### Normalisation is one-to-many

v1 said "lowercase, strip diacritics". Measured, that misses **14 of 22** real
airport-city spellings: `Łódź`, `Tromsø`, `Bodø`, `Đà Nẵng`, `Gießen`, `Köln`,
`Düsseldorf`, `München`, `Þórshöfn`, `Ísafjörður`. Stripping combining marks
does nothing for letters that are not base-plus-diacritic.

So `keysFor(place): string[]` emits every key a place can be found under — NFD
stripping, an explicit transliteration table (`ß→ss, Ł→l, Ø→o, Đ→d, Þ→th, Æ→ae,
Œ→oe, ı→i`), and German dual forms (`köln` → `koln` *and* `koeln`). The query
side emits a key set too and unions the hits.

Whitespace collapses to a **single space**, not to nothing: collapsing to
nothing makes `"New Ark" == "Newark"` and `"Port Land" == "Portland"`.

**A key must come out fully ASCII, and the filter runs per word.** "Has a Latin
letter somewhere" is the obvious test and it indexed **3,522 mixed-script keys**
from the real artifact — GeoNames alternate names in scripts the table does not
cover. They are unreachable from the keyboard that produced the query, so they
could only cost memory and invent fuzzy neighbours; one of them sits a single
edit from `shanghai`.

Dropping every mixed string is too blunt, though, so the rule is about **where**
the foreign script sits. Interleaved inside a word it is failed
transliteration; in a word of its own it is the same name written twice:

- `東京 Tokyo` → `tokyo` — the word a traveller actually types survives
- `Ulaanbaatar Хот` → `ulaanbaatar`
- `shaniግhayi` → nothing
- `chېngdۇ shەһyr` → nothing

When a real place loses a spelling travellers type, the fix is a new entry in
the transliteration table, not indexing a form nobody can enter.

### Fuzzy: trigram, decided by measurement

v1 made length-bucketing the default "unless something beats it on evidence".
Here is the evidence, at 50,000 terms:

| Method | Heap | p50 | p95 |
|---|---|---|---|
| **Trigram inverted** | **7.2 MiB** | **1.04 ms** | 1.94 ms |
| SymSpell (prefix 7) | 105 MiB | 0.04 ms | 0.13 ms |
| Length bucket | 0.5 MiB | 4.38 ms | 7.00 ms |
| Brute force | 0 | 4.69 ms | 7.27 ms |
| BK-tree | 11.4 MiB | 9.62 ms | 14.29 ms |

Length-bucketing is **barely better than brute force** — the ±2 band holds most
of the dictionary. **BK-tree is strictly dominated**: more memory than trigram
*and* slower than brute force. Trigram is 14x lighter than SymSpell for a
latency nobody can perceive.

Trigram's one weakness is short strings — 65% recall under 5 characters, 100% at
or above. Pair it with the exact hash and a brute-force path for short inputs,
where the candidate set is tiny anyway.

**Script guard:** if the input contains no Latin letters and `exact` missed,
return `unknown` with **no** near-misses. Otherwise `東京` proposes "Ba, Ho, Li".

## Resolution

```ts
resolve(input: string, ctx: Context): Resolution

type Context = {
  userLatLon?: { lat: number; lon: number };   // strongest signal
  userCountry?: string;
  tripDestinationNames?: string[];             // names, not Places — see below
};
```

1. Normalise to a key set.
2. Split on commas.
3. **Qualifier pass, right to left**, against `qualifier` only. A city key can
   never act as a qualifier. This is what stops `Paris, Texas` → CDG and
   `Berlin, DE` → Delaware, and it is the single most valuable rule here.
4. Exact lookup of the head segment, narrowed by any qualifier.
5. **Prune**: drop candidates with no scheduled airport within range. This alone
   removes Paris KY, Buffalo MN, Hartford WI, Providence UT.

   **This step is mandatory, not an optimisation.** The built artifact contains
   **2,470 places with an empty `airports[]`** — mostly small admin1 regions
   kept so they can act as qualifiers. Without the prune they resolve
   "silently thin", which is failure mode 3 reintroduced through the new system.

   Note also that `Place.population` on a **region** is the sum of its included
   cities, not a census figure. It is raw and documented, but it is not
   comparable to a city's population — scoring the two against each other would
   make every region outrank every city inside it.
6. Fuzzy, only if 4 found nothing, within the same narrowing.
7. Decide.

### Deciding — a rule, not a threshold

**v1's `AMBIGUITY_MARGIN` cannot work, and this was proven before it was built.**
With no context the score collapses to prominence, and the measured top-2
prominence gaps are:

```
Springfield  0.005      Portland    0.130
San Jose     0.060      Buffalo     0.164
Vancouver    0.071      Providence  0.182
Hartford     0.120      Paris       0.255  ← the LARGEST
```

Bare `Paris` has the **widest** gap in the whole ambiguous set. Any threshold low
enough to resolve Buffalo and Hartford — which work today — resolves Paris to
CDG. Any threshold that makes Paris ask makes all six of those ask. No value
satisfies both requirements.

The cause: `Paris` feels dangerous because of **consequence** (wrong by 8,000
km), not closeness, and a prominence margin has no term for consequence.

The research pass confirmed it independently: across 698 cross-country ambiguous
names, **population alone resolves only 14%** — 602 are genuinely contested.
Ambiguity also *rises* with population (4.6% of cities under 20k have a
cross-country twin, 8.0% of those over 1M), so it is worst exactly where traffic
is highest. It cannot be waved off as a rare-input tail.

So, in order:

1. **An explicit qualifier pins the answer.** `Paris, France` is decided.
2. **The traveller's own location decides next.** If we have coordinates and one
   candidate is plainly nearer, take it. This is the owner's first choice and it
   is free when geolocation is granted.
3. **Trip context decides next** — distance from the centroid of the
   destinations already chosen. Rome and Florence make `Paris` obvious.
4. **Candidates spanning more than one country always ask.** Not a threshold, a
   rule. This is what makes bare `Paris` ask while Buffalo resolves.
5. **A scalar margin applies only to same-country near-ties**, where one global
   number is defensible. Gate on "exactly one candidate within ε of the top",
   so thirty Springfields and two Portlands use the same statistic.

### Resolve late, not early

v1 claimed trip context disambiguates a bare `Paris`. **Measured, that is false
on two of the three planning paths.** `buildRemainingSteps` asks for origin
*first* on the vibe and budget paths, deliberately — it feeds the optimizer's
permutation testing. Destinations do not exist yet. And `Context` cannot hold
`Place[]` anyway: the store keeps plain strings with no coordinates, and
resolving them needs context, which is circular.

**Fix: keep asking origin first, resolve it late.** `/api/optimize` receives
`origin` and `cities` in the same request body, so on the backend the context is
always present, free, with no ordering problem. Store the raw string at the
origin step; resolve when the trip is costed. Context therefore carries
destination *names*, resolved internally.

## Serving: hot set in the browser, long tail on the server

- **Browser**: a generated hot set of the top ~1,000 places. Measured **~40 KB
  gzipped**, and the module is already lazy-loaded, so it is a deferred chunk.
- **Server**: everything else, behind `POST /api/locations/resolve`.

The deciding fact is `HomeEditModal`, which calls the lookup **in a render body,
on every keystroke** against a controlled input. A network call there means
loading state, out-of-order responses and visible lag. Elsewhere a session makes
1–3 resolutions and a round trip is free.

**Both artifacts are generated by one pipeline**, emitted into
`backend/src/data/generated/` and `frontend/lib/generated/`, with a parity test
in CI. The duplication that caused drift was *hand-maintained*; a generated
duplicate with one source of truth is a different thing.

A shared package was rejected on verified constraints: no root `package.json`,
backend `rootDir: ./src` breaks cross-package imports, and Next's bundler does
not reach outside `frontend/`.

**Packaging trap, verified by experiment.** `tsc` does not copy non-TS files:

```
import places from './data/places.json'   → emitted to dist, works
fs.readFileSync(__dirname + '/places.json') → NOT emitted, ENOENT at boot
```

The `readFileSync` form works under `npm run dev` and crashes on Railway. Use
the import form, and assert the build output.

Cold start is fine — parse and index measured at 118 ms for 25k places, 320 ms
for 56k, against a 30-second healthcheck.

## Callers that cannot ask a question

Asking works in the planner conversation. Six other callers cannot, and each
needs a stated non-asking contract:

| Caller | Contract |
|---|---|
| `optimizer.ts` | resolve at the top, before any paid call; return `needsClarification` alongside a best-effort result, never throw mid-run |
| `results/page.tsx` | trips saved before the resolver existed must degrade to today's behaviour |
| `HomeEditModal` | synchronous, from the browser hot set |
| `browse/page.tsx` | geolocation-derived, so coordinates are known — resolve, never ask |
| `legOptions.ts`, `compareLeg.ts` | out of scope for v1, explicitly |

**Persist the answer.** `trips` has `origin_city` and `origin_airports` but no
place id, so every non-asking caller re-derives and may re-derive differently.
Add `origin_place_id` and resolve once. Without it, `Place.id` being "stable
across rebuilds" buys nothing.

### A live bug to fix first, independent of all this

`ConversationalPlanner.applyUpdates` sets `origin` and **never sets
`originAirports`**. On the main conversational path that array is always empty,
so every trip takes the single-airport Duffel path with no multi-airport
comparison. Worth fixing on its own.

## Rollout: shadow, then live — DONE, the resolver now answers

The plan was: run both, serve the old answer, log every disagreement, and flip
on the evidence. That is what happened, and the flip is made.

`LOCATION_RESOLVER_MODE` defaults to **`live`**. `shadow` is the rollback and
`off` removes the resolver from the path entirely; both are an env change, not
a deploy.

**The evidence it was flipped on.** Over the 132 inputs the hand-written table
answers:

| | |
|---|---|
| leading airport identical | **132 of 132** |
| resolver returns nothing | **0** |
| answers the table refuses (its own 109-case corpus) | **19** |

One answer changes, and it is a correction: `Vancouver, WA` moves from SEA —
about 250 km away in Seattle — to **PDX, 7 km away**. The table's fallback
reads the `WA` qualifier as "the Washington metro" rather than as the state
the city is in.

**Two sides had to flip, and only one of them is this flag.**
`optimizer.ts` takes `originAirports` straight from the request body when it
is non-empty and never looks anything up, so the FRONTEND's lookup decides
what real trips are priced from. `originAirportsForCity` was table-first for
exactly that reason during the shadow period — serving resolver answers from
there while the backend was still shadowing would have bypassed the log meant
to justify the change. It is resolver-first now, with the table kept as a
fallback because the hot set is bounded at 60 KB and answers nothing offline
for a place that did not fit.

**What the shadow period actually caught**, which is the argument for having
run it: the two disagreed on 9 of the 132 before the curated pins were
authored, including `doha` (table DOH, artifact DIA — the *old* Doha
International) and `kuala lumpur` (table KUL, artifact SZB — the turboprop
field). Those are fixed in the data, not papered over in the composition.

`locationLiveGate.test.ts` is the evidence as a runnable suite: it fails if a
new lead change appears, and every accepted one carries a written reason.

## As built: phases 2 and 3

### Shadow mode, and the census that did not need a week

`LOCATION_RESOLVER_MODE` is `off` | `shadow` | `live`, read per call so the
rollback is an env change rather than a deploy. `shadow` is the default: both
run, the TABLE is served, disagreements are logged with the raw input.
`services/location/shadow.ts` holds it; `optimizer.ts` is the only backend
caller and resolves at the top of the run, before any paid call.

The plan said a week of production traffic would produce a golden set. It did
not have to wait: the table being replaced ships with its own 109-case test
suite, which is a census of 132 real inputs with known answers. Running both
sides over it found, in minutes, what a week would have:

| | count | meaning |
|---|---|---|
| agree | 32 | identical, order included |
| `resolver-superset` | 36 | same lead, same order, extra fallbacks — benign |
| `legacy-empty` | 18 | the table refused, the resolver answers |
| `different-order` | 12 | same airports, different lead |
| `different-airports` | 11 | genuinely different |
| `resolver-empty` | 2 | **the table answered and the resolver did not** |

Those last two were `Washington State` and `New York State` — a bug, now
fixed, and the reason the resolver has an admin-suffix path at all. The
eighteen `legacy-empty` rows are the clearest wins: `Paris, Texas` → TYR,
`Berlin, DE` → BER, `Baton Rouge, LA` → MSY, `Tbilisi, Georgia` → TBS, all of
which the table returned nothing for.

`resolver-superset` exists because it is the most common shape and it is
harmless: 36 of 77 disagreements were the resolver knowing about one more
fallback airport (`Chicago` → `ORD, MDW, GYY`). Lumping those in with real
conflicts buried the two rows that mattered, so price-changing kinds log at
`warn` (stderr) and benign ones at `info`.

**`airports[0]` matters less than it first appears, and this is worth stating
because it changes how severe an ordering disagreement is.**
`estimateHomeLegCost` searches `airports[0]` alone, but only as a cheap signal
for ranking route PERMUTATIONS; the real multi-airport fan-out happens in
`buildHomeLeg` on the winning permutation, which prices every origin airport
and takes the cheapest. So a wrong lead costs ranking quality and a slot under
the `MAX_HOME_AIRPORTS` cap — not the quoted fare.

### The endpoint

`POST /api/locations/resolve`. POST rather than GET even though a typeahead is
the obvious caller and a GET would be cacheable: the context that makes this
better than a table includes the traveller's coordinates, and coordinates in a
query string end up in access logs. The response is a trimmed shape, not the
internal `Place` — the browser has no business depending on the artifact's
layout, and an ambiguous answer would otherwise ship eight full airport lists.

It has its own limiter (600 per 15 minutes) and is **excluded from the shared
`/api` budget**, because one person naming their origin city can spend a dozen
calls on a single field and would otherwise 429 the planning flow they were
trying to use.

### The hot set, and the "two copies" problem

The owner's instruction was "lets not build 2 copies, find a way to have a
shared file". One file imported by both is not available: the packages have no
workspace root, backend's tsconfig pins `rootDir: ./src`, and Next's bundler
scope stops at `frontend/`. Changing any of those is a build-system project
with a live deploy attached.

So nothing is hand-maintained twice any more. `build-location-hotset.ts`
derives a 60 KB hot set from the artifact and writes it to both packages,
along with a byte-for-byte copy of `keys.ts` — which has NO IMPORTS precisely
so that copy is safe. A parity test in each package compares the bytes. A copy
a person edits drifts; a copy a script writes is a build output.

**The property that makes a hot set safe:** a subset of the data is not a
subset of the answers. A browser holding Venice, Italy but not Venice, Florida
would answer `Venice` confidently while the server asked. So the hot set
stores ANSWERS, and a key is admitted only when every place its answer names
ships with it. `locationHotSet.test.ts` asserts that over all 5,000-odd keys
against the full artifact.

Context is handled by the same honesty. `via: 'prominence'` is the only
outcome the resolver reaches with rivals in hand, so those keys — 53 of them,
against 4,668 that cannot be swayed — are answered offline only when the
caller has no context, and deferred to the server when it has some.

Two seed rules were wrong before measurement, both recorded in the script:
requiring rivals to be seeds in their own right dropped `los angeles`,
`london`, `paris` and `rome` while keeping `la`; and seeding regions on
prominence put all 2,842 admin regions ahead of every city, because a region's
`population` is a SUM — Paris ranked 543rd and Venice 10,827th. Seeds are now
the curated entries, the US states, every place the old table can answer, and
then cities by prominence.

There is deliberately no fuzzy index in the browser. A typo is rare, the
trigram index is 25 MB, and a round trip is the right price for `pariss`.

### The frontend prefill bypasses shadow mode

Found while migrating the call sites, and it would have made the whole rollout
a fiction.

`optimizer.ts` takes `originAirports` **straight from the request body** when
it is non-empty and never looks anything up:

```ts
if (originAirports && originAirports.length > 0) {
  resolvedOriginAirports = originAirports;   // no lookup at all
}
```

Every synchronous frontend call site prefills that array. So a frontend that
called the resolver directly would serve resolver answers to every real trip
no matter what `LOCATION_RESOLVER_MODE` said — the backend's shadow log would
sit there recording nothing while the resolver quietly decided every booking.
There is one Supabase project and it holds real trips.

So `originAirportsForCity` in `frontend/lib/locationResolver.ts` is
**additive by construction**: the hand-written table answers first, and the
hot set is consulted only when the table returns nothing.

```ts
const fromTable = legacyOriginAirports(query, max);
if (fromTable.length > 0) return fromTable;
return originAirportsLocally(query, max);
```

Every input the table answers keeps the table's answer, byte for byte. The
only behaviour that changes is the inputs it answered with NOTHING — 18 of
them in its own 132-key corpus, including `Paris, Texas`, `Baton Rouge, LA`,
`Berlin, DE` and `Tbilisi, Georgia`, which previously fell through to a
single-airport guess or a logged warning.

That it matters is measured, not assumed: across the table's own keys the two
sides disagree on the leading airport for 9 of them, and before the curated
pins were authored those included `doha` (table DOH, artifact DIA — the *old*
Doha International) and `kuala lumpur` (table KUL, artifact SZB — the
secondary field).

**Phase 5 deletes the first line of that function.** Until the flip is
justified by the log, the frontend can only add coverage.

### A qualifier after a space, not just a comma

Step 2 splits on commas, so `Newark NJ` arrived as one long head and missed.
People leave the comma out, and so do the AI parsers that feed this —
`originAirports.ts` hand-keys `washington dc` for exactly that reason.

So on an exact MISS, a trailing run of words is tried as a qualifier,
longest-first. Longest matters, measured: word-by-word from the right turns
`baton rouge la` into "baton" in Louisiana and `newark new jersey` into
"newark new" in Jersey-the-country. Trying every split point and preferring
the longest gives `baton rouge` + `la` and `newark` + `new jersey`.

Running only after an exact miss is what makes it safe. Any real multi-word
name — `new jersey`, `new york`, `salt lake city`, `jersey city` — is already
a key and never reaches it, so the pass cannot take those apart. Beyond that
it is the comma pass exactly: the same `splitHead`, so only a country, state
or region key may qualify and a city key still cannot.

| input | before | after |
|---|---|---|
| `Newark NJ` | unknown | EWR |
| `Baton Rouge LA` | unknown | BTR |
| `Springfield Illinois` | unknown | SPI |
| `Vancouver Washington` | unknown | PDX |
| `Washington DC` | IAD (curated) | IAD, unchanged |

It also closed a hole in the hot set, which is the other half of why it
exists — see below.

### The browser answers a comma form, and settles a position offline

Two gaps were measured against the table the hot set replaces, and both are
closed.

**Comma forms.** `Newark, NJ`, `Buffalo, NY` and `Vancouver, WA` all came back
EMPTY offline while the table answered them, and `originAirports.ts`'s own
comments call `"<City>, <State>"` the shape its AI parser emits most often.
The cause was the hot set keying answers by their NORMALISED form, which turns
a comma into a space: `Newark, NJ` had no key. The generator now emits those
forms — asking the resolver for each, so a form that does not resolve to the
place it was built from is dropped and `Paris, Texas` can never be stored as
Paris, France. The space-separated pass above is what makes storing them
honest: without it `resolve('newark nj')` and `resolve('Newark, NJ')` gave
different answers, so the stored key would have disagreed with the server.

Only qualifiers the index RECOGNISES are used. The naive version generated
`shanghai 23`, `mumbai 16` and `mexico city 09`, because GeoNames admin1 codes
are numeric across much of the world — keys nobody types, and keys the server
answers differently, because with a comma it ignores an unrecognised middle
segment by design while the comma-less key arrives as one long head.

**The traveller's position.** The browser now applies the user-location rule
itself rather than deferring, and it has to: `nearestAirport.ts` promises
geolocation coordinates never leave the device, and deferring with them
attached would break the promise the "use my location" affordance rests on.
The hot set already carries lat/lon for every place it ships, and the three
dominance constants are EMITTED into it from `DEFAULT_OPTIONS` rather than
copied, so they cannot drift.

What it fixes: the `AIRPORT_CITIES` row for Washington DC is named exactly
`Washington`, so every "use my location" tap in the DC metro produces that
string — ambiguous between the District and the state, with the state 3,700 km
away on the other coast as the more prominent reading. With the coordinates it
is the District, offline.

Checked rather than claimed: `locationHotSet.test.ts` runs the browser and the
server over the same (query, coordinates) pairs and requires that the browser
either DEFERS or gives the identical answer. Measured over the current
artifact: 8 agree, 3 defer, 0 disagree. A trip is still deferred, because
reproducing a centroid means a second resolution pass the browser does not do.

### Attribution is wired, and still owed a surface

GeoNames is CC BY 4.0: credit, a licence link and an indication of changes are
obligations. The trigger condition is MET — the frontend falls through to the
resolver wherever the table is silent, which is 18 of the table's own 132 keys,
so GeoNames-derived answers are on screen today.

The wording lives in one place, `backend/src/data/attribution.ts`, and
`locationAttribution.test.ts` compares it to ATTRIBUTION.md word for word.
Every `/api/locations/resolve` response carries it, and the generator emits it
into the hot set so the frontend renders the licence's own words.

**Still outstanding and NOT a code problem:** there is no credits surface in
the app. Importing the constant is not compliance; rendering it where a user
can reach it is, and adding a page is a visible change that gets approved
first.

### `nearestPlace` from the hot set: a measured negative result

Phase 5 wants `nearestAirport.ts` retired, and the obvious replacement is a
reverse lookup over the hot set: it carries lat/lon for every place it ships,
against 102 hand-written entries in the table. Measured over 14 real
coordinates before building it, and **it is not an improvement.**

Mean distance to the matched place does improve, 293 km to 165 km, and that
number is misleading. What matters is the AIRPORTS the match yields:

| from | hand table | hot set |
|---|---|---|
| Lyon | Nice, 299 km | **Vienne 27 km → LYS** ✓ |
| Burlington VT | Montreal, 117 km | **Vermont 16 km → BTV** ✓ |
| Boise | Salt Lake City, 476 km | **Idaho 75 km → BOI** ✓ |
| Omaha | Kansas City, 266 km | **Nebraska 74 km → OMA** ✓ |
| Spokane | Seattle, 367 km | Moscow ID 108 km → **PUW** ✗ |
| Gdansk | Warsaw, 283 km | Frankfurt (Oder) 351 km → **BER** ✗ |
| Fresno | Sacramento, 254 km | California 167 km → **LAX** ✗ |

It wins where a state place happens to be near, because a state's airport list
is every airport that serves it. It loses where the nearest SHIPPED place is a
small city whose airports are wrong: Spokane has GEG inside the city and gets
offered Pullman, and Gdansk gets offered Berlin. That is the same class of
error as pricing Newark from JFK — the one this whole document is about — so
the trade is not worth 102 fewer lines.

The reason is the 60 KB budget: the hot set ships 410 places, and Spokane,
Gdansk and Fresno are not among them. Two ways forward, both the owner's call
because both spend something:

- **Server-side, over all 36,009 places.** Spokane and Gdansk both exist
  there with their own airports, so the answer would be right. It costs the
  promise in `nearestAirport.ts` that geolocation coordinates never leave the
  device, which the "use my location" affordance rests on.
- **A bigger hot set.** Costs page weight on every visit, for a feature one
  tap uses.

So the hand-written table stays for now, and this is written down so the
replacement is not re-proposed as an obvious win.

## Phase 5: the tables are gone

Deleted, and this is the whole list:

| | |
|---|---|
| `backend/src/data/originAirports.ts` | 348 lines |
| `frontend/lib/originAirports.ts` | 343 lines, its hand-maintained twin |
| `originAirportsParity.test.ts` ×2 | the guard that existed only because the two copies did |
| `originAirportAliases.test.ts` ×2 | the table's own suites |
| `services/location/shadow.ts` + its suite | existed only to compare the two |
| `LOCATION_RESOLVER_MODE` | nothing left to fall back to |

**The env-var rollback is gone with them.** That was the honest cost: `shadow`
and `off` only meant something while there was a table to serve instead.
Reverting now is one commit, not one variable.

### The table's knowledge survives as data

`src/data/generated/retiredOriginAirports.json` holds all 146 answers the
table gave, frozen the day it was deleted, with a loader that says **do not
regenerate this**. It is the only independent check the resolver has — every
other suite compares it against the same artifact it reads — and two things
consume it:

- `locationLiveGate.test.ts`, now a permanent regression net rather than a
  flip gate. It fails if the resolver stops reproducing a leading airport, and
  every accepted difference carries a written reason.
- `build-location-hotset.ts`, which seeds the hot set from those inputs so the
  60 KB budget can never be spent somewhere that leaves a
  historically-answerable input needing a round trip. Asserted, not hoped.

### Four bugs the deletion exposed

Taking the fallback away turned every silent gap into a failure, which is the
argument for doing it rather than leaving a table in place forever.

1. **The seeder was looking up the wrong thing.** It normalised each retired
   input to a comma-free key and looked it up in the index — but comma forms
   are not index keys, so every qualified input missed. `Portland, Oregon`
   seeded nothing, and `portland` was not even a hot-set key. It resolves the
   input now.
2. **The spaced qualifier pass narrowed provenance before the qualifier**, the
   same bug as the main path and found the same way: `washington ut` resolved
   to nothing, because the curated `washington` reading is the capital and the
   `ut` qualifier was left with nothing to match. The comma form worked, so
   the two disagreed — and the hot set, which keys answers by the comma-free
   form, stored one while the server gave the other.
3. **It peeled only one qualifier run.** `brooklyn new york usa` and
   `shanghai shanghai china` resolved as comma forms and not as keys. It peels
   repeatedly now, like `splitHead` always did.
4. **Then it peeled too far.** `new jersey nj` became "New" in Jersey, the
   country. It stops as soon as what is left is a name the index knows — the
   same guard that lets the pass run at all, applied after every peel.

### What was NOT deleted, and why

- `nearestAirport.ts` — a hot-set reverse lookup is measurably worse; see the
  negative result above.
- `airportNames.ts` — IATA → display name, which `PlaceAirport` has no field
  for. No backend twin, so it was never part of the duplication problem.
- `cityAirports.ts` — destination-side. The 13 calls it was holding are now
  decided; it is down to **two** entries that cannot be answered anywhere
  else. See below.

### The 13 destination-side decisions, made

When the artifact was first checked against `cityAirports.ts`, the resolver
reproduced 156 of its 169 entries via `metro ?? airports[0]` — the remaining
13 were metro-code versus single-airport calls, and they were left for a
person on purpose. Re-measured on the current artifact the count was 12:
`washington` had already been closed by the curated alias added for the `live`
flip, which is the 13th.

The split, and the principle that produced it: **a destination wants one code
that covers every airport, an origin wants the individual codes in the right
ORDER.** Those two pull opposite ways on the same city, which is why these
entries looked undecidable from the data.

**Seven went to the resolver**, and the table now holds its answer, so
deleting the file changes nothing for them:

| key | was | is | why |
|---|---|---|---|
| `kyoto`, `nara` | KIX | **OSA** | the KIX pin is an ORIGIN decision — Itami is nearer and domestic-focused, so a home leg must not price from it. A KIX-only destination search cannot return the Haneda–Itami service, which is how a traveller on a multi-city Japan trip actually reaches Kyoto. |
| `kobe` | UKB | **OSA** | Kobe's own airport is a small domestic field; nearly everyone arrives through Kansai or Itami. UKB alone was the worst of the three answers. |
| `seoul` | ICN | **SEL** | Gimpo carries nearly all domestic service plus the Haneda and Osaka shuttles. |
| `beijing` | PEK | **BJS** | Daxing now carries a large share of Beijing's traffic, and a PEK-only search drops all of it. |
| `siem reap` | REP | **SAI** | REP has **no row at all** in OurAirports 2026-10-24: the old Siem Reap International closed when Siem Reap–Angkor opened. The table was pointing at an airport that does not exist. |
| `phnom penh` | PNH | **KTI** | PNH is still filed, with `scheduled_service: "no"` — Phnom Penh International stopped taking commercial traffic when Techo International opened. |

**Three went to the table**, and the curated layer now carries them, so the
resolver reproduces those too:

| key | the resolver said | why the table is right |
|---|---|---|
| `buenos aires` | EZE | the top candidate was the PROVINCE, which outranks the city because a region's `population` is a SUM (7,971,365 against 2,891,082) and the city is not administratively inside it. A region carries no metro code, so Aeroparque — where the flights from Montevideo, Santiago and the interior land — was dropped. A curated alias pins the city: BUE on the destination side, and EZE 27 km, AEP 7 km on the origin side, against the province's EZE 74, AEP 105, **SST 237** — a beach strip taking the third `MAX_HOME_AIRPORTS` slot. |
| `reykjavik` | KEF | no dataset has the metro concept: OurAirports files both airports under municipality "Reykjavík" and carries REK only in `keywords`. KEF already led on rank, so a metro group changes no order — it restores the code that lets one search cover Keflavík for the flight from abroad and Reykjavík Domestic for the leg from Akureyri. |
| `bucharest` | BBU | Băneasa (large, 7.9 km) led Henri Coandă (large, 15.5 km) on distance with the ordinal unable to separate them — the old-Doha-International shape. Băneasa is the business-aviation field. The metro group pins OTP and adds BUH, and `RO.10` is pinned to match, so an origin lookup also stops pricing Bucharest from Băneasa. |

**Two are not decided, and they are why the file still exists:**

- **`moscow` → MOW.** The resolver answers **SVO**, because its top candidate
  is the Moscow federal-city REGION and a region never carries a metro code,
  so Domodedovo and Vnukovo are invisible to a destination search. MOW is
  plainly the right destination answer. The only mechanism the curated layer
  offers is an alias onto the city — and measured, that alias costs the one
  case it would be wrong about: a traveller whose coordinates are in **Moscow,
  Idaho** resolves to PUW, 8.6 km away, today, and would get Sheremetyevo
  instead. It would also remove a rule-4 multi-country question. It buys the
  exact retired origin triple (SVO, DME, VKO against the region's SVO, VKO,
  **ZIA**). That trade is the owner's, so the entry stays and
  `cityAirportsDecisions.test.ts` asserts the Idaho rescue — adding the alias
  fails that test rather than passing silently.
- **`kyiv` → IEV.** Both Kyiv airports are filed `scheduled_service: "no"`,
  so neither is in the artifact's airport universe and the resolver answers
  `unknown` with Kyiv itself as the near miss. The curated layer cannot hold
  it either: `addCuratedAirports` throws on an airport without scheduled
  service, by design. The value is a deterministic stub that keeps
  `getIataCode` off the Duffel guess that produced the Kyoto→Accra bug. When
  service resumes the resolver answers it from the dump with no code change.

**The cleaner fix for `moscow`, not taken.** `Moscow, Russia` the region and
`Moscow, Russia` the city produce candidates with the IDENTICAL label, and
`dedupeByLabel` keeps the FIRST, which is the region. Preferring the
point-like place when labels collide would answer MOW, keep the Idaho
question, and need no curated entry — but it changes which `placeId` a
clarification card carries, so it is a resolver change for the owner rather
than a data decision.

## Observability

The original bug was silent, so: **log every `unknown` and `ambiguous` with the
raw input.** That one line is the cheapest thing that would have caught
`"New Jersey"` → `"NEW"`, and it is the only way the long tail becomes
discoverable.

`/api/locations/resolve` needs its own rate limiter, excluded from the shared
100-per-15-minutes `/api` budget, or resolve calls will 429 the actual planning
flow. Note that rate limiting is **skipped entirely when `NODE_ENV=development`**,
so this is invisible locally. Specify a max input length.

## Budgets, asserted by tests

| | Target | Measured, on the real 36,009-place artifact |
|---|---|---|
| Exact hit | < 0.1 ms | **0.005 ms** p50 |
| Fuzzy path | < 5 ms | **0.19 ms** p50, 1.4 ms p95, 2.4 ms worst seen |
| Index memory | < 50 MB | **88.2 MiB — over budget, see below** |
| Browser hot set | < 60 KB gzipped | **59.9 KB**, asserted by the builder and a test |
| Index build | — | **1.1 s**, lazy, once per process |
| AI calls | **zero** | zero |

**The memory budget is exceeded and the number is the measured one, not the
hoped-for one.** Broken down, with `--expose-gc` and a forced collection
between each step:

| | |
|---|---|
| parsed artifact (36,009 places) | 30.5 MiB |
| the four indexes | 57.7 MiB — of which the trigram index is 24.8 MiB |
| **total cost of having the resolver in a process** | **88.2 MiB** |

The 50 MB figure was written before any of this existed, and the honest
reading is that it was optimistic rather than that the implementation is
wasteful: 175,921 exact keys over 36,009 places is the index, and the trigram
index is the price of typo tolerance.

What makes it affordable rather than fine: the index is built **lazily on
first use**, so a process that never resolves a location — a worker, a
migration, most of the test suite — pays nothing, and the cost lands once.
88 MiB on top of Node, Express and the app is a real increase on a small
Railway instance but not close to a 512 MB limit.

If it ever needs to come down, the trigram index is 28% of it and serves only
typos; the browser already ships without one for exactly that reason. Dropping
it server-side would cost the "did you mean" list, which is the one thing
standing between a typo and a silent miss, so it is not a trade to make
casually.

An AI fallback is out of scope for v1. Airports, cities and countries are a
finite, slowly-changing set; a table is faster, cheaper, reproducible and
testable. If a class of input genuinely resists data, that is a finding to bring
back with examples.

## Testing

- **Golden set** of real inputs, including every example in this document.
- **Must-never set** — each of these shipped as a real bug or is one keystroke
  away:
  ```
  Berlin, DE      → Germany, never Delaware
  Tel Aviv, IL    → Israel, never Illinois
  Casablanca, MA  → Morocco, never Massachusetts
  Baton Rouge, LA → Louisiana, never Los Angeles and never Laos
  Vancouver, WA   → Washington state, never Vancouver BC
  Bogota, CO      → Colombia, never Colorado
  Paros           → Paros, never silently corrected to Paris
  ```
- **Must-ask set** — bare `Paris` with no location and no trip.
- **Negative controls.** Every test must fail against the current
  implementation. Vacuous tests have shipped in this repo before.
- **Regenerate the code lists** (ISO 3166, USPS) from source at build time and
  assert them. The lists in this document were derived from memory.
- Performance assertions against the budgets.

## Settled during integration

The resolver and the pipeline were built in parallel against `types.ts`. Where
they met, five things in this document turned out to be wrong or unreachable.
Each is recorded with what replaced it, so the next reader does not re-derive
them — or re-add the one that was removed.

**There is no `'fuzzy'` resolution reason.** Fuzzy *proposes*; it never
resolves. A near-miss comes back as `unknown.suggestions` and is never applied
on the traveller's behalf, so the reason was dead code in the contract and is
gone. `pariss` returns `unknown` with Paris as the first suggestion at edit
distance 1 — a question the caller can offer in one tap, not a silent
substitution.

**A bare `LA` is settled by curation, not prominence.** See Abbreviations
above; the measured gap is 0.016 and the old wording was wrong.

**Non-Latin input is a stated limit, not a silent failure.** The artifact
carries no native-script keys, so `東京`, `서울` and `القاهرة` cannot hit
`exact`, and the script guard stops fuzzy proposing a Latin lookalike — without
it, `東京` proposes "Ba, Ho, Li". The outcome is `unknown` with **no**
suggestions, which the UI turns into a question. Native-script input is a real
gap and a phase of its own: it needs the generator to read GeoNames
`alternateNames` with language filtering, and it is not pretended to work
today.

**The rule that was tried and removed: no state-beats-city preference.** A
bare `Delaware` answering with a town of 41,302 in Ohio looks like a bug, and
an "administrative unit wins" rule was written to fix it. The measurement
killed it:

| Input | Gap to the state | Outcome |
|---|---|---|
| `Delaware` | 0.033 | asks |
| `Washington` | 0.041 | asks |
| `NY` | 0.350 | **already resolves** to the state |

`NY` never needed the rule — prominence resolves it outright, with Buffalo and
Albany in the airport list exactly as the owner asked. And no margin can
resolve `Delaware` while still asking about `Washington`, where DC and
Washington State are both real destinations. The two cases are the same shape
numerically, so preferring the state means answering `Washington` with the
state, which is wrong. **Delaware asks. That is consistent, not a gap.** It is
the same finding as `Paris` having the widest prominence gap in the ambiguous
set: a scalar cannot separate these, and a rule that looks principled is a
special case in disguise.

**Candidate distance is a number, not text in the label.** `distanceKm` was
added to `Candidate`; it previously rode inside `label` only because the
contract was being built in parallel and could not be changed mid-flight.

### The structural fix: test against the real artifact

Every one of the bugs above survived 130 fixture tests, and that is the
transferable lesson. A fixture holds the collisions someone thought of; 36,009
real places hold the ones nobody would — that GeoNames writes `venice` on
Dayton, Ohio, and `rome` on Lomé.

So `locationResolveArtifact.test.ts` runs the pipeline over the **generated
artifact**, with a must-never list in which every entry is a measured
regression rather than an imagined one. It costs about a second to build the
index. Verified by mutation: disabling the provenance narrowing fails six of
its cases.

Both suites are kept. The fixture stays the place to write a case for a *rule*;
the artifact suite is the place a case about *data* belongs.

## Phase 4: the question itself — NOT BUILT, needs design approval

Everything behind the question is finished and tested. Nothing renders it,
because the question is a design change and this repo's rule is that design
changes are approved before they are committed.

**What already carries the data, end to end:**

| Layer | Field |
|---|---|
| resolver | `Resolution.ambiguous.candidates`, each with `label`, `airports`, `distanceKm` |
| endpoint | `POST /api/locations/resolve` → `{status:'ambiguous', reason, candidates}` |
| browser | `resolveOffline` / `resolveLocation` → the same `LocationAnswer` |
| optimizer | `OptimizeResult.originClarification` — `{input, reason, candidates}` |
| frontend API type | `OptimizeResult.originClarification`, same shape |

Each candidate already has everything a question needs: something to read, a
stable `placeId` to persist, the airports it would be priced from, and the
distance from wherever the traveller is.

**Where a question would appear**, and what each caller currently does
instead — every one of these has a `TODO(location-phase-4)` at the call site:

- the planner conversation, when the origin is ambiguous. It can ask properly;
  today it silently takes the best reading.
- `HomeEditModal`, when a typed city is ambiguous. Synchronous, so it has the
  candidates in hand already.
- the results page, when a trip's total was priced from a guessed origin. This
  is the one with real money attached: `originClarification` means the figure
  on screen rests on a reading nobody confirmed.

**The decisions that are the owner's, not mine:**

1. Is an ambiguous origin a blocking question, or a banner on a trip that was
   already priced? The architecture note says "flag rather than block" and the
   non-asking callers are all built that way, but the planner conversation
   could reasonably block, since it is a conversation.
2. How a `not-found` differs from an `ambiguous` on screen. They are different
   questions — "which of these?" against "we have not heard of this, did you
   mean?" — and a typo must never be applied silently, so the second one needs
   a shape that does not look like a confirmation.
3. Whether to show distance. Every candidate has it, and "2,057 km away" is
   the single most useful distinguisher between two places called Paris. It is
   also the kind of detail that makes a card look busy.
4. Whether a resolved origin should be persisted. `trips` has `origin_city` and
   `origin_airports` but no place id, so every caller re-derives and may
   re-derive differently. Adding `origin_place_id` would make a resolution
   happen once — and it is a migration against the one Supabase project that
   holds real trips, so it is an explicit decision rather than a tidy-up.

Constraints already understood from the repo's design rules: no glass
morphism, no glows, no gradient-purple; derive from the product's own DNA —
the dark `#0f0f1a` AI surfaces, the pastel city cards, the dashed-route motif,
the blue brand. And narrow-screen layout is deferred, so this is a
desktop-first shape.

## Abbreviations

**31 of the 56 US state and territory codes are also ISO country codes** — `CA`
California/Canada, `DE` Delaware/Germany, `IN` Indiana/India, `MA`
Massachusetts/Morocco, `LA` three ways between Los Angeles, Louisiana and Laos.
Only 25 are clean, including `NJ`.

No special-case list. Position (a comma makes the qualifier reading dominate),
**provenance**, prominence and context carry it. The collision list is not 31
forced questions; it is 31 cases where scoring must earn its answer.

**Corrected after measurement.** This section used to say prominence settles a
bare `LA`. It does not, and the resolver agent was right to flag the
contradiction with rule 4. Measured on the real artifact, `la` reaches ten
places and prominence puts Los Angeles 0.364 against Louisiana 0.349 — a gap of
0.016, well inside the 0.10 near-tie margin, with Laos and Lautém, Timor-Leste
also in the list. Prominence cannot carry it and rule 4 would have asked, since
the candidates span four countries.

What carries it is that **`la` → Los Angeles is a curated decision**, so the
curated tier narrows the field to one before the decision ladder runs at all.
`via` is `curated-alias`, not `prominence`. The same mechanism settles `nyc`,
which otherwise tied with Manhattan at a 0.037 gap.

Where no curated decision exists, the ladder still applies and `DE`, `IN` and
`MA` still ask — which is correct, because nobody has decided what those mean.

## Phases

| Phase | Deliverable | State |
|---|---|---|
| 0 | Fix `ConversationalPlanner.originAirports`. Independent, ships alone. | done |
| 1 | Pipeline, artifacts, resolver, tests. | done |
| 2 | `optimizer.ts` switched first — in-process, has context, no asking problem. **Shadow mode.** | done |
| 3 | Endpoint, browser hot set, frontend callers | done |
| 4 | Clarification UI — **needs design approval** | data path ready, UI NOT built |
| 5 | Retire the old tables — fewer than the five first listed; see the breakdown below | gated on the `live` flip |

Phase 5 matters: v1 deleted two tables and left three, including the two
implicated in the Kyoto→Accra bug and the "use my location" path. Folding them
in is a scoping line today and a second project later.

### Phase 5 is not five deletions — corrected after checking

Written as "delete five files", and three of the five cannot simply go. Checked
against the code rather than assumed:

| File | Blocked on | Why |
|---|---|---|
| `originAirports.ts` ×2 | the shadow log | it IS the comparison baseline, and `originAirportsForCity` still leads with it. Deleting it before the flip to `live` removes the only evidence that the replacement is not worse. |
| `nearestAirport.ts` | a new capability | it answers coords → nearest airport city, for "use my location". The resolver takes coordinates as CONTEXT to disambiguate a name; it has no reverse-geocoding entry point at all. The artifact has lat/lon on all 36,009 places, so a `nearestPlace(lat, lon)` would be both easy and better than the handful of major cities embedded today — but it is an addition, not a deletion. |
| `airportNames.ts` | artifact data, and probably should stay | IATA → display name. `PlaceAirport` is `{iata, km, servesPlace}` with no name, so there is nothing to replace it with. It also has no backend twin, so it is not part of the duplication problem the owner asked to fix — and putting ~267 airport names in the hot set costs budget the hot set does not have. |
| `cityAirports.ts` | 2 entries, not 13 | **It exists** — an earlier version of this table said otherwise. Destination-side (city → one primary IATA), read by `getIataCode`, and it holds the Kyoto→Accra override. The 13 metro-vs-specific-airport calls are now decided — seven to the resolver, three into `curated.ts`, `washington` earlier — and the file is down to `moscow` (needs a resolver change or an alias the owner must weigh) and `kyiv` (no scheduled service anywhere in the dump). See "The 13 destination-side decisions, made". |

So the honest shape of phase 5 is: flip to `live` on the evidence, add
`nearestPlace`, then delete two files and keep `airportNames.ts`.

### The gate for flipping to `live`

Stated concretely, because "it seems fine" is not a gate and there is one
Supabase project holding real trips:

1. **The resolver reproduces every lead the table had, bar one named
   exception.** Measured across all 132 keys the table answers: **0 missing,
   and the leading airport matches on 131 of 132**. The leading airport is what
   matters because it is the one `estimateHomeLegCost` ranks permutations from;
   extra fallbacks after it are a gain, not a difference.

   The leads come from the table itself, carried into `curated.ts` as an
   authored seed block — the table's 132 keys already held exactly the human
   judgement the curated layer exists for, in the wrong file. Seeding was a
   one-time materialisation, not a build step, because phase 5 deletes the
   table and a build-time read would take the leads with it.

   **The exception is bare `washington`, and it is deliberate. Do not "fix" it
   back.** The table answers IAD; the resolver answers SEA and asks. Every one
   of the other 131 was a disagreement about airport ORDER WITHIN a place,
   which is what a pin fixes. This one is a disagreement about WHICH PLACE
   WINS: bare `Washington` is an ask across Washington state, Washington DC,
   Washington UT and Washington IL, and the state leads on prominence. Pinning
   IAD onto the DC city does not change which candidate ranks first, and
   pinning it onto Washington *state* would be plainly wrong.

   A curated alias `washington` → Washington DC would reproduce the table
   exactly, since the curated tier beats canonical in the narrowing — the
   mechanism that makes `la` resolve to Los Angeles. It was **considered and
   rejected**: the table silently guessed DC, whereas the resolver offers both
   DC and Washington state with labels and distances so the traveller picks.
   The owner's instruction on this exact input was "we can't return nothing"
   and "yes it should ask". Washington state is a major destination, not a
   long-tail curiosity, so an alias here would suppress a real question in
   order to match a table we are replacing *because* it guessed. `la` is not
   the same case: nobody means Louisiana or Laos by "LA", so there is no
   question to suppress.

   The cost is bounded and measured: a non-asking caller gets SEA instead of
   IAD, which moves only the permutation-ranking signal, because
   `buildHomeLeg` fans out across every surviving origin airport and takes the
   cheapest fare. The table's own `washington dc`, `dc` and `washington state`
   keys all still agree, so the only input that changes is the bare ambiguous
   one.
2. **No price-changing disagreement left unexplained in the shadow log.**
   `shadow.ts` logs those at `warn` and benign supersets at `info`, precisely so
   this is readable rather than a wall.
3. **The owner says so.** 1 and 2 are necessary, not sufficient — see "Say so
   when data gets edited" in CLAUDE.md. The flip is an env change and so is the
   rollback, which is the whole reason it was built that way.

Everything lands on `feat/location-resolver` and merges only on the owner's
approval.

## What v1 got right

Kept unchanged, each verified by review:

- Exact beats fuzzy, and `Paros` is not a typo.
- A city key can never act as a qualifier.
- `Buffalo, NY` resolves to BUF once real cities exist.
- No AI in any path.
- Three results, two of which are questions.
