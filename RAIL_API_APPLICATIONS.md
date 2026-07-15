# Rail API Applications — All Aboard, Rail Europe, Omio, Junction, Trainline follow-up

_Drafted 2026-07-16. Companion to [APPLICATION_DRAFTS.md](APPLICATION_DRAFTS.md) and
[TRAINLINE_APPLICATION.md](TRAINLINE_APPLICATION.md). Goal: real pan-European train
prices for the optimizer now, booking later. Strategy: **apply to all in parallel —
first to hand us working keys becomes the primary.** DB REST stays for DACH either way._

> Reuse the building blocks from [APPLICATION_DRAFTS.md](APPLICATION_DRAFTS.md)
> (one-liner, website URL, category, model). Be honest about pre-launch stage —
> these companies onboard startups; inflating volumes backfires.

**Priority order:** 1. All Aboard (developer-first, fastest) · 2. Rail Europe
(broadest that accepts small OTAs; likely covers Italy) · 3. Omio (multimodal hedge)
· 4. Junction (email-only, enterprise-leaning) · 5. Trainline (follow-up only —
application already in).

---

## 1. All Aboard — signup form + email (BEST BET)

**Form:** https://allaboard.eu/join ("Get started") · **Docs:** https://docs.allaboard.eu
**Backup / questions:** tech@allaboard.eu

Fill the join form with the standard building blocks. If it stalls or you want to
open a direct line, send:

> **Subject:** API access — Voyza, AI trip planner (flights + trains, Europe-first)
>
> Hi All Aboard team,
>
> I'm building Voyza (https://voyza-nine.vercel.app), an AI trip planner that
> optimizes multi-city itineraries by comparing flights and trains on every leg —
> real door-to-door time and price. Flights run on Duffel; for rail we currently
> use Deutsche Bahn's public API, which only really covers DACH. We want trains
> to win more often, and for that we need real pan-European rail pricing.
>
> Your coverage (SNCF, Renfe, NS, Vy, UK operators) is exactly our gap, and your
> API docs look like the developer-first experience we had with Duffel.
>
> What we're looking for:
> - Search/pricing access to feed our route optimizer (we compare each leg
>   flight-vs-train and pick the best chain)
> - Deep-link or affiliate booking now; in-app booking via your order endpoints
>   as we grow into it
> - Sandbox access to integrate against while we talk terms
>
> We're early-stage and honest about it: pre-launch, Europe-first, small volumes
> to start. If there's a pricing tier or partner track that fits that stage, we'd
> love to hear it — and we can integrate within days of getting keys.
>
> Thanks,
> [name] — Voyza

---

## 2. Rail Europe — agency registration form

**Form:** https://agent.raileurope.com/agency-registration · **Docs:** https://docs.era.raileurope.com

| Form field (typical) | Answer |
|---|---|
| Company name | `Voyza` |
| Business type | Online Travel Agency / booking technology (B2C trip planner) |
| Website | `https://voyza-nine.vercel.app` |
| Country | United States |
| Distribution channel | Our own web app (API integration preferred) |
| Expected rail volume | Pre-launch — no committed volume yet (be honest) |
| Interested in | **API** (they also offer trade website + affiliation — tick API, affiliation as fallback) |

**"About your business" / free-text field:**

> Voyza is an AI-powered trip planner that optimizes multi-city itineraries
> across flights and trains, comparing real price and door-to-door time on every
> leg. We're Europe-first: our users plan routes like Paris→Amsterdam→Berlin or
> Rome→Florence→Venice, where rail should win — but we only integrate real,
> bookable prices, so today many legs fall back to flights. We're looking for
> API search/pricing access to power the optimizer, with affiliate or in-app
> booking as we scale. Early-stage and transparent about volumes; we can
> integrate quickly against a sandbox.

---

## 3. Omio Partner — multimodal hedge

**Start at:** https://www.omio.com/corporate/partners (a.k.a. Omio Partner Program;
if the URL moved, search "Omio partner program"). Affiliate track is self-serve-ish;
API track is by conversation.

Use the same free-text blurb as Rail Europe, swapping the last ask:

> …We're interested in the Omio partner API for rail (and bus) search across your
> 1,000+ operators, with affiliate deep-links to Omio checkout — and potentially
> deeper integration as volumes grow.

---

## 4. Junction — email only

**Email:** deploy@junctionconnect.com · https://junctionconnect.com

> **Subject:** Multimodal API access — Voyza (AI trip planner, flights + rail)
>
> Hi Junction team,
>
> Voyza (https://voyza-nine.vercel.app) is an AI trip planner that builds
> multi-city itineraries by comparing flights and trains per leg. Flights run on
> Duffel today; we're evaluating partners for pan-European rail search/pricing
> and, later, booking.
>
> Junction's one-API multimodal model maps well to how our optimizer works.
> Could you share your European rail coverage, commercial terms for an
> early-stage product, and whether a sandbox is available? We can integrate
> within weeks — "zero to global in weeks" is the timeline we're hoping to test.
>
> Thanks,
> [name] — Voyza

---

## 5. Trainline — follow-up on the existing application

Reply to the confirmation email if one exists; otherwise resubmit a short note via
https://tps.thetrainline.com/get-in-touch/ referencing the earlier inquiry.

> **Subject:** Following up — Voyza partner inquiry (submitted [date])
>
> Hi Trainline Partner Solutions,
>
> Following up on the partner inquiry we submitted on [date] for Voyza, an AI
> trip planner optimizing multi-city European itineraries across flights and
> trains. We're keen on Global API search/pricing access — but if the right
> first step for a company at our stage is the affiliate programme, we'd happily
> start there while we grow into API access. Is there any update on our inquiry,
> or someone we should speak to directly?
>
> Thanks,
> [name] — Voyza

_Meanwhile, sign up for the Trainline **affiliate programme** separately (lower
bar): https://www.thetrainline.com/about-us/partnerships — revenue-tracked
deep-links while the API application cooks._

---

## What to hand back to Claude

Whichever lands first: the **API key/token + docs link + sandbox base URL** 🔒 →
new env vars in `backend/.env`, wired into `searchLegOptions`/`compareLeg` next to
the existing DB REST integration (which stays for DACH).
