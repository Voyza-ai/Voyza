'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, MessageCircle, Smile, PenSquare } from 'lucide-react';

type Suggestion = {
  id: string;
  type: 'add_city' | 'comment' | 'reaction' | 'edit';
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
      className="fixed bottom-4 left-4 z-30 w-[280px] max-h-[320px] overflow-y-auto rounded-2xl border shadow-lg"
      style={{
        background: '#ffffff',
        borderColor: 'rgba(0,0,0,0.08)',
      }}
    >
      <div className="px-3 py-2.5 border-b" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
        <span className="text-gray-600 text-[12px] font-medium">
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
                background: '#f8fafc',
                borderColor: 'rgba(0,0,0,0.06)',
              }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                {s.type === 'add_city' && (
                  <div className="w-5 h-5 rounded-full bg-blue-50 flex items-center justify-center">
                    <span className="text-[9px] text-[#2563eb]">+</span>
                  </div>
                )}
                {s.type === 'comment' && (
                  <MessageCircle size={12} className="text-amber-500" />
                )}
                {s.type === 'reaction' && (
                  <Smile size={12} className="text-green-500" />
                )}
                {s.type === 'edit' && (
                  <PenSquare size={12} className="text-violet-500" />
                )}
                <span className="text-gray-700 text-[12px] font-medium flex-1">
                  {s.type === 'add_city'
                    ? `Add ${s.payload?.name ?? 'city'}`
                    : s.type === 'comment'
                      ? 'Comment'
                      : s.type === 'edit'
                        ? 'Proposed changes'
                        : 'Reaction'}
                </span>
              </div>

              {s.type === 'comment' && s.payload?.text && (
                <div className="text-gray-500 text-[11px] mb-2 pl-7">
                  {s.payload.text}
                </div>
              )}

              {s.type === 'edit' && Array.isArray(s.payload?.summary) && (
                <ul className="text-gray-500 text-[11px] mb-2 pl-7 flex flex-col gap-0.5">
                  {s.payload.summary.map((line: string, i: number) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="text-gray-300">•</span>
                      {line}
                    </li>
                  ))}
                </ul>
              )}

              {isOwner && (
                <div className="flex items-center gap-2 pl-7">
                  <button
                    onClick={() => onApprove(s.id)}
                    className="flex items-center gap-1 text-[10px] text-green-600 hover:text-green-700 transition-colors"
                  >
                    <Check size={10} />
                    Approve
                  </button>
                  <button
                    onClick={() => onReject(s.id)}
                    className="flex items-center gap-1 text-[10px] text-red-500 hover:text-red-600 transition-colors"
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
