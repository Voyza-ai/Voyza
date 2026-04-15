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
          style={{ background: 'rgba(0,0,0,0.3)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="w-[420px] rounded-2xl border overflow-hidden shadow-xl"
            style={{
              background: '#ffffff',
              borderColor: 'rgba(0,0,0,0.08)',
            }}
          >
            {/* Header */}
            <div className="px-5 py-4 flex items-center justify-between border-b" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
              <div className="flex items-center gap-2">
                <Users size={16} className="text-gray-500" />
                <span className="text-gray-900 text-[14px] font-medium">Share Canvas</span>
              </div>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
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
                  className="flex-1 px-3 py-2 rounded-lg text-[13px] text-gray-900 placeholder-gray-400 outline-none"
                  style={{ background: '#f0f4f8', border: '1px solid rgba(0,0,0,0.08)' }}
                />
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                  className="px-3 py-2 rounded-lg text-[13px] text-gray-700 outline-none appearance-none"
                  style={{ background: '#f0f4f8', border: '1px solid rgba(0,0,0,0.08)' }}
                >
                  <option value="editor">Editor</option>
                  <option value="suggester">Suggester</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <button
                onClick={handleInvite}
                disabled={!email.trim() || sending}
                className="w-full py-2 rounded-lg text-[13px] font-medium text-white transition-all disabled:opacity-30 hover:brightness-110"
                style={{ background: '#2563eb' }}
              >
                {sending ? 'Sending...' : 'Send Invite'}
              </button>

              {inviteLink && (
                <div className="mt-3 p-2.5 rounded-lg flex items-center gap-2" style={{ background: 'rgba(37,99,235,0.06)' }}>
                  <span className="text-gray-500 text-[11px] truncate flex-1">{inviteLink}</span>
                  <button
                    onClick={() => copyLink(inviteLink, 'invite')}
                    className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
                  >
                    {copiedId === 'invite' ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              )}
            </div>

            {/* Members list */}
            {members.length > 0 && (
              <div className="px-5 pb-4">
                <div className="text-gray-400 text-[11px] uppercase tracking-wider mb-2">Members</div>
                <div className="flex flex-col gap-1.5">
                  {members.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg"
                      style={{ background: '#f8fafc' }}
                    >
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
                        style={{ background: m.accepted_at ? '#22c088' : '#cbd5e1' }}
                      >
                        {m.invited_email?.[0]?.toUpperCase() ?? '?'}
                      </div>
                      <span className="text-gray-600 text-[12px] flex-1 truncate">
                        {m.invited_email}
                      </span>
                      <span className="text-gray-400 text-[10px] uppercase">
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
