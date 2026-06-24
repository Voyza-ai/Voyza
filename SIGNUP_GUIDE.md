# API Signup Guide — step by step

_For Satwik. Do these in order; each says exactly what you'll be asked and what
to grab at the end. Paste the keys/IDs back to me (or into `backend/.env`) and I
wire them in. Anything marked 🔒 is a credential — put it in `.env`, never commit._

> Exact dashboard labels may shift slightly; the flow is what matters. If a screen
> doesn't match, tell me what you see.

---

## 1. Duffel — LIVE token (real flights + booking-soon foundation)

**Why:** current token is `duffel_test_…` → flights are fake. Live = real data.

1. Go to **app.duffel.com** → log in (or sign up) with the account that owns the
   current test token.
2. Find the environment toggle (usually top bar) — switch from **Test → Live**.
3. Duffel will prompt you to **activate live mode**: fill in business details
   (company name, what you're building, contact). With **Duffel Content** you can
   sell flights without airline accreditation — choose that if asked.
4. You may need to accept terms + add a payment method (you're billed per booking,
   not for search).
5. Once live mode is active: **Settings → Access tokens → create a Live token.**
6. 🔒 Grab the token starting `duffel_live_…` → that replaces
   `DUFFEL_ACCESS_TOKEN` in `.env`.

**Time:** ~15–30 min. Mostly self-serve.

---

## 2. Booking.com revenue — via Travelpayouts (fastest hotel money)

**Why:** you already show Booking hotels but link with no affiliate → $0. This
turns every hotel click into commission. Travelpayouts is faster to get approved
than Booking direct, and bundles flights too.

1. Go to **travelpayouts.com** → sign up as a partner/affiliate.
2. Add Voyza as your "website/project" (URL + short description: "AI multi-modal
   trip planner"). Approval is usually quick.
3. In the dashboard, activate the **Booking.com** program (and **Hotellook**).
   Also activate a **flights** program (Aviasales / WayAway) while you're there.
4. 🔒 Find your **marker / affiliate ID** (Travelpayouts calls it a `marker`).
   Grab it.
5. Note the **deep-link format** they give for Booking.com — I'll use it to build
   the hotel "Book" URL.

**Alt (slower, sometimes higher payout):** Booking.com's own Affiliate Partner
Programme at **booking.com** → "Affiliate" → apply. They review your site; gives
an `aid=` parameter. Use this later if you outgrow Travelpayouts.

**Time:** ~20 min + approval wait.

---

## 3. Kiwi.com Tequila — LCC / Ryanair flight data

**Why:** Duffel misses Ryanair (Europe's #1, often cheapest). Kiwi has it.

1. Go to **tequila.kiwi.com** → register.
2. Create a **Solution** → choose the **Affiliate/Search** type (free; returns
   prices + redirect links). *Not* the Booking solution (that needs a deposit —
   only for in-app booking later).
3. 🔒 Grab the **API key** it issues.

**Time:** ~15 min. Self-serve.

---

## 4. Trainline — affiliate now + Partner API application

**Why:** real European train fares + commission. Affiliate = revenue now;
Partner API = booking later (long lead, start now).

- **Affiliate (do now):** go to **thetrainline.com/about-us/partnerships** →
  follow the affiliate-programme link (runs through an affiliate network). Sign up,
  grab your affiliate link/ID.
- **Partner API (start now, lands later):** submit the form at
  **tps.thetrainline.com/get-in-touch/** using the answers I already drafted in
  [TRAINLINE_APPLICATION.md](TRAINLINE_APPLICATION.md) — just add your name/email.

**Time:** ~20 min total.

---

## 5. Direct Ferries — affiliate now + Connect API later

**Why:** islands (Ibiza, Greece, Sardinia, Croatia). Affiliate = revenue now;
Connect API = data/booking later.

- **Affiliate (do now):** sign up at the Direct Ferries affiliate partner page
  (linked from **directferries.com/affiliate.htm**). Grab your affiliate link/ID.
- **Connect API (start now):** email **partnerships@directferries.com** — say
  you're an AI multi-modal trip planner wanting their ferry GDS API for live
  prices + booking. (Optional: also ping **Ferryhopper** about their MCP server —
  could be a fast Mediterranean data path.)

**Time:** ~15 min.

---

## What to hand back to me

| Item | Goes where | Unlocks |
|---|---|---|
| 🔒 `duffel_live_…` token | `.env` → `DUFFEL_ACCESS_TOKEN` | Real flight data |
| 🔒 Travelpayouts `marker` + Booking deep-link format | `.env` + I wire `hotels.ts` | Hotel revenue |
| 🔒 Kiwi Tequila API key | `.env` (new var) | Ryanair / LCC flights |
| Trainline affiliate link/ID | I wire train "Book" links | Rail revenue |
| Direct Ferries affiliate link/ID | I wire ferry "Book" links | Ferry revenue |

As each arrives, I plug it into the provider registry. You don't have to get them
all at once — Duffel live + Travelpayouts(Booking) first gets you real flights +
real hotel revenue, which is the biggest jump.
