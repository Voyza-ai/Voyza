import { create } from 'zustand';
import type { AppNotification } from '@/lib/api';

/**
 * In-app notifications state behind the navbar bell. Populated by
 * useNotifications (initial fetch + Supabase Realtime inserts); mutations
 * here are optimistic — the API calls happen in the components and the
 * store is updated immediately so the badge/list never lag a click.
 */
type NotificationsStore = {
  items: AppNotification[];
  unreadCount: number;
  /** True once the initial fetch has landed (drives the empty state). */
  loaded: boolean;

  setAll: (items: AppNotification[], unreadCount: number) => void;
  /** Realtime INSERT — dedupes by id so a refetch race can't double-add. */
  prepend: (n: AppNotification) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  reset: () => void;
};

export const useNotificationsStore = create<NotificationsStore>((set) => ({
  items: [],
  unreadCount: 0,
  loaded: false,

  setAll: (items, unreadCount) => set({ items, unreadCount, loaded: true }),

  prepend: (n) =>
    set((state) => {
      if (state.items.some((i) => i.id === n.id)) return state;
      return {
        items: [n, ...state.items],
        unreadCount: state.unreadCount + (n.read_at ? 0 : 1),
      };
    }),

  markRead: (id) =>
    set((state) => {
      const target = state.items.find((i) => i.id === id);
      if (!target || target.read_at) return state;
      return {
        items: state.items.map((i) =>
          i.id === id ? { ...i, read_at: new Date().toISOString() } : i,
        ),
        unreadCount: Math.max(0, state.unreadCount - 1),
      };
    }),

  markAllRead: () =>
    set((state) => ({
      items: state.items.map((i) =>
        i.read_at ? i : { ...i, read_at: new Date().toISOString() },
      ),
      unreadCount: 0,
    })),

  remove: (id) =>
    set((state) => {
      const target = state.items.find((i) => i.id === id);
      return {
        items: state.items.filter((i) => i.id !== id),
        unreadCount:
          target && !target.read_at
            ? Math.max(0, state.unreadCount - 1)
            : state.unreadCount,
      };
    }),

  reset: () => set({ items: [], unreadCount: 0, loaded: false }),
}));
