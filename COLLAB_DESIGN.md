# Canvas Collaboration — design (item 4)

_Goal: Google-Docs-style sharing on the trip canvas. Owner controls access;
everyone sees changes live._

## Access modes (the owner picks one for the share link)

| Mode | Link joiner becomes | What they can do |
|---|---|---|
| **View only** | `viewer` | See the canvas + live updates. No edits, no chat, no suggestions. |
| **Owner confirms edits** | `suggester` | Edit freely on their own screen, then **Propose changes** — the owner gets an approve/reject card. Nothing touches the real trip until approved. |
| **Full access** | `editor` | Edit live, exactly like the owner (except invite/share/role controls). |

The owner can also change any individual member's role after the fact
(endpoint already exists), and switching the link mode upgrades/downgrades
what NEW joiners get. "Give everyone full access" = set link mode to Full
access + one-click "apply to existing members".

## Share link

- One link per trip: `voyza.app/canvas/{tripId}?share={token}`.
- Backed by `share_token` + `share_mode` columns on `canvas_sessions`
  (migration 004). Owner can **rotate** the token (kills old links) and
  change the mode at any time from the Share dialog.
- Opening the link while signed in → auto-joins as a member at the link's
  mode → straight into the canvas. Signed out → login modal first, then
  auto-join (like Google Docs requiring an account).
- The Share dialog (replaces today's Invite modal) = mode selector +
  **Copy link** + the existing email invites + member list with per-member
  role dropdowns.

## Live editing

- **Presence**: Supabase Realtime `channel.track()` — header avatars show
  who's actually IN the canvas right now (colored ring), joining/leaving
  updates instantly. (The current avatar row shows invited members, not
  live presence.)
- **Edit sync**: every editor broadcasts their state changes over the
  channel (`broadcast: canvas_op`, debounced ~400ms); all other clients
  apply on receipt. Today only the owner's saves propagate — this makes
  every editor's keystroke-level change visible to everyone in seconds.
- **Persistence**: debounced **autosave** (~2s idle) by whoever edited,
  through a membership-gated save endpoint (today it's owner-only). The
  Save button becomes a "Saved ✓ / Saving…" status; manual click = flush.
- **Conflicts**: last-write-wins on the broadcast ops (trip canvases are
  small; simultaneous edits to the SAME field are rare — the loser sees
  the winner's value appear). No CRDTs/cursors in v1 — deliberate.

## Owner-confirms mode (v1 mechanics)

Suggesters edit their local copy freely (full editing UI). Instead of
Save they get **Propose changes** → creates a `canvas_suggestions` row
(`type: 'edit'`) carrying their proposed cities/origin + an auto-generated
summary ("Removed Florence · +1 night Rome · swapped hotel in Nice").
The owner's suggestions panel shows the summary with Approve / Reject:
- **Approve** → proposed state becomes canonical, broadcasts to everyone.
- **Reject** → suggester gets a toast; their local view resets to canonical.
Add-city suggestions from the Suggested Cities drawer keep working as today.

## What already exists (build on, not build new)

- `group_members`: per-member `role`, unique `invite_token`, accepted_at ✓
- Endpoints: invite, join-by-token, members list (enriched), PATCH role
  (owner-only, self-demotion guarded), DELETE member ✓
- `canvas_suggestions` table + panel + approve/reject endpoint ✓
- Realtime channel per trip (state + suggestion inserts) ✓

## Changes required

| Layer | Change |
|---|---|
| DB (migration 004) | `canvas_sessions`: + `share_mode` ('view'\|'suggest'\|'edit', default 'view'), + `share_token` (uuid, rotatable) |
| Backend | `POST /canvas/:tripId/share` (get/rotate link, set mode); `POST /canvas/:tripId/join-link`; save endpoint: owner-only → member-role-gated; suggestions: accept `type:'edit'` payloads; "apply role to existing members" bulk patch |
| Frontend | Share dialog (mode + copy link + member roles); join-link flow on canvas load; presence avatars; broadcast/apply canvas ops; autosave + save-status; suggester "Propose changes" flow + owner approve cards |

## Phases (each shippable)

1. **A — Sharing**: migration, share endpoints, Share dialog, join flow,
   role-gated save. (View-only + Full access live here.)
2. **B — Live**: presence avatars, op broadcast/apply, autosave.
3. **C — Moderated**: suggester propose-bundle + owner approve/reject.

## Decisions taken (flag if you disagree)

1. **Autosave replaces manual save** once live editing lands (status pill
   instead of button). Live editing with manual save = guaranteed lost work.
2. **Share links require sign-in** to join (v1). Anonymous view is a later
   nicety; realtime auth + suggester identity need accounts anyway.
3. **Suggest mode proposes bundles** (whole-change sets with a summary),
   not per-keystroke ops — massively simpler, still gives the owner full
   veto power.
