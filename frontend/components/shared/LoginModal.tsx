'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Eye, EyeOff } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';

type LoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
};

export default function LoginModal({ isOpen, onClose, onSuccess }: LoginModalProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setUser = useAuthStore((s) => s.setUser);
  const setSession = useAuthStore((s) => s.setSession);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      setError('Authentication is not configured');
      return;
    }

    setError(null);
    setLoading(true);

    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    setSession(data.session);
    setUser(data.user);
    setEmail('');
    setPassword('');
    onClose();

    if (onSuccess) {
      onSuccess();
    }
  };

  const handleSignupLink = () => {
    onClose();
    router.push('/auth/signup');
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,0.3)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="bg-white rounded-xl shadow-lg border border-gray-100 p-8 w-full max-w-sm relative"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={onClose}
                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={18} />
              </button>

              <div className="text-center mb-6">
                <h2 className="text-xl font-bold" style={{ color: '#2563eb' }}>
                  VOYZA
                </h2>
                <p className="text-gray-500 text-sm mt-1">Sign in to save your trip</p>
              </div>

              <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                <input
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 bg-white text-gray-900 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/20 focus:border-[#2563eb] transition-colors"
                  required
                />

                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg border border-gray-200 bg-white text-gray-900 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/20 focus:border-[#2563eb] transition-colors pr-10"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                {error && (
                  <div className="rounded-lg px-3 py-2 text-sm" style={{ background: '#fef2f2', color: '#dc2626' }}>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 rounded-lg text-sm font-medium text-white transition-all disabled:opacity-50 mt-1"
                  style={{ background: '#2563eb' }}
                >
                  {loading ? 'Signing in...' : 'Sign in'}
                </button>
              </form>

              <p className="text-center text-sm text-gray-500 mt-4">
                <button
                  onClick={handleSignupLink}
                  className="font-medium hover:underline"
                  style={{ color: '#2563eb' }}
                >
                  Create account
                </button>
              </p>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
