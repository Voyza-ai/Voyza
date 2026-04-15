import { create } from 'zustand';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

type AuthStore = {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  setUser: (user: User | null) => void;
  setSession: (session: Session | null) => void;
  setLoading: (isLoading: boolean) => void;
  signOut: () => Promise<void>;
};

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  session: null,
  isLoading: true,

  setUser: (user) => set({ user }),
  setSession: (session) => set({ session }),
  setLoading: (isLoading) => set({ isLoading }),

  signOut: async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    set({ user: null, session: null });
    if (typeof window !== 'undefined') {
      window.location.href = '/';
    }
  },
}));
