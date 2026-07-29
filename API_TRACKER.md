# API Tracker

_Update this file every time you send something or hear back: set the date,
flip the status, add a line to the response log at the bottom. Use absolute
dates (2026-07-20), never "last week"._

**Statuses:**   🔲 not started   ·   📝 draft ready   ·   📤 sent, awaiting reply
·   🔁 follow-up sent   ·   ✅ access granted   ·   🔑 key live in `.env`   ·   ❌ parked / rejected

---

## At a glance

| Provider | Status | Sent |
|---|---|---|
| All Aboard | 🔑 **INTEGRATED** — live in searchTrains (test env) | 2026-07-29 |
| Omio | 🔁 follow-up sent | 2026-07-27 |
| Junction | ✅ replied — call scheduling | 2026-07-27 |
| Trainline Partner API | 📤 awaiting reply | _[ask friend]_ |
| Rail Europe | ❌ parked (needs EIN) | — |
| Trainline affiliate | 🔲 not started | — |
| Duffel live token | 🔲 not started | — |
| Kiwi Tequila | 🔁 follow-up sent | 2026-07-27 |
| Booking.com affiliate | 🔲 not started | — |
| Travelpayouts | 📝 draft ready | — |
| Direct Ferries | 📝 draft ready | — |

---

## Rail (data + booking)

### All Aboard  ✅
- **For:** EU rail — SNCF, Renfe, NS, Vy, UK operators. Search + booking.
- **Sent:** 2026-07-13 via the join form (allaboard.eu/join)
- **2026-07-25: co-founder Carl Törnqvist replied** — positive ("multi-leg
  comparison angle is a good fit"), asked for booking volume projections +
  monetization model, and offered sandbox access either way.
- **2026-07-27: reply sent** — volume projection (~200 bookings first months,
  study-abroad students), commission + later subscription model, sandbox ask,
  call offer, BlueMurr rename note (no link yet — v1 not done).
- **2026-07-28: Carl replied** — key correction: **no commissions in rail**.
  All Aboard's revenue is booking fees; API prices are net (parity with
  operator sites). BlueMurr earns by adding its own margin/service fee on
  top. Asked if that still works for our model.
- **2026-07-28: reply sent** — confirmed the model works for us (we set our
  own service fee), asked for a rough booking-fee example for a typical
  one-way ticket, and asked for sandbox access whenever ready.
- **2026-07-29: SANDBOX GRANTED.** Carl's reply, all details:
  - **Booking fee:** standard leisure rate **1% + €2 per completed booking**
    (€25 ticket → €2.25 fee, €60 → €2.60, €150 → €3.50). Nothing upfront,
    no monthly fees; charged retroactively via monthly reconciliation.
  - **Sandbox login:** allaboard.eu/agent with gohil072004@gmail.com —
    passwordless, one-time code per sign-in. **Issue API keys from the
    Dashboard, test-scoped to start.**
  - **Docs:** docs.allaboard.eu · inventory list: docs.allaboard.eu/inventory
  - **Timeline:** a couple of months to build/explore, then a go-live plan
    for real bookings. **Company registration NOT needed to build — only for
    the agreement before go-live** (this is where the EIN lands).
  - Integration call bookable anytime via his link.
- **2026-07-29 (same day): INTEGRATION SHIPPED.** Test-scoped key in
  `backend/.env`; `services/allaboard.ts` registered as a train provider.
  Live-verified: Eurostar Paris→Amsterdam $39.89, Trenitalia Rome→Florence
  from $14.70. First real rail data for FR/IT/ES/Benelux/UK.
- **Next:** exercise it through real trip plans, then book Carl's
  integration call (his link) to review + ask about offer-pricing latency
  (cold getJourneyOffer can exceed 30s; their cache warms after).
- **Model note for pricing later:** displayed rail prices will sit slightly
  above operator sites (their 1% + €2 + our service fee). Keep our fee
  small; the value is one-app multi-leg booking.
- **Note:** best odds of the bunch — developer-first company, public docs.
  First provider breakthrough; prioritize this thread.

### Omio  🔁
- **For:** rail + bus search, 1,000+ operators. Multimodal hedge.
- **Sent:** 2026-07-13 by direct email (their salesportal form was broken;
  said so in the email)
- **2026-07-27:** follow-up sent in the same thread (BlueMurr rename noted).
- **Next:** wait. If still silent past ~2026-08-10, deprioritize — All Aboard
  and Junction cover the same ground.

### Junction  ✅
- **For:** multimodal API (rail + flights). Email-only access.
- **Sent:** 2026-07-13 to deploy@junctionconnect.com
- **2026-07-27:** follow-up sent in the same thread (BlueMurr rename noted).
- **2026-07-27: Hervé Gilg (hg@junctionconnect.com) replied within minutes** —
  wants a call, offered Tue 2026-07-28 or Wed 2026-07-29.
- **2026-07-27:** availability sent — Wed 12–1 pm ET or after 5:30 pm ET,
  both founders attending.
- **2026-07-28 (night):** no confirmation yet — follow-up sent, timed to top
  his morning inbox. New preference: **Friday 2026-07-31, flexible on time**
  (both founders free); Wed 12–1 pm ET kept as backup.
- **Next:** he picks a time → prep sheet before the call, both founders on.
  Prep: volume story (~200 bookings, study-abroad students), commission model,
  what we need (sandbox, EU rail coverage), ask about their pricing/terms.

### Trainline Partner API  📤
- **For:** the long-term ceiling — 270+ operators, 45 countries.
- **Sent:** _[date unknown — ask friend]_ via tps.thetrainline.com/get-in-touch
- **Next:** send the follow-up
  ([draft](RAIL_API_APPLICATIONS.md#5-trainline--follow-up-on-the-existing-application))
  once we know the original date.

### Rail Europe  ❌ parked
- **For:** 200+ operators, most likely to cover Italy.
- **Blocker:** the agency-registration form requires a Federal EIN or business
  document upload — we don't have one yet.
- **Unblock:** get an EIN (free, irs.gov, ~15 min, sole proprietorship works —
  discuss with team). Then submit with the
  [field answers](RAIL_API_APPLICATIONS.md#2-rail-europe--agency-registration-form).

### Trainline affiliate  🔲
- **For:** revenue-tracked rail booking deep-links right now. Much lower bar
  than the Partner API and independent of it.
- **Next:** sign up at thetrainline.com/about-us/partnerships

---

## Flights, hotels, ferries

### Duffel live token  🔲
- **For:** real flight prices — today's token is **sandbox** (fake data).
- **Next:** complete business verification in the Duffel dashboard.
  Same EIN conversation as Rail Europe unblocks this.

### Kiwi Tequila  🔁
- **For:** LCC flights (Ryanair) that Duffel misses.
- **Sent:** 2026-07-16 — emailed affiliates@kiwi.com. Tequila's portal no
  longer offers open self-serve signup (login is magic-link only; the page
  directs new affiliates to that address).
- **2026-07-27:** follow-up sent in the same thread (BlueMurr rename noted).
- **Next:** wait. When the key arrives → Claude integrates it as the second
  flight source (plan step F3). If silent past ~2026-08-10, fall back to
  Travelpayouts for LCC coverage.

### Booking.com affiliate  🔲
- **For:** commission on the hotel links we already show. Biggest easy revenue.
- **Next:** self-serve affiliate signup.

### Travelpayouts  📝
- **For:** hotel + flight affiliate network, one account.
- **Next:** register —
  [answers](APPLICATION_DRAFTS.md#2-travelpayouts-hotels-via-bookingcom--flights)

### Direct Ferries  📝
- **For:** ferries (islands) — affiliate now, Connect API later.
- **Next:** sign up —
  [answers](APPLICATION_DRAFTS.md#3-direct-ferries-ferries--islands)

---

## Keys we already hold

| Provider | For | Where | Status |
|---|---|---|---|
| Duffel (test token) | Flights | `backend/.env` `DUFFEL_ACCESS_TOKEN` | 🔑 works, but **sandbox data** |
| Deutsche Bahn REST | Trains (DACH only) | no key needed | 🔑 live |
| Booking.com (RapidAPI) | Hotels | `backend/.env` `RAPIDAPI_KEY` | 🔑 live — free tier, watch rate limits |
| Anthropic | AI planning/chat | `backend/.env` `ANTHROPIC_API_KEY` | 🔑 live (credits topped up 2026-07-03) |
| Supabase | DB / auth / realtime | `backend/.env` + `frontend/.env.local` | 🔑 live |
| open.er-api.com | Currency FX | no key needed | 🔑 live |

---

## Response log

_Append a line whenever anything happens, newest first._

- 2026-07-29 — **ALL ABOARD SANDBOX GRANTED** (Carl): account live at
  allaboard.eu/agent (email OTP), test-scoped API keys from Dashboard, docs
  at docs.allaboard.eu. Fee: 1% + €2/booking, nothing upfront. ~2 months to
  build, company registration only needed at go-live. First real rail API. 🎉

- 2026-07-28 — **Carl (All Aboard) replied**: no commissions in rail — their
  revenue is booking fees, API prices are net, we earn via our own service
  fee on top. Reply sent same day: model works, asked for a booking-fee
  example + sandbox access. (Also: disregard their duplicate email.)

- 2026-07-27 — **Junction replied minutes after the nudge** (Hervé Gilg,
  hg@junctionconnect.com): wants a call, offered Tue 07-28 or Wed 07-29.

- 2026-07-27 — Follow-up nudges sent to Omio, Junction, and Kiwi (Gohil, same
  threads as the originals). Each mentions the Voyza → BlueMurr rename.

- 2026-07-27 — **All Aboard reply sent** (Gohil, same thread): ~200 bookings
  projected for first months via study-abroad students, commission model +
  possible subscription, sandbox access requested, call offered, BlueMurr
  rename mentioned. Awaiting sandbox credentials.

- 2026-07-25 — **All Aboard replied** (Carl Törnqvist, co-founder): positive fit,
  wants volume projections + monetization model, sandbox access offered.

- 2026-07-16 — Kiwi affiliates emailed (Gohil): Tequila portal no longer has
  open signup, page directs new affiliates to affiliates@kiwi.com.

- 2026-07-13 — Junction inquiry emailed to deploy@junctionconnect.com (Gohil).

- 2026-07-13 — Omio partner inquiry emailed directly (Gohil). Their salesportal
  form wouldn't submit; noted that in the email.

- 2026-07-13 — Rail Europe parked: agent-registration form requires an
  EIN/business document we don't have yet. Unblock = get EIN (sole prop works).

- 2026-07-13 — All Aboard join form submitted (Gohil).

- _[date]_ — Trainline partner inquiry submitted (friend). No response as of
  2026-07-13.
