# iMessage trip assistant — build plan

Branch `feat/imessage-bot`. No merges, no PR, no deploys. Written 2026-11-11.

## Goal of today's test

The owner texts BlueMurr from their own iMessage, in a group or 1:1, then:

1. asks about their saved trip;
2. asks for a change and confirms it with YES;
3. starts a flight booking;
4. sees the change and the booking on the website under their own login.

## How a message flows

```
iMessage ─► Sendblue ─► (dev: we poll GET /api/v2/messages | later: webhook)
        ─► providers/sendblue.ts → InboundText
        ─► bot.ts  (dedupe → addressed? → rate limit → code cmds →
                    privacy check → YES/NO → chat engine → pending edit)
        ─► chatEngine.ts  ── one seam ──►  /api/plan/chat logic (plan.ts)
        ─► applier.ts (on YES) ─► same save path as the website
        ─► Sendblue send ─► iMessage
```

## Pieces and status

| # | Piece | Status |
|---|---|---|
| 1 | Core bot: linking, verification, privacy, confirmation, limits | done, 26 tests |
| 2 | Simulator CLI (talk to the bot locally, no provider) | next |
| 3 | Trip loader: `buildTripFromDb` + members/roles from DB | next |
| 4 | Chat seam: loopback HTTP to `/api/plan/chat` for now, then `runPlanChat()` import | next |
| 5 | Applier: owner-only save through the canvas save path, with a version check | next |
| 6 | Phone on the account: verified by texting a code; listed and removable in Settings | needs migration + UI OK |
| 7 | Sendblue adapter: polling in dev, webhook + secret check later | needs account + keys |
| 8 | Booking by text: the bot sends a link that opens the existing Booking modal for that leg | needs small frontend change |
| 9 | Migration 016 + dry run (threads, phones, codes, pending edits) | file only, not applied |

## Rules the bot enforces

- **Addressing:** in a group it only reacts to "BlueMurr …", to `link/verify CODE`, or to YES/NO while an edit is pending.
- **Privacy:** no trip details while ANY number in the thread is not verified to a member of that trip. Numbers are shown masked (`•••0123`).
- **Edits:** never applied from one message. The bot states the change and needs YES from the owner within 10 minutes.
- **Limits:**
  - 8 messages per person per minute;
  - 30 AI turns per group per 10 minutes, 200 per day;
  - 5 wrong codes locks a number out for an hour;
  - duplicate deliveries are dropped.
- **Codes:** 6 characters, single use, 15-minute life, made in the app by a logged-in member. Texting the code is what proves the phone belongs to that account.

## Hiccups found, and how each is handled

1. **An open website tab can overwrite a texted edit.**
   - The results page autosaves its whole copy of the trip, and the save has no version check.
   - It never re-fetches, so the change won't show until a reload.
   - Fix: the applier refuses if the trip changed since the proposal. The website save gets a version check, and the page re-fetches on focus. This needs a small, approved change to the save code.
2. **Website saves are owner-only.** So texted edits are confirmed by the owner only, matching the site. Editors can ask, but not confirm.
3. **Accepting an edit on the site also re-prices it.**
   - The site re-searches hotels, legs and home flights after Accept.
   - The applier must do the same server-side by reusing canvas save's enrich step, not copying it.
4. **The chat can't see home flights yet.**
   - "What time is our flight home?" fails until `fix/ai-chat-home-legs` lands.
   - The bot inherits that fix through the seam.
5. **Booking can't be paid by text.**
   - The card form must run in the browser (Duffel/Stripe), and passenger details are personal data.
   - The bot sends a link to the trip that opens the existing Booking modal.
   - The booking already saves with `tripId`, so it shows on the site.
6. **Sendblue specifics.**
   - Groups are beta and plan-gated.
   - Every group member needs iMessage.
   - The free sandbox can't send.
   - Webhooks can't reach this container, so dev polls the API.
   - It is unverified whether a group's id survives a member change.
7. **One database.** Linking a real thread or applying a real edit writes to the shared Supabase. Every write and the migration need the owner's OK first. Tests never touch it.
8. **Container restarts.** Until migration 016 is applied, links, verified phones and pending edits live in memory and vanish on restart.
9. **Phone numbers are personal data.**
   - Stored only as E.164, visible only to their owner, never echoed in full in a group.
   - Included in the data export, deleted with the account, and removable in Settings.
10. **Login does not change.** There is no phone sign-in. The phone is added to an existing account by texting a code, so there is no SMS one-time-code cost and no new auth provider.
11. **Members removed from a trip** lose access on their next message, because membership is checked on every message.

## Open questions for the owner

- Where does the bot run for today's real-iMessage test?
  - This cloud container: needs Supabase, Anthropic, Duffel-test and Sendblue keys via the secure form.
  - Or your Mac's local backend.
- Sendblue plan with groups enabled.
- OK to write migration 016 + phone column (apply later, after a dry run).
- OK on the "Text your trip" panel + Settings phone row (screenshot first).
