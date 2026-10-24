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
