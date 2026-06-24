# Application Drafts — Kiwi, Travelpayouts, Direct Ferries

_Copy-paste answers for the signups in [SIGNUP_GUIDE.md](SIGNUP_GUIDE.md).
Trainline's draft lives separately in [TRAINLINE_APPLICATION.md](TRAINLINE_APPLICATION.md)._

> Exact field labels vary by site and change over time. These answers map to the
> fields you'll typically see — match them up, and ping me if a form asks for
> something not covered here. `[your …]` = fill in your own.

---

## Reusable building blocks (every form asks for some of these)

**Project / company name:** `Voyza`

**Website URL:** `https://voyza-nine.vercel.app`

**One-liner:**
> Voyza is an AI-powered trip planner that finds the cheapest way to travel by comparing flights and trains (and soon ferries) across a whole multi-city route.

**Two-sentence description:**
> Voyza is an AI multi-modal trip planner. We optimize multi-city itineraries across flights, trains and ferries — comparing real door-to-door time and price on every leg — and send travelers to partner sites to book.

**Category / vertical:** Travel — flights, hotels, trains, ferries (metasearch / trip planning)

**Business / monetization model:** Affiliate deep-links now (we send users to partner sites to book); in-app booking coming soon.

**Markets:** Europe-first, expanding globally.

**Promotion method / traffic source:** Our own web app — an AI trip planner that surfaces options and deep-links users to the partner to book.

**Stage (be honest):** Early-stage / pre-launch; growing.

---

## 1. Kiwi.com Tequila (flights — LCC/Ryanair)

**Register** at tequila.kiwi.com, then **create a Solution.** The key choice is the
**Solution type** — pick the search/affiliate one, NOT booking.

| Field | Answer |
|---|---|
| Name | `[your name]` |
| Work email | `[your email]` |
| Company | `Voyza` |
| Solution name | `Voyza` |
| **Solution type** | **Affiliate / Metasearch** (search + redirect to Kiwi — free). ❌ *Not* "Booking" (that needs a deposit + makes you merchant-of-record; only for in-app booking later) |
| Website | `https://voyza-nine.vercel.app` |
| Description | _One-liner above_ |
| Expected market / region | Europe (expanding globally) |

➡️ **Grab:** the **API key** (a.k.a. `kw-…` token). 🔒 → I'll add it as a new env var.

---

## 2. Travelpayouts (hotels via Booking.com + flights)

**Sign up** at travelpayouts.com, **add Voyza as a project**, then **activate
programs** (Booking.com, Hotellook, and a flights program like Aviasales/WayAway).

### Account / project
| Field | Answer |
|---|---|
| Name / email | `[your name]` / `[your email]` |
| Project name | `Voyza` |
| Project URL | `https://voyza-nine.vercel.app` |
| Project type | Website / Web app |
| Category | Travel (flights & hotels) |
| Description | _Two-sentence description above_ |
| Monthly audience | _Be honest — early-stage / low; pick the lowest tier_ |
| Traffic source | Own website / app |
| Promotion tools | Deep links / API |

### Programs to activate (in the dashboard after signup)
- ✅ **Booking.com** (hotels) — the priority; this is the hotel-revenue switch
- ✅ **Hotellook** (hotel metasearch — backup hotel coverage)
- ✅ **Aviasales** or **WayAway** (flights affiliate)

➡️ **Grab:** your **marker** (Travelpayouts' affiliate ID) + the **Booking.com
deep-link format** they give you. 🔒 → I wire the marker into the hotel "Book"
URL in [hotels.ts](backend/src/services/hotels.ts).

---

## 3. Direct Ferries (ferries — islands)

Two things: **affiliate signup** (revenue now) + **Connect API email** (data/booking later).

### Affiliate signup
(at the Direct Ferries affiliate partner page, linked from directferries.com/affiliate.htm)

| Field | Answer |
|---|---|
| Name / email | `[your name]` / `[your email]` |
| Company | `Voyza` |
| Website | `https://voyza-nine.vercel.app` |
| Country | `[your country]` |
| How will you promote? | _One-liner above_ + "We integrate ferry options into multi-modal trip itineraries and deep-link travelers to Direct Ferries to book." |
| Markets / regions | Europe (Balearics, Greece, Italy, Croatia, Portugal) |

➡️ **Grab:** your **affiliate link / ID.** → I wire it into ferry "Book" links.

### Connect API (data + booking — start now, lands later)
Email **partnerships@directferries.com**. Copy-paste:

> Subject: API partnership inquiry — Voyza (AI multi-modal trip planner)
>
> Hi Direct Ferries Connect team,
>
> I'm building Voyza, an AI-powered multi-modal trip planner that optimizes
> itineraries across flights, trains and ferries and sends travelers to partners
> to book. Ferries are essential to our European coverage (Balearics, Greek
> islands, Sardinia/Sicily, Croatia), and your Connect API looks like the right
> fit for live schedules + prices, with booking to follow.
>
> We're early-stage and consumer-facing. Could we discuss API access and the best
> entry point (affiliate vs. API) for a fast-growing trip planner?
>
> Thanks!
> [your name], Voyza — https://voyza-nine.vercel.app

_(Optional: also ping **Ferryhopper** about their MCP server — a fast path to
live Mediterranean ferry data.)_

---

## What to hand back to me

| From | Item | I do |
|---|---|---|
| Kiwi | 🔒 API key | Add Kiwi flight provider to the registry |
| Travelpayouts | 🔒 marker + Booking deep-link format | Wire hotel revenue in `hotels.ts` |
| Direct Ferries | affiliate link/ID | Wire ferry "Book" links |

You don't need all at once — **Travelpayouts (Booking) + Duffel live** first gets
you real flights + real hotel revenue, the biggest jump.
