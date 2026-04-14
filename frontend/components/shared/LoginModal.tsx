'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Mail } from 'lucide-react';

type LoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export default function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: Wire up Supabase auth when ready
    console.log(isSignUp ? 'Sign up' : 'Login', { email, password });
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          {/* Modal */}
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="bg-voyza-card border border-voyza-border rounded-2xl p-8 w-full max-w-sm relative"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Close button */}
              <button
                onClick={onClose}
                className="absolute top-4 right-4 text-[#555555] hover:text-white transition-colors"
              >
                <X size={20} />
              </button>

              {/* Header */}
              <div className="text-center mb-6">
                <h2
                  className="text-2xl font-bold mb-1"
                  style={{ color: '#4f8ef7' }}
                >
                  VOYZA
                </h2>
                <p className="text-[#aaaaaa] text-sm">
                  {isSignUp
                    ? 'Create your account'
                    : 'Sign in to save your trips'}
                </p>
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                <div className="relative">
                  <Mail
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555555]"
                    size={18}
                  />
                  <input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-voyza-bg border border-voyza-border rounded-xl py-3 pl-10 pr-4 text-sm text-white placeholder-[#555555] focus:border-voyza-accent focus:outline-none"
                    required
                  />
                </div>
                <input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-voyza-bg border border-voyza-border rounded-xl py-3 px-4 text-sm text-white placeholder-[#555555] focus:border-voyza-accent focus:outline-none"
                  required
                />
                <button
                  type="submit"
                  className="w-full bg-voyza-accent hover:bg-voyza-accent/90 text-white font-medium py-3 rounded-xl text-sm transition-colors mt-1"
                >
                  {isSignUp ? 'Create account' : 'Sign in'}
                </button>
              </form>

              {/* Toggle */}
              <p className="text-center text-[#aaaaaa] text-xs mt-4">
                {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
                <button
                  onClick={() => setIsSignUp(!isSignUp)}
                  className="text-voyza-accent hover:underline"
                >
                  {isSignUp ? 'Sign in' : 'Sign up'}
                </button>
              </p>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
