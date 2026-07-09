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
  type: 'add_city' | 'comment' | 'reaction';
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
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // Track identity via ref so the channel effect doesn't resubscribe on
  // every render (user object identity changes freely).
  const userRef = useRef<PresenceUser | null>(currentUser ?? null);
  useEffect(() => {
    userRef.current = currentUser ?? null;
  }, [currentUser]);

  useEffect(() => {
    if (!tripId) return;

    const channel = supabase
      .channel(`canvas-${tripId}`, {
        config: { presence: { key: userRef.current?.id ?? `anon-${Math.random().toString(36).slice(2)}` } },
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
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<PresenceUser>();
        const users: PresenceUser[] = [];
        for (const key of Object.keys(state)) {
          const metas = state[key];
          if (metas && metas.length > 0) {
            const m = metas[0] as any;
            users.push({ id: m.id ?? key, email: m.email ?? null, name: m.name ?? null });
          }
        }
        setPresence(users);
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
  }, [tripId]);

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

  return { canvasState, suggestions, isConnected, updateState, presence, remoteOp, broadcastOp };
}
