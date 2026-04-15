'use client';

import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const setUser = useAuthStore((s) => s.setUser);
  const setSession = useAuthStore((s) => s.setSession);
  const setLoading = useAuthStore((s) => s.setLoading);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    // Check initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Subscribe to auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [setUser, setSession, setLoading]);

  return <>{children}</>;
}
