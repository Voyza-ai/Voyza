# API Providers — Master Plan (real data only)

_Researched 2026-06-15. The complete list of every data source Voyza needs,
its status, how to get it, and the recommendation. Principle: **real live data
only — no fake, no hardcoded.**_

---

## Business model: deep-link now → in-app booking very soon

Users book on the **partner's trusted site** (Booking.com, airline, Trainline) and
we earn **affiliate commission** on the click-through. In-app booking is a
**near-term goal** (build trust first), so we pick providers that support **both**
— affiliate/deep-link now, booking later — to avoid rip-and-replace.

Two layers:
- **Data layer** — real prices for the optimizer + display. Can't fake this.
- **Money layer** — affiliate links now → in-app booking soon.

> ⚠️ Today every "Book" link is generic (Google Flights, bahn.de, raw
> Booking.com) with **no affiliate tracking → $0 revenue.** The model is intended
> but not implemented.

## Priorities

### Data layer (real prices — needed now)
| # | Provider | Mode | Why | Access |
|---|---|---|---|---|
| D1 | **Duffel — LIVE token** | Flights | Test token = fake flights today. Live = real data now **and** booking soon. | Self-serve verify |
| D2 | **Kiwi Tequila** | Flights (LCC) | Ryanair + 250 LCCs Duffel misses. | Self-serve |
| D3 | **Deutsche Bahn REST** (have) | Trains | Free real data — DACH only. | Have |
| D4 | **Trainline / Direct Ferries / Ferryhopper** | Trains / Ferries | Real EU rail + ferry prices. | Gated — start now |

### Money layer (revenue — affiliate now → booking soon)
| # | Action | Mode | Why | Access |
|---|---|---|---|---|
| **M1** | **Booking.com affiliate ID** | Hotels | We already pull Booking data but link with no affiliate → $0. **Biggest, easiest revenue.** | Self-serve |
| M2 | **Travelpayouts account** | Hotels + Flights | One network = hotel + flight affiliate links + data. Fast multi-mode revenue. | Self-serve |
| M3 | **Trainline affiliate** | Trains | Commission on rail click-throughs (lower bar than the Partner API). | Self-serve-ish |
| M4 | **Direct Ferries affiliate** | Ferries | Commission on ferry click-throughs. | Free sign-up |

### Booking soon (when in-app booking ships)
Duffel Orders (flights), Trainline Partner API (trains), Direct Ferries Connect
(ferries). These are gated with lead time → **start the applications now** even
though they land later.

---

## What we already have

| Provider | Mode | Real? | Notes |
|---|---|---|---|
| Duffel (**test token**) | Flights | ❌ FAKE | Sandbox "Duffel Airways", `live_mode:false`. Needs live token (#1). |
| Deutsche Bahn REST | Trains | ✅ Real | Free, no key. **Germany-centric** — weak/empty outside DACH. |
| Booking.com (RapidAPI) | Hotels | ⚠️ Real key | Free RapidAPI tier — verify it's not rate-limited/stale before launch. |
| Anthropic | AI | ✅ Real | Planning/interpret. |
| open.er-api.com | Currency | ✅ Real | Free FX; hardcoded fallback rates only if the API is down. |
| Supabase | DB/auth | ✅ Real | — |

---

## Flights

**Verdict: Duffel is the right primary for your stage** — and not just because
it's already wired in. The obvious alternative, **Amadeus Self-Service, is being
shut down July 17 2026** (≈1 month away); legacy GDS (Sabre/Travelport) need
enterprise contracts + setup fees — wrong for a pre-revenue startup. Duffel is
self-serve, $0 up-front, pay-per-booking, NDC content, and has a clean in-app
booking path (Orders API) for when you add booking. Its one real weakness is
**LCC coverage** — which is exactly why we pair it with an LCC provider below.

**Keep Duffel** as the primary (GDS-style breadth, ~300 airlines incl. easyJet),
but **two actions needed:**

1. **Duffel LIVE token (#1 priority).** Today's flights are sandbox data. Live
   token requires completing Duffel's account verification (business details).
   Free to search; Duffel monetizes on bookings later. → *You complete this in
   the Duffel dashboard; I'll walk you through it.*

2. **Add Kiwi.com Tequila (#2).** Duffel does **not** carry Ryanair (Europe's
   #1, often cheapest). Kiwi connects ~750 carriers incl. **250+ LCCs**, and
   **Ryanair partnered with Kiwi in 2024**. Two tiers:
   - **Affiliate/search tier** — free, self-serve (register → API key). Returns
     real prices + redirect links. **This is all we need today** (we deep-link,
     not in-app book).
   - **Booking tier** — for in-app booking later; needs a partner agreement +
     deposit.
   → *Self-serve. I can scaffold the provider once you have the key.*

Net: Duffel (live) + Kiwi = real coverage **including** the cheap LCC fares that
make the "cheapest way" promise true.

**LCC alternative — Travelfusion** (for later/scale): a dedicated low-cost
specialist (370+ LCCs incl. NDC, real ticketing) — *deeper* LCC coverage than
Kiwi's 250. But heavier onboarding (contract + setup fees, 4–8 wk) vs Kiwi's
self-serve. Plan: **Kiwi now** (fast, free, has Ryanair) → evaluate
**Travelfusion** if/when we need deeper LCC coverage at volume.

**Why not Kiwi as the primary instead of Duffel?** Kiwi's coverage is broad, but
its bookings use *virtual interlining* where Kiwi is merchant-of-record (less
control, the "Kiwi Guarantee" is theirs not ours), and production/commercial use
needs partner approval. Duffel gives cleaner full-service + NDC content and a
booking path we own. So: Duffel = foundation, Kiwi = LCC/price filler.

---

## Trains

1. **Deutsche Bahn REST** — keep, but **only for where it actually returns
   results** (DACH + some cross-border). Stop pretending it covers Iberia/Italy.
2. **Trainline Partner API (#3)** — the real pan-European answer: 270+ operators,
   45 countries (SNCF, Trenitalia, Renfe, OUIGO, Westbahn…). Partnership-gated
   via their get-in-touch form. **Application already drafted** →
   [TRAINLINE_APPLICATION.md](TRAINLINE_APPLICATION.md). Start now (long lead).
3. Until Trainline lands: non-DACH train legs honestly show **"no live train data
   yet — showing flights."** No fabrication.

---

## Ferries (islands — Ibiza, Greece, Sardinia, Croatia)

Two strong real options:

| | **Direct Ferries Connect** | **Ferryhopper (FerryhAPI)** |
|---|---|---|
| Coverage | 4,400+ routes, 300+ operators, ~24 countries incl. Spain/Balearics, Greece, Italy, Portugal, Croatia | 4,000+ routes, 160+ operators, 33 countries — **Mediterranean-strong** (Greek islands, Spain, Italy, Turkey) |
| Model | "Global ferry GDS," single RESTful API + affiliate + widget + whitelabel | Single API + affiliate + **MCP server for AI assistants** |
| Access | Free sign-up; `partnerships@directferries.com` | Partner "get in touch"; MCP server is an unusually fast path |
| Best for | **Widest coverage** (the comprehensive pick) | Med-focused; the **MCP server could be a fast interim win** |

**Recommendation:** apply to **Direct Ferries Connect** for breadth (#4).
Explore **Ferryhopper's MCP server** in parallel as a quick way to get live
Mediterranean ferry data without a full API integration.

---

## Strategic note: best-of-breed vs. one multimodal aggregator (Omio)

There's a fork worth a deliberate decision:

- **Best-of-breed (recommended):** Duffel + Kiwi (flights), Trainline (trains),
  Direct Ferries (ferries). More integrations, but best coverage + price per
  mode, and full control. The provider registry is built for exactly this.
- **Omio (single multimodal API):** trains + buses + **ferries** + flights in one
  integration (1,000+ operators). Fewer integrations, but partnership-gated, less
  developer-friendly, and less price control. (Notably, **Direct Ferries already
  powers Omio's ferries** — so going direct cuts the middleman.)

Recommendation: **best-of-breed.** The registry makes multiple providers cheap to
maintain, and per-mode specialists give better prices — which is the product.
Keep Omio in mind only if integration bandwidth becomes the bottleneck.

---

## Your action checklist

- [ ] **Duffel:** complete account verification → get LIVE token _(I'll guide)_
- [ ] **Kiwi Tequila:** register at tequila.kiwi.com → get API key (free tier)
- [ ] **Trainline:** submit the drafted application (add your name/email)
- [ ] **Direct Ferries Connect:** free sign-up + email partnerships team
- [ ] _(optional)_ **Ferryhopper:** ask about MCP server access for fast EU ferry data

I handle: provider scaffolding in the registry, integration, tests, honest
"no data" states. You handle: the account/legal signups above (only you can).

Sources: [Kiwi Tequila](https://tequila.kiwi.com/) ·
[Kiwi×Ryanair partnership](https://en.wikipedia.org/wiki/Kiwi.com) ·
[Direct Ferries Connect](https://www.directferriesconnect.com/) ·
[Ferryhopper partners](https://partners.ferryhopper.com/) ·
[Trainline Partner Solutions](https://tps.thetrainline.com/)
