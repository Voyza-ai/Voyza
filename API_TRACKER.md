# API Tracker — applications, outreach, and keys

_One row per provider. Update this file every time you send something or hear
back: set the date, flip the status, and note the next action. Use absolute
dates (2026-07-20), never "last week"._

**Statuses:** 🔲 not started · 📝 draft ready · 📤 applied / emailed — awaiting reply
· 🔁 follow-up sent · ✅ access granted · 🔑 key live in `.env` · ❌ rejected / parked

---

## Applications & outreach

| Provider | For | How to apply | Date sent | Status | Next action |
|---|---|---|---|---|---|
| **All Aboard** | EU rail (SNCF, Renfe, NS, UK) — data + booking | Form: allaboard.eu/join · backup tech@allaboard.eu | 2026-07-13 | 📤 form submitted | Await reply; nudge via email after ~1 week of silence ([draft](RAIL_API_APPLICATIONS.md#1-all-aboard--signup-form--email-best-bet)) |
| **Trainline Partner API** | EU rail — the long-term ceiling (270+ operators) | Form: tps.thetrainline.com/get-in-touch ([draft](TRAINLINE_APPLICATION.md)) | _[date — ask friend]_ | 📤 submitted, no response | Send follow-up ([draft](RAIL_API_APPLICATIONS.md#5-trainline--follow-up-on-the-existing-application)) |
| **Trainline affiliate** | Rail booking deep-links + commission now | thetrainline.com/about-us/partnerships | — | 🔲 | Sign up (low bar, independent of the API application) |
| **Rail Europe** | EU rail incl. Italy — 200+ operators | Form: agent.raileurope.com/agency-registration | — | ❌ parked — form requires a Federal EIN / business doc upload | Get an EIN (free, irs.gov, ~15 min — discuss with team), then submit ([field answers](RAIL_API_APPLICATIONS.md#2-rail-europe--agency-registration-form)) |
| **Omio Partner** | Rail + bus, 1,000+ operators (hedge) | Emailed directly (salesportal form was broken) | 2026-07-13 | 📤 emailed — awaiting reply | Nudge after ~1 week of silence |
| **Junction** | Multimodal rail/flights (email-only) | deploy@junctionconnect.com | 2026-07-13 | 📤 emailed — awaiting reply | Nudge after ~1 week of silence |
| **Duffel — LIVE token** | Real flight prices (today = sandbox data) | Verify business in Duffel dashboard | — | 🔲 | Complete verification — top data-layer priority ([plan](API_PROVIDERS.md)) |
| **Kiwi Tequila** | LCC flights (Ryanair) | Self-serve: tequila.kiwi.com | — | 📝 draft ready | Register ([answers](APPLICATION_DRAFTS.md#1-kiwicom-tequila-flights--lccryanair)) |
| **Booking.com affiliate** | Hotel revenue on existing links | Self-serve affiliate signup | — | 🔲 | Sign up — biggest easy revenue ([plan](API_PROVIDERS.md)) |
| **Travelpayouts** | Hotel + flight affiliate network | Self-serve: travelpayouts.com | — | 📝 draft ready | Register ([answers](APPLICATION_DRAFTS.md#2-travelpayouts-hotels-via-bookingcom--flights)) |
| **Direct Ferries** | Ferries — affiliate now, Connect API later | Affiliate signup + Connect application | — | 📝 draft ready | Sign up ([answers](APPLICATION_DRAFTS.md#3-direct-ferries-ferries--islands)) |

## Keys we already hold

| Provider | For | Where | Status |
|---|---|---|---|
| Duffel (test token) | Flights | `backend/.env` `DUFFEL_ACCESS_TOKEN` | 🔑 works, but **sandbox data** — see live-token row above |
| Deutsche Bahn REST | Trains (DACH only) | No key needed | 🔑 live |
| Booking.com via RapidAPI | Hotels | `backend/.env` `RAPIDAPI_KEY` | 🔑 live (free tier — watch rate limits) |
| Anthropic | AI planning/chat | `backend/.env` `ANTHROPIC_API_KEY` | 🔑 live (credits topped up 2026-07-03) |
| Supabase | DB / auth / realtime | `backend/.env` + `frontend/.env.local` | 🔑 live |
| open.er-api.com | Currency FX | No key needed | 🔑 live |

## Response log

_Append a line whenever anything happens, newest first._

- 2026-07-13 — Junction inquiry emailed to deploy@junctionconnect.com (Gohil).
- 2026-07-13 — Omio partner inquiry emailed directly (Gohil). Their salesportal
  form wouldn't submit; noted that in the email.
- 2026-07-13 — Rail Europe parked: agent-registration form requires an EIN/business
  document we don't have yet. Unblock = get EIN (sole prop works, no LLC needed).
- 2026-07-13 — All Aboard join form submitted (Gohil).
- _[date]_ — Trainline partner inquiry submitted (friend). No response as of 2026-07-13.
