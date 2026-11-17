# BlueMurr mobile app — plan & prototype

Branch `feat/mobile-app-prototype`. Demo: `/m/demo` (no backend needed). Real app: `/m`.

## Approach

- **Mobile-first web app inside the existing Next.js frontend**, under `/m`, installable as a PWA
  (`public/m/manifest.webmanifest`, start URL `/m`, standalone, icons in `public/m/icons`).
- **Same functionality by construction:** the mobile screens call the *same* code as the desktop.
  Logic that lived inside desktop components was moved, verbatim, into hooks both sides use:
  - `components/results/useResultsController.tsx` — everything `/results` did (load a saved trip, re-pricing,
    home-flight backfill, add / move / remove city, nights, home edits, autosave, leave guard, collaboration, share-link joins).
  - `components/results/useResultsHeader.tsx` — save, share, rename, totals, per-person toggle, ways to save, date-shift replan.
  - `components/planning/useConversationalPlanner.tsx` — the `/api/plan/converse` conversation.
  - `PlanningChat` takes `variant="mobile"` (same search pipeline, lands on `/m/trip`).
  - `AIChatPanel` takes `appearance="sheet"` (same chat, dark #0f0f1a surface).
  - `CityDetailPanel` / `ActivitiesDetailPanel` take `compact` (narrow layout for the city sheet).
  - Desktop defaults are unchanged; all existing web tests pass.
- **Later option:** wrap `/m` in Capacitor for App Store / Play builds (push notifications, native share).
  React Native / Expo is not recommended: it would re-implement every feature.

## Screens & navigation

Bottom tab bar (app level): **Explore · My trips · ＋Plan · Account**. The trip is a pushed screen with a back arrow.

| Screen | Route | What's on it |
|---|---|---|
| Home / Explore | `/m` | "Where to?" → planner with that sentence; starter chips; curated trips (presets) as pastel cards → preview sheet → open; popular traveller trips → copy |
| Plan | `/m/plan` | Full-screen AI conversation; running summary chips (tap to edit); quick replies + "Use my location" + "Pick dates" above the keyboard; **sheets** for city picker, vibes, budget, dates; recap + Find my trip |
| Trip | `/m/trip` (`?tripId=` for saved) | Header: name (rename), dates, travellers, total (tap: total ↔ per person), savings → Ways-to-save sheet, Save, Share. **Segmented control: Itinerary · Calendar · Schedule · Map**. Floating dark **Ask BlueMurr AI** button |
| Itinerary tab | | Vertical flowchart: home card → pastel city cards → home card, dashed route running down, transport pill on each leg; nights − / +; add city |
| City sheet | | Tap a city: Stay & hotels / Things to do (the desktop panels, compact); move earlier / later; remove |
| Leg sheet | | Tap a leg: times, stations, duration, stops, price; Book (in-app Duffel for flights, operator link otherwise); other options → swap |
| AI chat sheet | | Same chat, suggestion chips, proposal cards with Accept / Reject; stays mounted when closed |
| My trips | `/m/trips` | Own + shared trips, open, delete (confirm sheet), sign-in prompt |
| Account | `/m/account` | Sign in / out; links to settings, desktop site, demo |
| Demo | `/m/demo` | A recorded sample trip; the app's `/api` calls answered from fixtures in the browser |

**Why a segmented control (not bottom tabs) for the trip views:** the bottom of the screen already holds the
app tab bar's job and the AI button; the four views are siblings of one trip, so a top segmented control keeps
them one tap apart without a second bottom bar.

## Feature inventory → mobile

✅ built · ♻️ desktop component reused inside the mobile screen · ⏳ deferred (works via the desktop page)

| Web feature | Mobile |
|---|---|
| Landing `/`, hub `/main` | ✅ Home `/m` replaces both |
| Planner: AI conversation, where-from, round-trip vs one-way, recap, Find my trip | ✅ |
| Planner: city picker / vibe pills / budget / dates | ✅ sheets (vibe & budget pickers ♻️) |
| Planner: use my location, summary edits, retry on failure, guided fallback | ✅ (guided fallback opens the desktop guided layout ⏳) |
| Planner: mode picker (place / vibe / budget guided flows) | ⏳ mobile is conversation-first; the AI covers all three |
| Planner leave guard, one-click date-shift replan (autorun), Adjust trip (`?resume=1`) | ✅ |
| Results: flowchart, city cards, connectors, alternatives swap | ✅ vertical itinerary + leg sheet |
| Results: hotel list / cycle / custom hotel, activities & restaurants edit | ♻️ city sheet panels |
| Results: nights stepper, reorder, remove, add city, home edit | ✅ (add-city & home-edit dialogs ♻️) |
| Results: calendar / schedule (day planner) / map | ♻️ tabs |
| Results: banners (over budget, no rail data, vibe tier-up, origin clarification) | ♻️ |
| Header: rename, totals, per-person, ways to save, date-shift, save, share | ✅ |
| Booking (Duffel quote → passengers → payment → confirmation) | ♻️ from the leg sheet |
| BlueMurr AI chat (date shift, city edit, transport change, mode comparison, leg refresh) | ♻️ dark sheet |
| Collaboration: roles, view-only, propose / discard / save a copy, suggestions panel, toasts, access gate, share dialog | ✅ / ♻️ |
| Collaboration: live cursors | ⏳ not shown on touch (no pointer) |
| Suggested-cities pull-out panel | ⏳ use Add a city or ask the AI |
| Leave-without-saving guard, autosave of saved trips | ✅ same hooks |
| Browse `/browse` (presets) | ✅ Home "Trips to steal"; search & filters ⏳ |
| Explore `/explore` (public trips, clone) | ✅ Home "Popular with travellers"; full list ⏳ |
| History `/history` | ✅ My trips; "share to Explore" toggle ⏳ |
| Settings (profile, account, privacy, notifications, delete account) | ⏳ Account links to `/settings` |
| Auth pages, Google sign-in | ♻️ LoginModal |
| Notifications bell | ⏳ |
| SEO pages `/trips/*` | n/a (web only) |

## Open questions

- Native shell (Capacitor) now, or after the web prototype settles?
- Should phones visiting `/` be redirected to `/m` (not done — desktop untouched)?
- Mode picker on mobile: keep conversation-only, or add the three guided flows?
- Hotel photos / maps inside the city sheet — the desktop panel has none either.
