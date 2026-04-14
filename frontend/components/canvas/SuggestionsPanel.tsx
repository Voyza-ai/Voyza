'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, MessageCircle, Smile } from 'lucide-react';

type Suggestion = {
  id: string;
  type: 'add_city' | 'comment' | 'reaction';
  payload: any;
  status: 'pending' | 'approved' | 'rejected';
  suggested_by: string;
  created_at: string;
};

type SuggestionsPanelProps = {
  suggestions: Suggestion[];
  role: string;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
};

export default function SuggestionsPanel({
  suggestions,
  role,
  onApprove,
  onReject,
}: SuggestionsPanelProps) {
  const pending = suggestions.filter((s) => s.status === 'pending');
  const isOwner = role === 'owner';

  if (pending.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed bottom-4 left-4 z-30 w-[280px] max-h-[320px] overflow-y-auto rounded-2xl border"
      style={{
        background: 'rgba(18,18,18,0.95)',
        borderColor: 'rgba(255,255,255,0.1)',
        backdropFilter: 'blur(20px)',
      }}
    >
      <div className="px-3 py-2.5 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        <span className="text-white/70 text-[12px] font-medium">
          Pending Suggestions ({pending.length})
        </span>
      </div>

      <div className="p-2 flex flex-col gap-2">
        <AnimatePresence>
          {pending.map((s) => (
            <motion.div
              key={s.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              className="rounded-lg p-2.5 border"
              style={{
                background: 'rgba(255,255,255,0.04)',
                borderColor: 'rgba(255,255,255,0.08)',
              }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                {s.type === 'add_city' && (
                  <div className="w-5 h-5 rounded-full bg-blue-500/20 flex items-center justify-center">
                    <span className="text-[9px] text-blue-400">+</span>
                  </div>
                )}
                {s.type === 'comment' && (
                  <MessageCircle size={12} className="text-amber-400" />
                )}
                {s.type === 'reaction' && (
                  <Smile size={12} className="text-green-400" />
                )}
                <span className="text-white/80 text-[12px] font-medium flex-1">
                  {s.type === 'add_city'
                    ? `Add ${s.payload?.name ?? 'city'}`
                    : s.type === 'comment'
                      ? 'Comment'
                      : 'Reaction'}
                </span>
              </div>

              {s.type === 'comment' && s.payload?.text && (
                <div className="text-white/40 text-[11px] mb-2 pl-7">
                  {s.payload.text}
                </div>
              )}

              {isOwner && (
                <div className="flex items-center gap-2 pl-7">
                  <button
                    onClick={() => onApprove(s.id)}
                    className="flex items-center gap-1 text-[10px] text-green-400 hover:text-green-300 transition-colors"
                  >
                    <Check size={10} />
                    Approve
                  </button>
                  <button
                    onClick={() => onReject(s.id)}
                    className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 transition-colors"
                  >
                    <X size={10} />
                    Reject
                  </button>
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
