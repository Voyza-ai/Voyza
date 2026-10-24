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
  filed as `"Paris (Roissy-en-France, Val-d'Oise)"`. 6.1% of values carry
  parentheticals or commas.
- After cleaning, `"London"` matches **London, Ontario**, and `"Milan"` still
  matches nothing — GeoNames spells it `Milano`.
- OurAirports **has no metro concept**. LTN, STN and SEN do not group to London;
  EWR does not group to New York.
- `keywords` is not an alias field — 40% populated, mostly FAA identifiers.

So the join is: geographic (nearest scheduled airports within a radius) plus a
curated metro override layer, verified against a golden set. Not a string match.

**Assign by largest city within radius, never nearest.** Measured Spearman
against route traffic: nearest-within-50km scores **0.073**, largest-within-100km
scores **0.451**. Nearest attaches LHR to a suburb instead of to London.

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
| `exact` | `Map<key, PlaceId[]>` | the common path |
| `qualifier` | `Map<key, PlaceId[]>` | country/state names and codes |
| `iata` | `Map<code, PlaceId>` | `LAX` typed directly — a real input today |
| `fuzzy` | **trigram inverted index** | typos, only on an exact miss |

**`qualifier` must be multi-valued.** v1 typed it `Map<key, PlaceId>`, which
cannot hold both Georgia-the-state and Georgia-the-country. A one-character fix
now and a wrong-continent bug later.

**`iata` is not optional.** `LAX` is accepted as an origin today. Without this
index it falls to fuzzy and matches **Lae, Papua New Guinea** at distance 1.

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

## Rollout: shadow mode

Phase 1 ships **dark**. Both the old table and the new resolver run on every
real backend request; the **old** answer is served; every disagreement is logged
with the raw input. Both are in-process, so the cost is negligible.

After a week there is a golden set drawn from production rather than from
imagination. Then flip with a runtime flag, not a deploy — which is also the
rollback.

Given there is one Supabase project holding real trips, this is the only
responsible way to find out whether the resolver is worse than what it replaces.

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

| | Target |
|---|---|
| Exact hit | < 0.1 ms |
| Fuzzy path | < 5 ms (trigram measures ~1 ms at 50k) |
| Index memory | < 50 MB |
| Browser hot set | < 60 KB gzipped |
| AI calls | **zero** |

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

## Abbreviations

**31 of the 56 US state and territory codes are also ISO country codes** — `CA`
California/Canada, `DE` Delaware/Germany, `IN` Indiana/India, `MA`
Massachusetts/Morocco, `LA` three ways between Los Angeles, Louisiana and Laos.
Only 25 are clean, including `NJ`.

No special-case list. Position (a comma makes the qualifier reading dominate),
prominence (a bare `LA` means Los Angeles because LAX dwarfs the alternatives as
an origin) and context carry it. The collision list is not 31 forced questions;
it is 31 cases where scoring must earn its answer.

## Phases

| Phase | Deliverable |
|---|---|
| 0 | Fix `ConversationalPlanner.originAirports`. Independent, ships alone. |
| 1 | Pipeline, artifacts, resolver, tests. **Shadow mode** on the backend. |
| 2 | `optimizer.ts` switched first — in-process, has context, no asking problem |
| 3 | Endpoint, browser hot set, frontend callers |
| 4 | Clarification UI — **needs design approval** |
| 5 | Delete `originAirports.ts` ×2, `nearestAirport.ts`, `airportNames.ts`, `cityAirports.ts` |

Phase 5 matters: v1 deleted two tables and left three, including the two
implicated in the Kyoto→Accra bug and the "use my location" path. Folding them
in is a scoping line today and a second project later.

Everything lands on `feat/location-resolver` and merges only on the owner's
approval.

## What v1 got right

Kept unchanged, each verified by review:

- Exact beats fuzzy, and `Paros` is not a typo.
- A city key can never act as a qualifier.
- `Buffalo, NY` resolves to BUF once real cities exist.
- No AI in any path.
- Three results, two of which are questions.
