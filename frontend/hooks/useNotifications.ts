'use client';

import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getNotifications, type AppNotification } from '@/lib/api';
import { useNotificationsStore } from '@/store/notificationsStore';

/**
 * Loads the user's notifications and keeps them live.
 *
 * - Initial fetch on mount / user change → store.setAll
 * - Supabase Realtime `postgres_changes` INSERT subscription (filtered to
 *   this user; RLS's select policy scopes what the socket may deliver) →
 *   store.prepend, so the bell badge updates without a reload.
 * - No userId (signed out / auth still resolving) → store reset. Guarding
 *   on userId before subscribing mirrors useCanvasRealtime — subscribing
 *   pre-auth creates a channel the server will never deliver to.
 * - No manual backoff: postgres_changes channels rejoin automatically.
 */
export function useNotifications(userId: string | null | undefined): void {
  useEffect(() => {
    if (!userId) {
      useNotificationsStore.getState().reset();
      return;
    }
    if (!supabase) return; // env not configured (tests, misconfig) — fetch-only paths also die without it

    let disposed = false;

    getNotifications()
      .then((res) => {
        if (!disposed) {
          useNotificationsStore.getState().setAll(res.notifications, res.unreadCount);
        }
      })
      .catch(() => {
        // Non-fatal — the bell just stays empty; next mount retries.
      });

    const channel = supabase
      .channel(`notifications-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new: AppNotification }) => {
          if (!disposed && payload?.new?.id) {
            useNotificationsStore.getState().prepend(payload.new);
          }
        },
      )
      .subscribe();

    return () => {
      disposed = true;
      supabase.removeChannel(channel);
    };
  }, [userId]);
}
