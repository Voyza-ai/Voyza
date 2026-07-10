'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';

type CanvasState = {
  trip?: any;
  cities?: any[];
  transports?: any[];
};

type Suggestion = {
  id: string;
  trip_id: string;
  suggested_by: string;
  type: 'add_city' | 'comment' | 'reaction' | 'edit';
  payload: any;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
};

export type PresenceUser = {
  id: string;
  email: string | null;
  name: string | null;
};

/** A live edit broadcast by another client on the trip's channel. */
export type RemoteOp = {
  state: CanvasState;
  actor: string;
  ts: number;
};

/** Owner changed someone's access. target '*' = every non-owner member. */
export type RoleEvent = {
  targetUserId: string;
  role: string;
  actor: string;
  ts: number;
};

type UseCanvasRealtimeReturn = {
  canvasState: CanvasState | null;
  suggestions: Suggestion[];
  isConnected: boolean;
  updateState: (newState: CanvasState) => void;
  /** Everyone currently IN the canvas (presence), self included. */
  presence: PresenceUser[];
  /** Latest live edit from another client (apply if actor ≠ self). */
  remoteOp: RemoteOp | null;
  /** Broadcast a local edit to everyone else on the channel. */
  broadcastOp: (state: CanvasState) => void;
  /** Latest role change announced by the owner. */
  roleEvent: RoleEvent | null;
  /** Owner: announce a role change so the target reflects it live. */
  broadcastRoleChange: (targetUserId: string, role: string) => void;
};

export function useCanvasRealtime(
  tripId: string,
  currentUser?: PresenceUser | null,
): UseCanvasRealtimeReturn {
  const [canvasState, setCanvasState] = useState<CanvasState | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [remoteOp, setRemoteOp] = useState<RemoteOp | null>(null);
  const [roleEvent, setRoleEvent] = useState<RoleEvent | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // Track identity via ref so the channel effect doesn't resubscribe on
  // every render (user object identity changes freely).
  const userRef = useRef<PresenceUser | null>(currentUser ?? null);
  useEffect(() => {
    userRef.current = currentUser ?? null;
  }, [currentUser]);

  const userId = currentUser?.id ?? null;

  useEffect(() => {
    if (!tripId) return;
    // Wait for a real identity before joining the channel. Subscribing
    // early minted an anonymous presence key; when auth finished loading
    // the user appeared TWICE (their anon ghost + their real self) — the
    // "clicking my own share link adds another icon of me" bug.
    if (!userId) return;

    const channel = supabase
      .channel(`canvas-${tripId}`, {
        config: { presence: { key: userId } },
      })
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'canvas_sessions',
          filter: `trip_id=eq.${tripId}`,
        },
        (payload) => {
          if (payload.new && typeof payload.new === 'object' && 'state' in payload.new) {
            setCanvasState((payload.new as any).state);
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'canvas_suggestions',
          filter: `trip_id=eq.${tripId}`,
        },
        (payload) => {
          if (payload.new) {
            setSuggestions((prev) => [payload.new as Suggestion, ...prev]);
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'canvas_suggestions',
          filter: `trip_id=eq.${tripId}`,
        },
        (payload) => {
          if (payload.new) {
            const updated = payload.new as Suggestion;
            setSuggestions((prev) =>
              prev.map((s) => (s.id === updated.id ? updated : s)),
            );
          }
        },
      )
      .on('broadcast', { event: 'canvas_op' }, ({ payload }) => {
        if (payload?.state) setRemoteOp(payload as RemoteOp);
      })
      .on('broadcast', { event: 'role_change' }, ({ payload }) => {
        if (payload?.targetUserId && payload?.role) setRoleEvent(payload as RoleEvent);
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<PresenceUser>();
        const byId = new Map<string, PresenceUser>();
        for (const key of Object.keys(state)) {
          const metas = state[key];
          if (metas && metas.length > 0) {
            const m = metas[0] as any;
            const id = m.id ?? key;
            // Dedupe by user id — multiple tabs/devices of the same person
            // collapse into one avatar.
            if (!byId.has(id)) byId.set(id, { id, email: m.email ?? null, name: m.name ?? null });
          }
        }
        setPresence(Array.from(byId.values()));
      })
      .subscribe(async (status) => {
        setIsConnected(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED' && userRef.current) {
          await channel.track(userRef.current);
        }
      });

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [tripId, userId]);

  const updateState = useCallback((newState: CanvasState) => {
    setCanvasState(newState);
  }, []);

  const broadcastOp = useCallback((state: CanvasState) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'canvas_op',
      payload: { state, actor: userRef.current?.id ?? 'unknown', ts: Date.now() },
    });
  }, []);

  const broadcastRoleChange = useCallback((targetUserId: string, role: string) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'role_change',
      payload: { targetUserId, role, actor: userRef.current?.id ?? 'unknown', ts: Date.now() },
    });
  }, []);

  return {
    canvasState,
    suggestions,
    isConnected,
    updateState,
    presence,
    remoteOp,
    broadcastOp,
    roleEvent,
    broadcastRoleChange,
  };
}
