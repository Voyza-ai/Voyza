# bluemurr.com functional audit

> **Recovered 2026-11-20** from the audit session's history. The report was never
> committed; this is its last saved text. The evidence screenshots it names
> (`docs/audit-evidence/*.png`) are lost and are not in the repo. The fixes are
> on `fix/website-audit-recovered`; its first commit lists which were brought
> over and which dev already covered.

- Desktop 1440×900, Chromium via Playwright, against https://bluemurr.com and the production API, on 2026-11-12/13.
- No DB writes: every POST/PATCH/PUT/DELETE to `/api/trips`, `/api/canvas`, `/api/users`, `/api/bookings`, `/api/notifications`, `/api/email`, `/api/presets/events` and every `*.supabase.co` write was answered locally and never reached the server.
- Signed-in pages used faked Supabase auth, so the backend rejects the token (401). Those flows are marked PARTLY TESTED.
- Evidence (downscaled PNGs) is in `docs/audit-evidence/`.

**Counts:** 2 Blocker · 5 Major · 11 Minor · 6 Cosmetic.

## 1. Landing → /main → three doors — WORKS

- Landing → Get started → `/main` takes 1.6 s. Browse → `/browse`; Describe → `/plan`; View or edit → login when signed out.
- **Cosmetic — landing is blank for about 3 s.** Steps: open bluemurr.com. Expected: headline or button straight away. Actual: dark screen with only a plane animation for about 3 s. Evidence `01-landing.png`.
- **Minor — `/canvas` with no trip id is a bare Next.js 404.** Steps: open bluemurr.com/canvas. Expected: a redirect to My Trips. Actual: "404 This page could not be found". Evidence `03-route-canvas.png`. File: `frontend/app/canvas/` has only `[tripId]`.

## 2. Planner

| Path | Result |
|---|---|
| Know where: 1 city (Rome), 2 cities (Paris+Amsterdam), 4 cities (Rome, Florence, Venice, Milan) | WORKS. The 4-city search took 28.6 s. |
| Chasing a vibe (Beachy from Chicago, with a budget) | WORKS: Cancún, with a "+$500 unlocks…" banner |
| Chasing a vibe, budget **skipped** | **BROKEN** (B2) |
| I know my budget | **BROKEN** (B1) |
| Everything at once ("5 nights in Lisbon and Porto from Boston in March for 2, $3k") | WORKS: 2 turns, then results |
| Typo "Barcelonna", country "Italy" (city picker), duplicate "Paris, Paris", one-way, "Use my location" (Chicago, stubbed) | WORKS |
| "Florence instead of Rome" in the bar; editing "6 nights" inline | WORKS |
| "actually Venice not Venezuela" | Works, but the stale picker stays live (m3) |
| Skip on dates, nights and notes | WORKS |

- **Blocker B1 — "I know my budget" never produces a trip.**
  - Steps: /plan → I know my budget → Set budget → Seattle → One-way → Skip, Skip → Just me → Culture (or Skip) → Skip → Find my trip.
  - Expected: suggested destinations within the budget.
  - Actual: "Sorry, I ran into a problem: Please tell me at least one city or country you want to visit." No API call is made.
  - Evidence: `60-budget-results.png`.
  - File: `frontend/components/planning/PlanningChat.tsx` ~1813–1894. Only `mode === 'vibe'` asks for destinations; the budget path falls through to the "no destinations" error.
- **Blocker B2 — vibe path: skipping budget is a dead end.**
  - Steps: I'm chasing a vibe → Beachy → origin → Round-trip → This summer → Skip nights → 2 → **Skip budget** → Skip notes.
  - Expected: Find my trip, or a budget prompt.
  - Actual: "Almost there — I still need: a budget." There is no budget picker or Find button. Typing "$2000" is stored as a note ("“$2000”" in Trip so far) and the same message repeats.
  - Evidence: `53-vibe-ready.png`, `54-vibe-after-budget-typed.png`.
  - File: `PlanningChat.tsx:170` marks budget `skippable: true`, but validation at `:643` requires it.
- **Minor m3 — the stale country picker stays clickable after a correction.**
  - Steps: "Venezuela" → "actually Venice not Venezuela" → click "Continue with these cities" on the old picker.
  - Actual: posts "Venezuela: Caracas" and "Great choices!", asks "Where are you starting from?" twice, while Trip so far still says Venice.
  - Evidence: `65-venice-correction.png`, `66-venice-then-continue.png`.
- **Minor m4 — past dates are accepted at the date step.**
  - Steps: type "March 10 2024".
  - Expected: rejected on the spot.
  - Actual: accepted, and only rejected after Find my trip with "start date … has already passed".
  - Also: "yesterday" silently becomes Dec 13 2026 with no message.
  - Evidence: `88-past-date.png`, `89-past-date-find.png`.
- **Cosmetic — budget-intent question says "What's your total budget" but defaults to "per person".** Evidence `59-budget-ready.png`.

## 3. Results page — mostly WORKS

- WORKS:
  - Flowchart, Calendar, Schedule and Map tabs.
  - Leg card alternatives: picking $528 over $521 moved the total from $1,355 to $1,362.
  - Hotel arrows update the total ($2,186 = 521 + 1,145 + 520).
  - Total/Per person toggle ($678/person).
  - Activities & Dining panel, city guide, ← → keys.
  - Reload keeps the trip, alternative picks and hotel.
  - Opening `/results` with no trip sends you to `/plan`.
  - "+2 more airports" is a hover tooltip by design.
- **Major M1 — "Adjust trip" after any reload opens a blank planner.**
  - Steps: plan a trip → results → reload (or open in a new tab) → Adjust trip.
  - Expected: the previous answers and conversation.
  - Actual: `/plan?resume=1` shows the empty "What kind of trip…" picker; every answer is lost. It works only if you have not reloaded.
  - Evidence: `72-adjust-after-reload.png` vs `71-adjust-no-reload.png`.
  - File: `PlanningChat.tsx` ~344–395. `guidedSession` is a module variable, so it does not survive a reload.
- **Major M2 — a destination with no route shows a $0 "successful" trip.**
  - Steps: Know where → "Tristan da Cunha" from New York → Find my trip.
  - Expected: "no flights or hotels found" with a next step.
  - Actual: "TOTAL TRIP $0", "No direct option", "STAY No options found", no explanation. The AI also lists made-up dining ("St. Mary's School Canteen").
  - Evidence: `90-noroute.png`. The API returned `outboundLeg:null, hotels:[]`.
- **Minor m6 — the schedule puts all activities in the first days.** Rome, 6 nights: Mar 11–13 are full, Mar 14 and 15 show "0 events". Evidence `21-tab-schedule.png`.
- **Minor m7 — the city guide leaves gaps.** ARRIVE/DEPART times show "—" even though the flight times are known, and "Randomize nearby" and "Open map" are shipped as "COMING SOON". Evidence `24-city-guide.png`.
- **Minor m8 — the default hotel is a campsite.** "hu Roma Camping In Town" is picked for a 2-person Culture trip with $1.5k/person. The next arrow jumps to a $191 hotel, skipping $138 and $161 (not in price order). Evidence `13-results-rome.png`, `16-hotel-next.png`.
- **Cosmetic:**
  - "YOU CAN SAVE $309 vs your original city order" is shown although that saving is already applied (`93-4city-results.png`).
  - The calendar footer says "1 cities" (`20-tab-calendar.png`).
  - On a 1-city trip the Back Home card is off-screen at 1440 px and needs the scroll arrow (`13-results-rome.png`).

## 4. Results AI chat — mostly WORKS

- Every Accept below was checked against the trip itself, total included:

| Request | Result |
|---|---|
| Question "Why start in Amsterdam before Paris?" | WORKS, correct numbers |
| Chip "Give Rome 2 more nights" → Accept | WORKS: Mar 10–18, hotel ×8, new return flight, $1,483 = 521+441+521 |
| "Pin Paris to April 14-18" → Reject | WORKS: "× Dismissed", trip unchanged |
| "I need at least 4 nights in Paris" → Accept | WORKS: $998 → $1,111, sums correctly |
| "Leave Amsterdam for Paris after 2pm" | Applied without asking (m1) |
| "Show me other options for Amsterdam→Paris" | WORKS (kept the cheapest) |
| "Compare flight vs train" | Flight only. Trains are off (known). |
| Add Brussels / Remove Paris / Replace Brussels→Bruges → Accept | WORKS: preview totals match the applied totals ($1,483, $1,243, $1,106) |
| Home-leg requests | Not tested (known, being fixed elsewhere) |

- **Major M3 — a suggested chip asks for something the AI says it can't do.** Clicking the chip "Show me hotel options under €40/night" gets "I don't have a tool to filter or browse alternative hotels". "Make Rome cheaper" offers to "search for a less expensive hotel option", which it also can't do. Evidence `49-chat-hotelchip-a.png`, `50-chat-cheaper-a.png`.
- **Major M4 — the AI shows prices in € or £ while the app is in USD.** Examples: "€52.36/night (€314 total)" for a $52/night hotel; "£44.82 … £41/night vs £132/night"; chip "What's included in the €1060 total?". Evidence `49-chat-hotelchip-a.png`; the £ reply is in the slow-network run.
- **Minor m1 — a time-window request changes the trip without asking.** The reply says "Pick one on the transport card to use it", but the leg had already switched to $147 and the total to $1,100. There was no Accept/Reject and no undo. Evidence `43-chat-timewindow-a.png`.
- **Minor m2 — AI replies show raw `**bold**` asterisks.** Evidence `49-chat-hotelchip-a.png`.
- **Cosmetic — chip "Why is Rome priced at $1,355?" quotes the whole-trip total.**

## 5. Edit in Canvas — PARTLY TESTED (backend rejects fake auth)

- Signed out, it opens a sign-in modal (WORKS, `73-canvas-signedout.png`).
- With faked Google sign-in, it POSTs `/api/trips` (blocked) and lands on `/history` ("Failed to load trips"), because the faked save returned no id. The canvas editor itself was not reached.
- **Minor m12 — the app retries a rejected token nonstop.** When the backend rejects the token, the app re-calls `/api/users/me` and `/api/trips` about 10 times a second. Within a minute this got planner endpoints rate-limited (429), and Activities and chat chips then silently vanished.
  - Seen only under fake auth, but the loop is in the code.
  - File: `frontend/components/shared/Navbar.tsx:33-48`. The effect is keyed on the `user` object; refresh-on-401 in `lib/api.ts` replaces that object, and a failure never sets `avatarUrl`.

## 6. Browse / presets — WORKS

- `/browse` search ("beach and food" → 7 of 11), the `/trips` categories and `/trips/romance-in-europe` all work.
- Preset drawer → "Plan a similar trip" → results (Lisbon → Sintra, $1,060).
- **Major M5 — "Plan a similar trip" silently uses New York as home.** Expected: ask, or use location. Actual: the optimize call sent `origin: "New York", originAirports:["JFK"]` with no prompt. Evidence `80-preset-results.png`.
- **Minor m11 — the preset's own plan is not kept.** The preset says Lisbon 3 nights + Sintra 1; results give 2 + 2 with different hotels, and the Sintra card has no country. Lisbon→Sintra shows "No direct option" (trains are off, known).

## 7. Settings, My Trips, sharing, notifications — PARTLY TESTED (backend rejects fake auth)

- `/history` shows "Failed to load trips"; `/settings` shows "Couldn't load your settings. Try again" (`75-settings-fakeauth.png`). Both are reasonable error states.
- Sharing and notification contents need a real saved trip, so they were not tested.

## 8. In-app booking — PARTLY TESTED (stopped before payment)

- Signed out, it says "Sign in to book this flight."
- Signed in, I faked the `/api/bookings/quote` reply (POST blocked):
  - Flight review → passenger form: empty submit shows field errors (`85-book-travellers-empty-submit.png`).
  - Fare rules: the checkbox gates Continue (`86-book-farerules.png`).
  - Payment: `payment-intent` was blocked and the modal shows "The payment could not be started" (`87-book-payment.png`). Stopped there.
- **Minor m10 — an unexpected quote reply crashes the whole results page.** The page shows "Application error: a client-side exception" (TypeError reading `passengers`) instead of an error in the modal. It was triggered by the audit's blocked reply, but it shows the reply isn't checked (`82-book-fakeauth.png`).

## 9. Errors and edge cases

- No route or no hotel: M2.
- Same city twice: deduplicated silently (WORKS).
- Past dates: m4.
- Slow network (+6 s per API call): the chat shows typing dots and answers (WORKS, `92-slow-chat-pending.png`).
- Very long trip (6+ cities): **NOT TESTED**. It needs more than the ~45/min Duffel searches shared with other sessions. The 4-city trip worked.

## Not tested

- Trips of 6+ cities (Duffel cap).
- Home-leg chat requests (known).
- The canvas editor, sharing, notifications and a real sign-in (backend rejects fake auth).
- Accept on a city date pin (only Reject was tested).

## Open issues

1. **Blocker:** "I know my budget" never builds a trip. (B1)
2. **Blocker:** the vibe path dead-ends if budget is skipped. (B2)
3. **Major:** Adjust trip after a reload opens a blank planner. (M1)
4. **Major:** a destination with no route shows a $0 "trip" with no explanation. (M2)
5. **Major:** an AI chip offers hotel filtering the AI can't do. (M3)
6. **Major:** the AI quotes € or £ for USD prices. (M4)
7. **Major:** "Plan a similar trip" assumes New York as home. (M5)
8. **Minor:** the time-window chat change applies without Accept or undo. (m1)
9. **Minor:** raw markdown asterisks in AI replies. (m2)
10. **Minor:** the stale country picker stays clickable after a correction. (m3)
11. **Minor:** past dates are only rejected after search; "yesterday" becomes next month. (m4)
12. **Minor:** `/canvas` with no id is a bare 404.
13. **Minor:** the schedule leaves the last full days empty. (m6)
14. **Minor:** the city guide shows "—" times and COMING SOON buttons. (m7)
15. **Minor:** a campsite as the default hotel; hotel arrows not in price order. (m8)
16. **Minor:** a bad booking quote crashes the results page. (m10)
17. **Minor:** a preset's night split and hotels are not kept. (m11)
18. **Minor:** a rejected token causes a request storm and rate limits. (m12)
19. **Cosmetic:** landing is blank for 3 s; "YOU CAN SAVE" after already saving; "1 cities"; Back Home card off-screen; whole-trip price in a city chip; "total budget" vs per-person default.
