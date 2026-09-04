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
| All Aboard | ✅ in conversation — sandbox offered | 2026-07-13 |
| Omio | 📤 awaiting reply | 2026-07-13 |
| Junction | 📤 awaiting reply | 2026-07-13 |
| Trainline Partner API | 📤 awaiting reply | _[ask friend]_ |
| Rail Europe | ❌ parked (needs EIN) | — |
| Trainline affiliate | 🔲 not started | — |
| Duffel live token | 🔲 not started | — |
| Kiwi Tequila | 📤 awaiting reply | 2026-07-16 |
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
- **Next:** send the drafted reply (honest pre-revenue numbers, commission
  model, sandbox ask, BlueMurr rebrand note) from carl's thread. Then wire
  sandbox key into `.env` when it arrives.
- **Note:** best odds of the bunch — developer-first company, public docs.
  First provider breakthrough; prioritize this thread.

### Omio  📤
- **For:** rail + bus search, 1,000+ operators. Multimodal hedge.
- **Sent:** 2026-07-13 by direct email (their salesportal form was broken;
  said so in the email)
- **Next:** wait. Nudge after ~2026-07-20 if silent.

### Junction  📤
- **For:** multimodal API (rail + flights). Email-only access.
- **Sent:** 2026-07-13 to deploy@junctionconnect.com
- **Next:** wait. Nudge after ~2026-07-20 if silent.

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

### Kiwi Tequila  📤
- **For:** LCC flights (Ryanair) that Duffel misses.
- **Sent:** 2026-07-16 — emailed affiliates@kiwi.com. Tequila's portal no
  longer offers open self-serve signup (login is magic-link only; the page
  directs new affiliates to that address).
- **Next:** wait; nudge after ~2026-07-23 if silent. When the key arrives →
  Claude integrates it as the second flight source (plan step F3).

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

- 2026-07-16 — Kiwi affiliates emailed (Gohil): Tequila portal no longer has
  open signup, page directs new affiliates to affiliates@kiwi.com.

- 2026-07-13 — Junction inquiry emailed to deploy@junctionconnect.com (Gohil).

- 2026-07-13 — Omio partner inquiry emailed directly (Gohil). Their salesportal
  form wouldn't submit; noted that in the email.

- 2026-07-13 — Rail Europe parked: agent-registration form requires an
  EIN/business document we don't have yet. Unblock = get EIN (sole prop works).

- 2026-07-13 — All Aboard join form submitted (Gohil).

- 2026-07-25 — **All Aboard replied** (Carl Törnqvist, co-founder): positive fit,
  wants volume projections + monetization model, sandbox access offered.
  Reply drafted; sending once bluemurr.com is live (done 2026-07-26).

- _[date]_ — Trainline partner inquiry submitted (friend). No response as of
  2026-07-13.
