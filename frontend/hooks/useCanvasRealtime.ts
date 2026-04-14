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

type UseCanvasRealtimeReturn = {
  canvasState: CanvasState | null;
  suggestions: Suggestion[];
  isConnected: boolean;
  updateState: (newState: CanvasState) => void;
};

export function useCanvasRealtime(tripId: string): UseCanvasRealtimeReturn {
  const [canvasState, setCanvasState] = useState<CanvasState | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!tripId) return;

    const channel = supabase
      .channel(`canvas-${tripId}`)
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
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
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

  return { canvasState, suggestions, isConnected, updateState };
}
