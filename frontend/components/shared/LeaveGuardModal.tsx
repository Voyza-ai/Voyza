'use client';

import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLeaveGuardStore } from '@/lib/leaveGuard';

/**
 * "Leave this trip?" — asked when a page with unsaved work is about to be
 * left inside the app (Back, a swipe, a link). Rendered once, in the root
 * layout; pages raise it through useLeaveGuard (lib/leaveGuard).
 *
 * Stay is the default (focused, Escape, a click outside). "Save trip" shows
 * when the page can save: it keeps the person here and runs the page's save,
 * sign-in first for someone signed out.
 */
export default function LeaveGuardModal() {
  const prompt = useLeaveGuardStore((s) => s.prompt);
  const save = useLeaveGuardStore((s) => s.save);
  const cardRef = useRef<HTMLDivElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!prompt) return;
    const before = document.activeElement as HTMLElement | null;
    stayRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Ahead of any other dialog's Escape (the sign-in modal's).
        e.stopPropagation();
        prompt.stay();
        return;
      }
      if (e.key !== 'Tab' || !cardRef.current) return;
      // Keep focus in the dialog.
      const buttons = Array.from(cardRef.current.querySelectorAll('button'));
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (before && before.isConnected && typeof before.focus === 'function') before.focus();
    };
  }, [prompt]);

  return (
    <AnimatePresence>
      {prompt && (
        <motion.div
          key="leave-guard"
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-black/40" onClick={prompt.stay} data-testid="leave-guard-backdrop" />
          <motion.div
            ref={cardRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-guard-title"
            aria-describedby="leave-guard-body"
            className="relative w-full max-w-sm bg-white rounded-2xl shadow-xl border border-gray-100 p-6"
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <h2 id="leave-guard-title" className="text-lg font-semibold text-gray-900 mb-1.5">
              {prompt.copy.title}
            </h2>
            <p id="leave-guard-body" className="text-[13px] text-gray-600 mb-6">
              {prompt.copy.body}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={prompt.leave}
                className="px-3 py-2 rounded-xl text-[13px] font-medium text-red-600 hover:bg-red-50 transition-colors"
              >
                Leave
              </button>
              <div className="flex-1" />
              {save && (
                <button
                  type="button"
                  onClick={() => {
                    prompt.stay();
                    save();
                  }}
                  className="px-4 py-2 rounded-xl border text-[13px] font-medium transition-colors hover:bg-blue-50"
                  style={{ color: '#2563eb', borderColor: '#2563eb', background: '#ffffff' }}
                >
                  Save trip
                </button>
              )}
              <button
                type="button"
                ref={stayRef}
                onClick={prompt.stay}
                className="px-5 py-2 rounded-xl text-[13px] font-medium text-white transition-all hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/40 focus-visible:ring-offset-2"
                style={{ background: '#2563eb' }}
              >
                Stay
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
