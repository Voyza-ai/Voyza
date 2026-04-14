'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check, Users } from 'lucide-react';
import { inviteToCanvas } from '@/lib/api';

type InviteModalProps = {
  tripId: string;
  isOpen: boolean;
  onClose: () => void;
  members: Array<{
    id: string;
    invited_email: string;
    role: string;
    accepted_at: string | null;
    user_id: string | null;
  }>;
};

export default function InviteModal({ tripId, isOpen, onClose, members }: InviteModalProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'suggester' | 'viewer'>('editor');
  const [sending, setSending] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const handleInvite = async () => {
    if (!email.trim()) return;
    setSending(true);
    try {
      const result = await inviteToCanvas(tripId, email.trim(), role);
      setInviteLink(result.inviteLink);
      setEmail('');
    } catch {
      // handle error
    } finally {
      setSending(false);
    }
  };

  const copyLink = (link: string, id: string) => {
    navigator.clipboard.writeText(link);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="w-[420px] rounded-2xl border overflow-hidden"
            style={{
              background: '#1a1a1a',
              borderColor: 'rgba(255,255,255,0.1)',
            }}
          >
            {/* Header */}
            <div className="px-5 py-4 flex items-center justify-between border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="flex items-center gap-2">
                <Users size={16} className="text-white/60" />
                <span className="text-white text-[14px] font-medium">Share Canvas</span>
              </div>
              <button onClick={onClose} className="text-white/40 hover:text-white/70 transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Invite form */}
            <div className="px-5 py-4">
              <div className="flex gap-2 mb-3">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email address"
                  className="flex-1 px-3 py-2 rounded-lg text-[13px] text-white placeholder-white/30 outline-none"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                  className="px-3 py-2 rounded-lg text-[13px] text-white outline-none appearance-none"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  <option value="editor">Editor</option>
                  <option value="suggester">Suggester</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <button
                onClick={handleInvite}
                disabled={!email.trim() || sending}
                className="w-full py-2 rounded-lg text-[13px] font-medium text-white transition-all disabled:opacity-30"
                style={{ background: '#4f8ef7' }}
              >
                {sending ? 'Sending...' : 'Send Invite'}
              </button>

              {inviteLink && (
                <div className="mt-3 p-2.5 rounded-lg flex items-center gap-2" style={{ background: 'rgba(79,142,247,0.1)' }}>
                  <span className="text-white/60 text-[11px] truncate flex-1">{inviteLink}</span>
                  <button
                    onClick={() => copyLink(inviteLink, 'invite')}
                    className="text-white/50 hover:text-white/80 transition-colors flex-shrink-0"
                  >
                    {copiedId === 'invite' ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              )}
            </div>

            {/* Members list */}
            {members.length > 0 && (
              <div className="px-5 pb-4">
                <div className="text-white/40 text-[11px] uppercase tracking-wider mb-2">Members</div>
                <div className="flex flex-col gap-1.5">
                  {members.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg"
                      style={{ background: 'rgba(255,255,255,0.03)' }}
                    >
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                        style={{ background: m.accepted_at ? '#22c088' : 'rgba(255,255,255,0.1)' }}
                      >
                        {m.invited_email?.[0]?.toUpperCase() ?? '?'}
                      </div>
                      <span className="text-white/70 text-[12px] flex-1 truncate">
                        {m.invited_email}
                      </span>
                      <span className="text-white/30 text-[10px] uppercase">
                        {m.role}
                      </span>
                      {m.accepted_at && (
                        <div className="w-2 h-2 rounded-full bg-green-500" title="Online" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
