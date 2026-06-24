# Transport Sourcing — Audit & Architecture Proposal

_Written 2026-06-15. Goal: make the flight + train sourcing layer cover all of
Europe (phase 1), structured so new providers/regions plug in without rewrites
(phase 2 = global)._

---

## 0. The goal, stated precisely

Voyza's defensible edge is **multi-modal optimization** — comparing flights AND
trains door-to-door on every leg. That edge only exists where we have *good data
for both modes*. Today we have great flight data (Duffel) almost everywhere, but
**train data is the bottleneck**, and it's the bottleneck specifically in Europe
— the one region where trains matter most.

So phase 1 is not "add Europe." Phase 1 is **make European rail coverage real**,
in an architecture that lets us add Japan/Amtrak/Korea (phase 2) by registering a
provider, not editing core logic.

---

## 1. Current state (what exists today)

### Flights — `backend/src/services/flights.ts`
- Single provider: **Duffel** (`searchFlights`, `getIataCode`).
- Good global coverage of ~300 airlines incl. easyJet. 429-retry w/ backoff.
- Prices normalized → USD via `currency.ts`.
- Booking = Google Flights deep link (no in-app booking yet).
- **Gap:** Ryanair (Europe's largest LCC) distributes minimally through
  Duffel/GDS, so some cheap European hops are invisible.

### Trains — `backend/src/services/trains.ts`
Two-tier lookup inside one function (`searchTrains`):
1. **Static table** (`backend/src/data/staticTrains.ts`) — hand-entered routes
   for Japan / Korea / China / Taiwan / India. Hit first; skips the API.
2. **Deutsche Bahn REST** (`v6.db.transport.rest`, free, community-run) — for
   everything else.

A `RAIL_COVERAGE_COUNTRIES` set (DACH + IT/FR/Benelux/Scandi/Iberia/UK/…) flags
routes as "good coverage" vs `limitedCoverage`.

### Comparison + options
- `compareLeg.ts` — runs flight + train in parallel, picks cheapest (fastest on
  ties / when within 10%), sets `recommendation`.
- `legOptions.ts` — `searchLegOptions()` returns top-N unified `LegOption`s,
  used by AI chat + the winning route's per-leg alternatives.
- `optimizer.ts` — calls `compareLeg` during scoring, `searchLegOptions` for the
  winner, `searchHomeFlights` for home legs (flights only).

### Config — `backend/src/config/env.ts`
- Only transport-related env: `DUFFEL_ACCESS_TOKEN`, `DB_REST_BASE_URL`.
- No notion of multiple/region-specific providers.

---

## 2. The core problems

### Problem A — `RAIL_COVERAGE_COUNTRIES` is aspirational, not real
The set claims IT/FR/ES/PT/etc. are "good coverage," but **DB REST's stop graph
is German-centric**. Our own live test:

```
POST /api/trains/search  Lisbon → Porto   →  {"offers": []}
```

Portugal IS in the "good coverage" set, so `limitedCoverage = false`, so **no
warning is shown** — the user just silently gets a flight for a route that has a
perfectly good 3h train (Alfa Pendular). This is the Lisbon→Porto bug.

**Root cause:** coverage is hardcoded as a guess instead of derived from what a
provider can actually return. Confirmed by research: `db.transport.rest` wraps
Deutsche Bahn only — it does **not** aggregate SNCF / Trenitalia / Renfe.

### Problem B — providers are hardcoded into the service functions
Adding a new source (Trainline, SNCF, Renfe, Amtrak) today means editing
`trains.ts`/`flights.ts` and growing in-function branching. There's no seam for
"which provider owns this route." That's fine for 2 sources; it does not scale to
the dozen+ a global multi-modal product needs.

### Problem C — silent flights-only fallback
When trains return `[]`, the leg silently becomes flight-only. No signal to the
user, no signal to us. (Already logged as a ROADMAP bug.)

---

## 3. API landscape (research, June 2026)

| Option | Coverage | Access model | Fit |
|---|---|---|---|
| **DB `transport.rest`** (current) | DB + some cross-border/international; weak outside DACH | Free, no key | Keep as the DACH/Germany provider only |
| **Trainline Partner API** | 270+ operators, 45 countries — incl. SNCF, Trenitalia, Renfe, OUIGO, Westbahn | **Partnership-gated** (apply via Trainline Partner Solutions; commercial terms, lead time) | The real pan-European answer |
| **Omio** | 1,000+ operators, multimodal | Partnership-gated, less developer-friendly | Fallback if Trainline declines |
| **Per-operator** (SNCF, Trenitalia, Renfe) | National only, fragmented quality | Mixed; lots of integration work | Only if we can't get an aggregator |
| **Static tables** (current Asia approach) | Whatever we hand-enter | Free, instant | Stopgap for top routes while an aggregator lands |

**Flights:** Duffel stays primary. Ryanair gap is real but lower priority than
rail; address later with a secondary source or an "also check Ryanair" flag.

Sources:
[Trainline Partner Solutions](https://tps.thetrainline.com/) ·
[Trainline B2B API launch](https://www.railwaygazette.com/technology/trainline-launches-international-api-to-streamline-b2b-rail-booking/45213.article) ·
[db-vendo-client API docs](https://github.com/public-transport/db-vendo-client/blob/main/docs/db-apis.md) ·
[v6.db.transport.rest](https://v6.db.transport.rest/) ·
[Omio vs Trainline](https://www.joinsecret.com/compare/omio-vs-trainline) ·
[Duffel easyJet coverage](https://duffel.com/flights/airlines/easyjet)

---

## 4. Proposed architecture — Provider Registry

A thin abstraction so every transport source is a **plug-in** behind one
interface, and route→provider resolution is **data**, not branching.

```ts
// backend/src/transport/types.ts
export type Mode = 'flight' | 'train' | 'ferry';   // ferry = islands (Ibiza, Santorini, …)
export type Coverage = 'authoritative' | 'partial' | 'none';

export interface RouteContext {
  originCity: string;  originCountry?: string;
  destCity: string;    destCountry?: string;
  date: string;        travelers: number;
  fromAirports?: string[];           // multi-airport origin
}

export interface TransportProvider {
  id: string;                         // 'duffel' | 'db-rest' | 'static-rail' | 'trainline'
  mode: Mode;
  /** How well this provider covers the route — decides ordering / warnings. */
  coverage(route: RouteContext): Coverage;
  /** Fetch normalized offers (USD). Must never throw — return [] on failure. */
  search(route: RouteContext): Promise<TransportOffer[]>;
  priority: number;                   // higher wins when several are authoritative
}
```

```ts
// backend/src/transport/registry.ts
// Query every provider whose coverage != 'none', in parallel, merge results.
// If the best train coverage across providers is 'none' → trainAvailable:false
// (this replaces the RAIL_COVERAGE_COUNTRIES guesswork with truth).
export async function searchMode(mode: Mode, route: RouteContext):
  Promise<{ offers: TransportOffer[]; coverage: Coverage }>;
```

Then the existing functions get **thin**:
- `searchTrains()` → `registry.searchMode('train', route)`
- `searchFlights()` stays, but is registered as the `duffel` provider.
- `compareLeg` / `legOptions` / `optimizer` are **unchanged** — they still call
  `searchTrains`/`searchFlights`, which now resolve through the registry.

Providers we register day one (pure refactor, no behavior change):
- `duffel` (flight, authoritative ~everywhere)
- `static-rail` (train, authoritative for the routes in the table)
- `db-rest` (train, authoritative for DACH, partial for declared cross-border,
  **none** elsewhere — fixing Problem A)

Providers we add later without touching core:
- `trainline` (train, authoritative across Europe) → phase 1c
- `amtrak`, `jr-japan`, `korail`, … → phase 2 (global)

### Why this shape
- **Coverage becomes honest** — a route is train-covered iff some provider says
  so or actually returns offers. Lisbon→Porto correctly reports "no train"
  today, and starts working the moment a Portugal-capable provider is registered.
- **Adding a region = adding a file** that implements the interface + one
  `register()` line. The optimizer never changes.
- **Europe-first, global-ready** in the same structure — exactly the stated goal.

---

## 5. Phased rollout

**Phase 1a — Registry refactor (no behavior change).**
Build `transport/` (types, registry), wrap Duffel + DB REST + static table as
providers. Make `db-rest` coverage honest (DACH authoritative; declared
cross-border partial; else none). Port existing tests + add registry tests.

**Phase 1b — Stop the silent fallback + fill top EU routes.**
Surface `trainAvailable:false` to the UI ("No train data — showing flights").
Add a `static-rail` Europe section for the busiest corridors as an immediate
stopgap: Lisbon–Porto, Madrid–Barcelona, Madrid–Seville, Paris–Lyon,
Paris–Marseille, Rome–Florence–Milan, Amsterdam–Paris, Barcelona–Madrid, etc.
(Same pattern as the Japan table — instant, free, "good enough" until 1c.)

**Phase 1c — Real pan-European aggregator.**
Apply to **Trainline Partner Solutions** now (partnership-gated → long lead
time; start early). When granted, implement the `trainline` provider; it becomes
authoritative for Europe and the static EU table retires to a fallback.

**Phase 2 — Global.**
Register regional providers (JR/Korail/CR real APIs, Amtrak via partner, etc.).
Address the Ryanair LCC gap with a secondary flight provider or a flag.

---

## 6. Decisions I need from you

1. **Trainline partnership** — want me to draft the partner-API application /
   find the exact contact + required info? (It's the long pole; worth starting
   even before the refactor.)
2. **Stopgap scope** — how many EU static routes for Phase 1b? (I'd seed ~30 top
   corridors to start.)
3. **Sequencing** — do the registry refactor first (clean foundation), or ship
   the Lisbon→Porto-class static fixes immediately and refactor after?
4. **Ryanair gap** — defer (recommended) or address in phase 1?

_No code has been changed for this proposal — it's analysis only._
