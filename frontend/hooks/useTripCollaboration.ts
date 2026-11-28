'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCanvasRealtime, type PresenceUser } from './useCanvasRealtime';
import { useAuthStore } from '@/store/authStore';
import { useTripStore } from '@/store/tripStore';
import {
  getCanvasSession,
  getCanvasRole,
  getCanvasSuggestions,
  joinCanvasByLink,
  postCanvasSuggestion,
  updateSuggestionStatus,
  saveTrip,
} from '@/lib/api';
import {
  applyCollabState,
  collabSignature,
  tripToCollabState,
  withRemoteApply,
  type CollabState,
  applyCollabDelta,
  computeCollabDelta,
  type CollabDelta,
  ownerShouldApplySessionSave,
} from '@/lib/tripCollab';
import { summarizeCanvasChanges } from '@/lib/canvasDiff';
import { liveTripTotal } from '@/lib/tripTotals';
import type { Trip } from '@/lib/types';

export type CollabRole = 'owner' | 'editor' | 'suggester' | 'viewer';
export type Toast = { message: string; type: 'success' | 'error' | 'info' };
export type Suggestion = {
  id: string;
  trip_id?: string;
  suggested_by: string;
  type: 'add_city' | 'comment' | 'reaction' | 'edit';
  payload: any;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
};

/** How long to wait after a local edit before telling collaborators. */
const BROADCAST_DEBOUNCE_MS = 400;

/**
 * Everything the canvas did to make a saved trip a shared, live document —
 * now on the results page:
 *
 *  - joining by a share link (`?share=<token>`), before the trip loads;
 *  - the signed-in person's role on the trip, kept current (owner changes,
 *    removal, ownership transfer) by broadcast, focus, reconnect and a slow
 *    poll — the canvas's rules;
 *  - presence (who is here) and live cursors;
 *  - live edits: owners and editors broadcast every change of the trip on
 *    screen; everyone else's changes are applied as they arrive. The owner's
 *    page saves them (useSavedTripAutosave — the save endpoint is
 *    owner-only), so an editor's change is kept whenever the owner has the
 *    trip open, as with the canvas's Save;
 *  - suggesters edit their own copy and send it as a proposal; the owner
 *    approves or rejects proposals and suggested cities;
 *  - "Save a copy" for anyone who is not the owner.
 *
 * Inactive (role null, nothing subscribed) for a trip that was never saved.
 */
export function useTripCollaboration(tripId: string | null, initialShareToken: string | null) {
  const user = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.isLoading);
  const setTrip = useTripStore((s) => s.setTrip);
  const trip = useTripStore((s) => s.currentTrip);

  const [role, setRole] = useState<CollabRole | null>(null);
  const roleRef = useRef<CollabRole | null>(null);
  roleRef.current = role;
  const hadRoleRef = useRef(false);
  const [accessGate, setAccessGate] = useState<'removed' | 'no_access' | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(initialShareToken);
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nonce, setNonce] = useState(0);

  const showToast = useCallback((message: string, type: Toast['type'] = 'success') => {
    setToast({ message, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const active = !!tripId && !tripId.startsWith('mock') && !!user;

  const presenceUser = useMemo<PresenceUser | null>(
    () =>
      user
        ? {
            id: user.id,
            // Name only — presence is readable by everyone on the trip.
            name: (user.user_metadata?.full_name as string) || null,
          }
        : null,
    [user],
  );
  // Shut out (removed, no access): off the trip's channel, so the others stop
  // seeing this person online — measured, a removed member kept showing as
  // "here now" to everyone.
  const rt = useCanvasRealtime(active ? tripId! : '', active && !accessGate ? presenceUser : null);

  // ── Share-link join ───────────────────────────────────────────
  // Runs before the trip is loaded (the page waits on `joinPending`), so the
  // load sees the new membership. Needs a signed-in user.
  const joinPending = !!shareToken;
  useEffect(() => {
    if (!shareToken || !tripId || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await joinCanvasByLink(tripId, shareToken);
        // Shown once the trip is on screen: said during the load, it expired
        // behind the loading screen (measured: a bell join with a slow load
        // never showed it).
        if (!cancelled && r.joined) joinedMsg.current = `You joined this trip as ${r.role}`;
      } catch {
        if (!cancelled) {
          showToast('This share link is invalid or has been reset', 'error');
          // The no-access screen says why (the toast hid behind it).
          setLinkInvalid(true);
        }
      } finally {
        if (!cancelled) {
          try {
            const url = new URL(window.location.href);
            url.searchParams.delete('share');
            window.history.replaceState(window.history.state, '', url.toString());
          } catch {
            // ignore
          }
          setShareToken(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareToken, tripId, user, showToast]);

  const joinedMsg = useRef<string | null>(null);
  const tripOnScreen = !!trip && trip.id === tripId;
  useEffect(() => {
    if (!tripOnScreen || !joinedMsg.current) return;
    showToast(joinedMsg.current, 'success');
    joinedMsg.current = null;
  }, [tripOnScreen, shareToken, showToast]);

  /** The person dismissed sign-in: the pending join is dropped. */
  const dropShareToken = useCallback(() => setShareToken(null), []);

  // ── Role ──────────────────────────────────────────────────────
  // The session read also creates the trip's canvas session when it has
  // none, which sharing and suggestions hang off.
  useEffect(() => {
    if (!active || joinPending || authLoading) return;
    let cancelled = false;
    (async () => {
      try {
        const { role: r } = await getCanvasSession(tripId!);
        if (cancelled) return;
        if (r) {
          hadRoleRef.current = true;
          setRole(r as CollabRole);
          setAccessGate(null);
        }
        const s = await getCanvasSuggestions(tripId!).catch(() => null);
        if (!cancelled && s?.suggestions) setSeeded(s.suggestions as Suggestion[]);
      } catch {
        if (cancelled) return;
        try {
          const { role: r } = await getCanvasRole(tripId!);
          if (cancelled) return;
          if (!r) setAccessGate('no_access');
          else {
            hadRoleRef.current = true;
            setRole(r as CollabRole);
          }
        } catch {
          // transient — the next refresh reconciles
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, tripId, joinPending, authLoading, nonce]);

  // Leaving this trip (another trip, signed out): forget its role.
  useEffect(() => {
    if (!active) {
      setRole(null);
      setAccessGate(null);
    }
  }, [active, tripId]);

  const refreshRole = useCallback(async () => {
    if (!active || !tripId) return;
    try {
      let { role: fresh } = await getCanvasRole(tripId);
      // An ownership transfer rewrites membership in steps — confirm a
      // missing role before treating it as a removal.
      if (!fresh) {
        await new Promise((r) => setTimeout(r, 1500));
        ({ role: fresh } = await getCanvasRole(tripId));
      }
      if (!fresh) {
        setAccessGate(hadRoleRef.current ? 'removed' : 'no_access');
        return;
      }
      hadRoleRef.current = true;
      if (fresh !== roleRef.current) {
        const had = roleRef.current;
        setRole(fresh as CollabRole);
        if (had) {
          showToast(
            fresh === 'owner'
              ? "You're now the owner of this trip"
              : `Your access changed: you're now ${fresh === 'editor' ? 'an editor' : fresh === 'suggester' ? 'a suggester' : 'a viewer'}`,
            'info',
          );
        }
      }
    } catch {
      // transient
    }
  }, [active, tripId, showToast]);

  // An owner's role-change broadcast that targets me (or everyone). Handled
  // once per event, and only once my starting role is known — before that,
  // the session load is reading the current role anyway.
  const roleLoaded = role !== null;
  const lastRoleEventTs = useRef(0);
  useEffect(() => {
    const ev = rt.roleEvent;
    if (!ev || !user || ev.actor === user.id || !roleLoaded) return;
    if (ev.targetUserId !== user.id && ev.targetUserId !== '*') return;
    if (ev.ts <= lastRoleEventTs.current) return;
    lastRoleEventTs.current = ev.ts;
    refreshRole();
  }, [rt.roleEvent, user, refreshRole, roleLoaded]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (!document.hidden) refreshRole();
    }, 25000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshRole();
    };
    window.addEventListener('focus', refreshRole);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', refreshRole);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, refreshRole]);

  const connectedOnce = useRef(false);
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (!rt.isConnected) return;
    if (connectedOnce.current) refreshRole();
    connectedOnce.current = true;
    setEverConnected(true);
  }, [rt.isConnected, refreshRole]);

  const canEdit = role === 'owner' || role === 'editor';
  const canManipulate = canEdit || role === 'suggester';

  // ── Live edits ────────────────────────────────────────────────
  // `baseline` is the trip as everyone agrees it is: as loaded, or as last
  // received. A suggester's own edits are measured against it; a received
  // state is not echoed back.
  const baselineRef = useRef<{ id: string; sig: string; trip: Trip } | null>(null);
  const [baselineSig, setBaselineSig] = useState<string | null>(null);
  const lastBroadcastAt = useRef(0);
  /** The last save by Blue (texted YES) put on screen in an owner's tab. */
  const lastTextSaveId = useRef<string | null>(null);
  const lastAppliedOpTs = useRef(0);
  /** The shared trip as it moved on while a suggester had unsent edits. */
  const heldShared = useRef<CollabState | null>(null);
  const broadcastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set by the page: runs after a merge (re-prices legs the merge left joining the wrong stops). */
  const onMergedRef = useRef<(() => void) | null>(null);

  const setBaseline = useCallback((t: Trip) => {
    const sig = collabSignature(t);
    baselineRef.current = { id: t.id ?? '', sig, trip: t };
    setBaselineSig(sig);
  }, []);

  // First sight of this trip (loaded) is the baseline.
  useEffect(() => {
    if (!active || !trip || trip.id !== tripId) return;
    if (baselineRef.current?.id === trip.id) return;
    setBaseline(trip);
  }, [active, trip, tripId, setBaseline]);

  const applyRemote = useCallback(
    (state: Partial<CollabState>) => {
      const cur = useTripStore.getState().currentTrip;
      if (!cur || cur.id !== tripId) return;
      const next = applyCollabState(cur, state);
      if (collabSignature(next) === collabSignature(cur)) {
        setBaseline(next);
        return;
      }
      withRemoteApply(() => setTrip(next));
      setBaseline(useTripStore.getState().currentTrip ?? next);
    },
    [tripId, setTrip, setBaseline],
  );

  // Someone else's live edit — applied once this trip is on screen (one that
  // arrives during the load is applied when it lands).
  const tripLoaded = !!trip && trip.id === tripId;
  useEffect(() => {
    const op = rt.remoteOp;
    if (!op || !user || op.actor === user.id || !active || !tripLoaded) return;
    if (op.ts <= lastAppliedOpTs.current) return;
    lastAppliedOpTs.current = op.ts;
    // A suggester's own unsent edits are kept (everyone else follows live);
    // what arrived meanwhile is held and put on once they send or discard.
    if (roleRef.current === 'suggester' && hasLocalChangesRef.current) {
      heldShared.current = op.state as CollabState;
      return;
    }
    // Made from a state other than the one on screen (we changed something
    // meanwhile): merge just what they changed, so neither change is lost.
    const delta = (op.state as { delta?: CollabDelta }).delta;
    const cur = useTripStore.getState().currentTrip;
    if (delta && cur && cur.id === tripId && delta.base !== collabSignature(cur)) {
      const merged = applyCollabDelta(cur, delta);
      withRemoteApply(() => setTrip(merged));
      // The shared state = what we last shared plus their change; our own
      // unsent edit (if any) stays a difference, so it still goes out.
      const base = baselineRef.current;
      setBaseline(base && base.id === merged.id ? applyCollabDelta(base.trip, delta) : merged);
      onMergedRef.current?.();
      return;
    }
    applyRemote(op.state as CollabState);
  }, [rt.remoteOp, user, active, applyRemote, tripLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // The owner saved (the session row changed). The owner's own save echo is
  // ignored; a collaborator mid-edit keeps their newer local state.
  useEffect(() => {
    const s = rt.canvasState;
    if (!s || !active) return;
    if (roleRef.current === 'owner') {
      // The owner's own saves echo back here and are skipped — except a save
      // Blue made from a texted YES, which must reach an open tab before its
      // next autosave writes the older copy over it.
      const id = ownerShouldApplySessionSave(s, lastTextSaveId.current);
      if (id) {
        lastTextSaveId.current = id;
        applyRemote(s as CollabState);
      }
      return;
    }
    if (Date.now() - lastBroadcastAt.current < 3000) return;
    if (roleRef.current === 'suggester' && hasLocalChangesRef.current) {
      heldShared.current = s as CollabState;
      return;
    }
    applyRemote(s as CollabState);
  }, [rt.canvasState, active, applyRemote]);

  // Our own edits go out to everyone else (owners and editors).
  useEffect(() => {
    if (!active || !canEdit || !trip || trip.id !== tripId) return;
    const base = baselineRef.current;
    if (!base || base.id !== trip.id) return;
    if (broadcastTimer.current) clearTimeout(broadcastTimer.current);
    broadcastTimer.current = setTimeout(() => {
      const latest = useTripStore.getState().currentTrip;
      if (!latest || latest.id !== tripId) return;
      const sig = collabSignature(latest);
      if (sig === baselineRef.current?.sig) return;
      const from = baselineRef.current?.trip;
      rt.broadcastOp({
        ...tripToCollabState(latest),
        ...(from && from.id === latest.id ? { delta: computeCollabDelta(from, latest) } : {}),
      } as any);
      lastBroadcastAt.current = Date.now();
      baselineRef.current = { id: latest.id ?? '', sig, trip: latest };
      setBaselineSig(sig);
    }, BROADCAST_DEBOUNCE_MS);
  }, [trip, active, canEdit, tripId, rt.broadcastOp]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      if (broadcastTimer.current) clearTimeout(broadcastTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // ── Suggester: propose / discard ─────────────────────────────
  const currentSig = useMemo(() => (trip && active ? collabSignature(trip) : null), [trip, active]);
  const hasLocalChanges = role === 'suggester' && !!currentSig && !!baselineSig && currentSig !== baselineSig;
  const hasLocalChangesRef = useRef(false);
  hasLocalChangesRef.current = hasLocalChanges;
  const [busy, setBusy] = useState(false);

  /**
   * Back to the shared trip: as it was when the edits began, then whatever
   * the others changed since. Applied like a received state, so the page
   * doesn't re-search legs for it (a re-priced leg read as a fresh edit).
   */
  const backToShared = useCallback(() => {
    const base = baselineRef.current;
    if (!base) return;
    withRemoteApply(() => setTrip(base.trip));
    const held = heldShared.current;
    heldShared.current = null;
    if (held) applyRemote(held);
  }, [setTrip, applyRemote]);

  // No longer a suggester (made an editor or a viewer) with edits unsent:
  // they were made on a copy that stopped following the trip, and as an
  // editor they would go out live on top of the others' newer changes.
  const prevRole = useRef<CollabRole | null>(null);
  useEffect(() => {
    const was = prevRole.current;
    prevRole.current = role;
    if (was === 'suggester' && role && role !== 'suggester' && hasLocalChangesRef.current) {
      backToShared();
      showToast('Your unsent suggestions were cleared', 'info');
    }
  }, [role, backToShared, showToast]);

  const discard = useCallback(() => {
    if (!baselineRef.current) return;
    backToShared();
    showToast('Changes discarded', 'info');
  }, [backToShared, showToast]);

  const propose = useCallback(async () => {
    const cur = useTripStore.getState().currentTrip;
    const base = baselineRef.current;
    if (!tripId || !cur || !base || roleRef.current !== 'suggester') return;
    setBusy(true);
    try {
      const before = tripToCollabState(base.trip);
      const after = tripToCollabState(cur);
      const r = await postCanvasSuggestion(tripId, 'edit', {
        state: after,
        // What the proposal changes, so approving it later applies just that
        // to the trip as it is then (see approve).
        delta: computeCollabDelta(base.trip, cur),
        // Who it's from — with two suggesters the owner couldn't tell them apart.
        author: (user?.user_metadata?.full_name as string) || user?.email || null,
        summary: summarizeCanvasChanges(before as any, after as any),
      });
      rt.broadcastSuggestionsChanged();
      // Our own proposal, pending — so its approval or rejection (read when
      // the owner announces it) is told to us.
      const mine = r?.suggestion as Suggestion | undefined;
      if (mine?.id) setSeeded((prev) => [mine, ...prev.filter((x) => x.id !== mine.id)]);
      backToShared();
      showToast('Sent to the owner for approval', 'success');
    } catch {
      showToast('Could not send your proposal', 'error');
    } finally {
      setBusy(false);
    }
  }, [tripId, user, showToast, backToShared, rt.broadcastSuggestionsChanged]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Anyone but the owner: keep the trip as it is now in your own trips. */
  const saveCopy = useCallback(async () => {
    const cur = useTripStore.getState().currentTrip;
    if (!cur) return;
    setBusy(true);
    try {
      await saveTrip({ ...cur, id: undefined, totalCost: liveTripTotal(cur) });
      showToast('Saved a copy to your trips', 'success');
    } catch {
      showToast('Could not save a copy', 'error');
    } finally {
      setBusy(false);
    }
  }, [showToast]);

  // ── Suggestions ───────────────────────────────────────────────
  const [seeded, setSeeded] = useState<Suggestion[]>([]);
  const suggestions = useMemo(() => {
    // Two sources (the list as last read, the table's change feed); a
    // suggestion only ever moves on from 'pending', so the decided copy wins.
    const byId = new Map<string, Suggestion>();
    for (const s of [...seeded, ...(rt.suggestions as Suggestion[])]) {
      const had = byId.get(s.id);
      if (!had || had.status === 'pending') byId.set(s.id, s);
    }
    return Array.from(byId.values());
  }, [seeded, rt.suggestions]);

  // Someone sent, approved or rejected a suggestion: read the list again.
  const reloadSuggestions = useCallback(async () => {
    // Shut out: the list is members-only (a removed suggester's poll got 403s).
    if (!active || !tripId || accessGate) return;
    const r = await getCanvasSuggestions(tripId).catch(() => null);
    if (r?.suggestions) setSeeded(r.suggestions as Suggestion[]);
  }, [active, tripId, accessGate]);
  useEffect(() => {
    if (rt.suggestionsTick <= 0) return;
    // The decision first (a decided suggestion leaves the pending list the
    // reload returns, and the proposer is told from this status change).
    const d = rt.suggestionDecision;
    if (d) setSeeded((prev) => prev.map((s) => (s.id === d.id ? { ...s, status: d.status } : s)));
    reloadSuggestions();
  }, [rt.suggestionsTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const announceSuggestions = rt.broadcastSuggestionsChanged;
  // A missed broadcast (reconnecting, a tab in the background) is caught up
  // with the role check's rhythm: every 25s while visible, and on focus.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (!document.hidden) reloadSuggestions();
    }, 25000);
    window.addEventListener('focus', reloadSuggestions);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', reloadSuggestions);
    };
  }, [active, reloadSuggestions]);

  // Tell a suggester when the owner decides on their proposal.
  const prevStatus = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const s of suggestions) {
      const prev = prevStatus.current[s.id];
      if (prev === 'pending' && s.status !== 'pending' && s.suggested_by === user?.id) {
        showToast(
          s.status === 'approved' ? 'Your proposal was approved' : 'Your proposal was declined',
          s.status === 'approved' ? 'success' : 'info',
        );
      }
      prevStatus.current[s.id] = s.status;
    }
  }, [suggestions, user?.id, showToast]);

  const suggestCity = useCallback(
    async (dest: { name: string; estimatedCost?: number; reason?: string }) => {
      if (!tripId) return;
      try {
        await postCanvasSuggestion(tripId, 'add_city', {
          name: dest.name,
          estimatedCost: dest.estimatedCost,
          reason: dest.reason,
        });
        announceSuggestions();
        showToast('Suggestion submitted', 'success');
      } catch {
        showToast('Failed to submit suggestion', 'error');
      }
    },
    [tripId, showToast, announceSuggestions],
  );

  /**
   * Owner: approve a suggestion. A suggested city is handed to `onAddCity`
   * (the page adds it like any city); a proposed edit becomes the trip, which
   * the owner's autosave and broadcast carry to everyone.
   */
  const approve = useCallback(
    async (id: string, onAddCity: (name: string) => void) => {
      if (!tripId) return;
      try {
        await updateSuggestionStatus(tripId, id, 'approved');
        setSeeded((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'approved' } : s)));
        announceSuggestions({ id, status: 'approved' });
        const s = suggestions.find((x) => x.id === id);
        if (s?.type === 'add_city' && s.payload?.name) onAddCity(s.payload.name);
        else if (s?.type === 'edit' && s.payload?.state) {
          const cur = useTripStore.getState().currentTrip;
          // Just the proposed change, on the trip as it is now. Taking the
          // proposal's whole trip undid everything changed since it was
          // made (a city the owner added meanwhile vanished on approve).
          if (cur && s.payload.delta) {
            setTrip(applyCollabDelta(cur, s.payload.delta as CollabDelta));
            onMergedRef.current?.();
          } else if (cur) setTrip(applyCollabState(cur, s.payload.state));
        }
        showToast('Suggestion approved', 'success');
      } catch {
        showToast('Failed to approve', 'error');
      }
    },
    [tripId, suggestions, setTrip, showToast, announceSuggestions],
  );

  const reject = useCallback(
    async (id: string) => {
      if (!tripId) return;
      try {
        await updateSuggestionStatus(tripId, id, 'rejected');
        setSeeded((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'rejected' } : s)));
        announceSuggestions({ id, status: 'rejected' });
        showToast('Suggestion rejected', 'info');
      } catch {
        showToast('Failed to reject', 'error');
      }
    },
    [tripId, showToast, announceSuggestions],
  );

  /** Ownership was handed to someone else from the share dialog. */
  const onTransferred = useCallback(() => {
    setRole('editor');
    setNonce((n) => n + 1);
  }, []);

  return {
    linkInvalid,
    onMergedRef,
    active,
    role,
    canEdit,
    canManipulate,
    /** A share link is still being claimed — hold the trip load. */
    joinPending,
    dropShareToken,
    accessGate,
    presence: rt.presence,
    isConnected: rt.isConnected,
    /** Was live, lost the connection, reconnecting (not the first connect). */
    connectionLost: active && everConnected && !rt.isConnected,
    cursorEvent: rt.cursorEvent,
    broadcastCursor: rt.broadcastCursor,
    broadcastRoleChange: rt.broadcastRoleChange,
    suggestions,
    suggestCity,
    approve,
    reject,
    hasLocalChanges,
    propose,
    discard,
    saveCopy,
    busy,
    onTransferred,
    toast,
    showToast,
    self: presenceUser,
  };
}

export type TripCollaboration = ReturnType<typeof useTripCollaboration>;
