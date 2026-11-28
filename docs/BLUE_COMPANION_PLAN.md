# Blue — the proactive trip companion (plan)

Status: PLAN ONLY, written 2026-11-28 on `feat/imessage-bot`. Nothing here is built
beyond what's listed as "exists". Texting work is paused; this is the design for
when it resumes.

## 1. What Blue is

Blue is BlueMurr's travel companion in your text thread (1:1 or the trip's group
chat). Like Meta's Muse or Claude Duet, but for one trip. **The differentiator is
that Blue texts first** when something matters (leave now, price dropped, rain
tomorrow, train not booked, you're missing an adapter), and acts only after a
YES.

## 2. Rules Blue never breaks

- **Useful or silent.** A nudge budget per thread (default 3/day while
  travelling, 1/day before the trip), quiet hours 21:00–08:00 *in the trip
  city's time zone*, and `Blue mute` / `Blue mute 2h` / `STOP` honoured instantly.
- **Never acts without YES.** Bookings, purchases and trip changes are
  proposed. Payment always happens on a website, never in a text.
- **Trip members only.** No trip details while any number in the thread isn't
  verified to the trip (already built).
- **No made-up facts.** Times, prices and places come from searched data. The AI
  only words the message and picks between real options (same rule as the web
  chat, D-07).
- **Cheap by design.** Deciding *whether* to nudge is plain code. The AI is
  called only to word a nudge that's going out, or to answer a question.

## 3. What Blue does

Legend: **Exists** = built on this branch or in the app · **Reuse** = app code
to adapt · **New** = to build · **Link** = Blue sends a prefilled link, because no
open API lets a startup book.

### 3a. Speaks first (proactive nudges) — the core

| Nudge | Trigger (plain code) | Data source | Status |
|---|---|---|---|
| Morning brief | 08:00 local, each travel day | trip schedule + weather | New (schedule exists in `cities.schedule`) |
| Leave now | X min before an `in-head`/`out-head` schedule event (flight 120 / train 30 min buffers) | `frontend/lib/dayScheduleDefaults.ts` rules, moved/mirrored to backend | Reuse (needs per-city time zone) |
| Price drop on a chosen flight/train | re-search 2×/day; same service (`sameService`) cheaper by ≥ $20 and ≥ 5% | `tripLegs.searchLeg` + `sameService` (fix/ai-chat-home-legs) | Reuse |
| Weather swap | rain/heat on a day with outdoor items | weather API | New |
| Unbooked leg | leg has no booking, departure ≤ 14 days away, prices rising | trip legs + bookings table | Reuse |
| Packing gap | 3 days and 1 day before departure, items still unchecked | packing list (3b) | New |
| Check-in reminder | 24h before a booked flight | Duffel order | Reuse |
| Delay / schedule change | airline change on a Duffel-booked flight | Duffel `order.airline_initiated_change_detected` webhook | New (booked-in-app only; others need paid AeroAPI) |

### 3b. Answers and helps when asked

| Ask | How | Status |
|---|---|---|
| "What time's our flight home?" / "Where are we staying?" | the web chat through the one seam (`runTripChat`) | Exists, tested live |
| "Find us a later flight" / "add a night in London" | chat proposal → YES → saved to the trip | Proposal exists; **saving is New** (applier + version check) |
| "What should I pack?" | list built from weather × activities × flights/luggage × country (plugs, visas); checklist kept per traveller; "got a water bottle?" | New |
| "Book me dinner" | 2–3 options (near hotel, open then, cuisine/budget) → YES → **Link** to OpenTable/Resy with party size and time filled in | New (Google Places Nearby + link) |
| "Can you get me a water bottle?" (before trip) | product search → **Link** (affiliate/Amazon search link), note if it arrives before departure | New (Link) |
| "…find one nearby" (on the trip) | nearest open shop + walk time + map link | New (Google Places Nearby, open-now) + `places/travel.ts` walk times |
| "Book that flight" | link to the in-app Booking modal for that leg | New (deep link; the modal exists) |
| Group decisions | "Florence or Naples? Reply 1 or 2" → tallies → proposal | New |
| Who owes who | running split of costs logged in the thread | New (later) |

## 4. What isn't open to us (and the fallback)

- **Restaurant booking:** OpenTable, Resy, Tock and SevenRooms are partner-only,
  and Reserve with Google is for booking platforms → **Link** now, apply to a
  partner program later.
- **Buying products:** Amazon's API needs an Associates account with 10 sales in
  the last 30 days and can't place orders → **affiliate/search Link**.
- **Delay alerts for flights not booked in-app:** need paid FlightAware AeroAPI
  polling; Trenitalia has no official realtime feed → start with Duffel-booked
  flights only.
- **iMessage first-contact:** Sendblue's AI Agent plan is inbound-first and
  can't create groups. Texting first needs the contact-sales "Blue Ocean" plan,
  or the group must text Blue first. iOS 26 may file unknown senders as spam,
  so **the user texts Blue first** (the link code does this naturally).
- **SMS:** a Twilio trial can't send free-form text; needs a paid account +
  A2P 10DLC (about 5 business days) and STOP handling.
- **Weather:** Open-Meteo's free tier is non-commercial → its paid plan or
  OpenWeather (1,000 free calls/day).

## 5. How the proactive engine works

```
every 15 min (one worker):
  for each linked thread with an active trip:
     run cheap checks  →  candidate nudges  (no AI)
     drop: already sent (ledger key), quiet hours, muted, over budget
     rank: urgency (leave-now > delay > price drop > weather > packing > brief)
     word the top one (small model, ~3k tokens) → send → write ledger
watchers (separate cadence): price re-search 2×/day per leg; weather 1×/day per city
```

- **Ledger** (`blue_nudges`): one row per (thread, nudge key such as
  `leave:flight:home→Venice:2027-05-15`), so a restart or re-run never sends
  twice (same idea as `emailJobs.ts`'s "sent" marks).
- **Time zones:** schedule times are local "HH:MM" with no zone → add a zone per
  city (from coordinates) before any time-based nudge.
- **Scheduler:** one long-running worker on `setInterval`, plus a
  `CRON_SECRET`-guarded "run now" route (pattern from `routes/email.ts`). pg_cron
  calls are fire-and-forget, so only as a backup kick.
- **Replies to nudges** go through the existing bot (YES/NO, pending edit).

## 6. Data (new tables, as migration files + dry runs; nothing applied without OK)

Already written (016, not applied): `user_phones`, `text_threads`, `text_link_codes`.
New later:
- `blue_nudges`: ledger of what was sent, to whom, and when.
- `blue_watches`: price/weather watches per leg and city, with last value.
- `blue_prefs` (or a `user_profiles.preferences` key): mute, quiet hours, budget.
- `packing_items`: per trip and traveller, with a checked flag.

## 7. Phases

| Phase | Ships | Needs |
|---|---|---|
| **P0 Foundation** | live texting, migration 016, saving YES edits (applier + version check), "threads for a trip" | provider account, DB OK |
| **P1 Proactive MVP** | morning brief, leave-now, unbooked leg, packing list + gaps, mute/quiet hours, ledger | time zones per city, weather API |
| **P2 Watchers + help** | price-drop alerts, nearby open-now shop, dinner options + booking links, buy links, booking deep link | Google Places key |
| **P3 Bigger bets** | delay alerts, group polls, cost split, real reservations (partner), in-thread purchase | partner approvals, AeroAPI |

## 8. Testing (owner rule: minimal AI calls)

- Every nudge rule is plain code, so it's tested with a **fake clock + simulator +
  stubbed chat** (no AI): "at 08:50 local on 15 May the leave-now nudge fires
  once, not twice, not in quiet hours, not when muted".
- Live checks are counted and reported: wording only, a handful of calls.
- The owner's real end-to-end demo: a test trip and real texts to their phone.

## 9. Cost (estimate, list prices checked 2026-11-28)

Assumes per trip: 4 travellers, 10 days, ~40 nudges, ~150 questions.
Prototype = 10 trips/month; demo = 100 trips/month.

| | Prototype / month | Demo / month | Setup (one-off) |
|---|---|---|---|
| **A. Twilio SMS/MMS** | **$110–340** | **$1,060–3,170** | ~$45–90 (10DLC + top-up) |
| **B. Sendblue iMessage** | **$110–160** | **$230–940** | ~$105 (first month) |

What drives it:
- **Texting is most of the bill on Twilio.** Group MMS is billed per recipient
  (~3¢ each, carrier fees included; ESTIMATE). Answering 1:1 instead of in the
  group cuts it by about two-thirds. Above ~30 group texts per trip, Sendblue's
  flat $100 line is cheaper.
- **AI is small.** Answers on Sonnet 5.5: $10–24/month at prototype scale
  ($0.0065–0.016 per answer; prompt caching saves ~60%). Nudge wording on Haiku
  5.5: under $2/month. Opus 5.5 for answers would be ~$48/month.
- **Duffel price watching:** ~$2–20/month worst case (excess-search fee).
- **Weather:** $0 to test, ~$29/month for commercial Open-Meteo (ESTIMATE).
- **Google Places:** $0 at prototype scale (free monthly calls); up to
  ~$140/month at demo scale if opening hours are requested.
- **Worker hosting:** $0–7/month.
- **Optional delay alerts** (FlightAware AeroAPI): +$100/month minimum.
- **Not yet confirmed:**
  - Sendblue's plan for texting first and for groups ("Blue Ocean" or
    Enterprise; ask sales; ESTIMATE $300–500/month).
  - Twilio's per-recipient group billing.
  - Open-Meteo's $29 price.

Sources: [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) ·
[Twilio US SMS](https://www.twilio.com/en-us/sms/pricing/us) ·
[Twilio 10DLC vetting](https://support.twilio.com/hc/en-us/articles/11587910480155-A2P-10DLC-Campaign-Vetting-FAQ) ·
[Sendblue pricing](https://www.sendblue.com/pricing) · [Sendblue limits](https://docs.sendblue.com/limits) ·
[Duffel pricing](https://duffel.com/pricing) · [Open-Meteo pricing](https://open-meteo.com/en/pricing) ·
[Google Maps pricing](https://developers.google.com/maps/billing-and-pricing/pricing) ·
[AeroAPI](https://www.flightaware.com/commercial/aeroapi/)

## 10. Open decisions for the owner

1. Provider: Sendblue (iMessage, $100/mo; Blue Ocean needed to text first) or Twilio paid SMS.
2. Nudge budget and quiet hours defaults (3/day, 21:00–08:00?).
3. P1 order: which nudges first?
4. Weather and Google Places keys (paid tiers).
