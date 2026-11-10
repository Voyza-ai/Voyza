import { create } from 'zustand';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

type AuthStore = {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  /**
   * The signed-in user's profile photo (user_profiles.avatar_url, a data: URL).
   * `undefined` = not fetched yet; `null` = they have none. The navbar reads it
   * and Settings writes it, so a new photo shows in the navbar immediately.
   */
  avatarUrl: string | null | undefined;
  setAvatarUrl: (url: string | null | undefined) => void;
  setUser: (user: User | null) => void;
  setSession: (session: Session | null) => void;
  setLoading: (isLoading: boolean) => void;
  signOut: () => Promise<void>;
};

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  session: null,
  isLoading: true,
  avatarUrl: undefined,

  setAvatarUrl: (avatarUrl) => set({ avatarUrl }),
  // A different account (or sign-out) must not keep the previous photo.
  setUser: (user) =>
    set((s) => (s.user?.id === user?.id ? { user } : { user, avatarUrl: undefined })),
  setSession: (session) => set({ session }),
  setLoading: (isLoading) => set({ isLoading }),

  signOut: async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    set({ user: null, session: null, avatarUrl: undefined });
    if (typeof window !== 'undefined') {
      window.location.href = '/';
    }
  },
}));
