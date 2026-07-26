# Transport Data Game Plan — flights + trains

_Written 2026-07-16. Companion to [API_TRACKER.md](API_TRACKER.md) (live statuses)
and [API_PROVIDERS.md](API_PROVIDERS.md) (provider research). This is the
execution plan: what happens, in what order, and who does it._

## Ground rules (settled)

- **No scraping.** Legal risk in the EU (Ryanair precedents, database rights),
  it would burn the exact partnerships we're applying for, and scraped prices
  go stale in minutes — fake data wearing a costume.
- **No fabrication.** A leg with no real data says so honestly in the UI.
- **Every provider is an adapter** behind `searchLegOptions`/`compareLeg`.
  The optimizer never knows which source won, so adding or swapping providers
  never means a rewrite.

---

## ✈️ Flights — finish this week (self-serve, no gatekeepers)

| # | Step | Who | Effort |
|---|---|---|---|
| F1 | **Duffel live token** — complete business verification in the Duffel dashboard. Flips flight data from sandbox ("Duffel Airways") to real bookable prices | Gohil + friend | ~30 min + review wait |
| F2 | **Kiwi Tequila signup** — free, self-serve ([answers](APPLICATION_DRAFTS.md#1-kiwicom-tequila-flights--lccryanair)). Adds Ryanair + 250 LCCs Duffel misses | Gohil + friend | ~15 min |
| F3 | **Integrate Kiwi** as a second flight source in `searchLegOptions`/`compareLeg`: query both, surface the cheapest, keep affiliate redirect links | Claude | ~1 day |

**Done means:** real prices globally including European budget carriers.

---

## 🚂 Trains — race the applications, hedge with schedules

**Today:** DB REST covers DACH (keep). Non-DACH legs honestly show
"no live train data" (keep until a provider lands).

| # | Step | When | Who |
|---|---|---|---|
| T1 | Four applications in flight: All Aboard (best odds), Omio, Junction, Trainline. Wait | now → Jul 20 | — |
| T2 | Nudge anyone silent (drafts linked from the tracker). Get the Trainline submission date from friend | **Jul 20** | Gohil |
| T3 | **First provider to grant keys wins** → integrate as the non-DACH rail adapter. DB REST stays for DACH | on keys | Claude (~2–4 days) |
| T4 | **Hedge decision:** if nothing landed, build the **GTFS interim** — official free schedule feeds (SNCF, Renfe…) so non-DACH legs show real train *times* + "price at booking" deep link. Zero fabrication | **Jul 27** | Claude |
| T5 | **EIN** (free, irs.gov, sole prop works) unblocks Rail Europe's form (Italy coverage) and smooths Duffel verification — one document, two doors | whenever ready | Gohil + friend |
| T6 | Trainline **affiliate** signup — revenue-tracked rail deep-links, independent of the API application | anytime | Gohil |

---

## Critical path, one sentence

**This week: Duffel verification + Kiwi signup (+ EIN conversation).
Jul 20: nudges. Jul 27: integrate whoever landed, or ship the GTFS hedge.**
