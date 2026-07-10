'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check, Eye, MessageSquare, Pencil, RefreshCw, Trash2, Send } from 'lucide-react';
import {
  getShareLink,
  updateShareLink,
  applyRoleToMembers,
  inviteToCanvas,
  listTripMembers,
  updateMemberRole,
  removeMember,
  ShareMode,
  TripMember,
} from '@/lib/api';

type ShareModalProps = {
  tripId: string;
  isOpen: boolean;
  onClose: () => void;
  /** Toast passthrough so feedback matches the canvas. */
  onToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
};

const MODES: { key: ShareMode; icon: typeof Eye; title: string; blurb: string; joinRole: string }[] = [
  {
    key: 'view',
    icon: Eye,
    title: 'View only',
    blurb: 'They watch the trip live but can’t change anything.',
    joinRole: 'viewer',
  },
  {
    key: 'suggest',
    icon: MessageSquare,
    title: 'Owner confirms edits',
    blurb: 'They edit freely, you approve or reject each change.',
    joinRole: 'suggester',
  },
  {
    key: 'edit',
    icon: Pencil,
    title: 'Full access',
    blurb: 'Everyone edits live, just like you.',
    joinRole: 'editor',
  },
];

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  editor: 'Editor',
  suggester: 'Suggester',
  viewer: 'Viewer',
};

export default function ShareModal({ tripId, isOpen, onClose, onToast }: ShareModalProps) {
  // Compose the link from OUR origin — the backend's FRONTEND_URL points at
  // prod, which would hand dev/localhost users a wrong-environment link.
  const composeUrl = (token?: string, fallback?: string) =>
    token && typeof window !== 'undefined'
      ? `${window.location.origin}/canvas/${tripId}?share=${token}`
      : fallback ?? '';

  const [mode, setMode] = useState<ShareMode>('view');
  const [url, setUrl] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [members, setMembers] = useState<TripMember[]>([]);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'suggester' | 'viewer'>('editor');
  const [sending, setSending] = useState(false);

  const toast = useCallback(
    (m: string, t: 'success' | 'error' | 'info' = 'success') => onToast?.(m, t),
    [onToast],
  );

  // Load link + members when the dialog opens
  useEffect(() => {
    if (!isOpen) return;
    setLinkLoading(true);
    getShareLink(tripId)
      .then((r) => {
        setMode(r.mode);
        setUrl(composeUrl(r.token, r.url));
      })
      .catch(() => toast('Could not load share link', 'error'))
      .finally(() => setLinkLoading(false));
    listTripMembers(tripId)
      .then((r) => setMembers(r.members))
      .catch(() => {});
  }, [isOpen, tripId, toast]);

  const changeMode = async (next: ShareMode) => {
    const prev = mode;
    setMode(next); // optimistic
    try {
      const r = await updateShareLink(tripId, { mode: next });
      setMode(r.mode);
      setUrl(composeUrl(r.token, r.url));
    } catch {
      setMode(prev);
      toast('Could not change link access', 'error');
    }
  };

  const copyLink = () => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const rotateLink = async () => {
    if (!window.confirm('Reset the link? Anyone holding the old link loses access to it.')) return;
    try {
      const r = await updateShareLink(tripId, { rotate: true });
      setUrl(composeUrl(r.token, r.url));
      toast('Link reset — old copies no longer work');
    } catch {
      toast('Could not reset the link', 'error');
    }
  };

  const applyToExisting = async () => {
    const role = MODES.find((m) => m.key === mode)?.joinRole as 'editor' | 'suggester' | 'viewer';
    if (!role) return;
    if (!window.confirm(`Set every current member to ${ROLE_LABELS[role]}?`)) return;
    try {
      const r = await applyRoleToMembers(tripId, role);
      setMembers((prev) => prev.map((m) => ({ ...m, role }) as TripMember));
      toast(`${r.updated} member${r.updated === 1 ? '' : 's'} set to ${ROLE_LABELS[role]}`);
    } catch {
      toast('Could not update members', 'error');
    }
  };

  const handleInvite = async () => {
    if (!email.trim()) return;
    setSending(true);
    try {
      await inviteToCanvas(tripId, email.trim(), inviteRole);
      setEmail('');
      const r = await listTripMembers(tripId);
      setMembers(r.members);
      toast(`Invited ${email.trim()}`);
    } catch {
      toast('Invite failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const changeMemberRole = async (memberId: string, role: 'editor' | 'suggester' | 'viewer') => {
    const prev = members;
    setMembers((ms) => ms.map((m) => (m.id === memberId ? ({ ...m, role } as TripMember) : m)));
    try {
      await updateMemberRole(tripId, memberId, role);
    } catch {
      setMembers(prev);
      toast('Could not change role', 'error');
    }
  };

  const handleRemove = async (memberId: string) => {
    const prev = members;
    setMembers((ms) => ms.filter((m) => m.id !== memberId));
    try {
      await removeMember(tripId, memberId);
    } catch {
      setMembers(prev);
      toast('Could not remove member', 'error');
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: 'rgba(0,0,0,0.3)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-white rounded-2xl shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-gray-100">
              <h2 className="text-[15px] font-semibold text-gray-900">Share this trip</h2>
              <button
                onClick={onClose}
                aria-label="Close share dialog"
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="px-5 py-4 flex flex-col gap-5">
              {/* ── Link access mode ── */}
              <div>
                <div className="text-[12px] font-medium text-gray-500 mb-2">
                  Anyone with the link
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {MODES.map((m) => {
                    const Icon = m.icon;
                    const active = mode === m.key;
                    return (
                      <button
                        key={m.key}
                        onClick={() => changeMode(m.key)}
                        className="flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all"
                        style={{
                          borderColor: active ? '#2563eb' : 'rgba(0,0,0,0.08)',
                          background: active ? '#eff6ff' : '#ffffff',
                          boxShadow: active ? '0 0 0 1px #2563eb' : 'none',
                        }}
                      >
                        <Icon size={15} style={{ color: active ? '#2563eb' : '#9ca3af' }} />
                        <span className="text-[12px] font-semibold text-gray-900 leading-tight">
                          {m.title}
                        </span>
                        <span className="text-[10.5px] text-gray-500 leading-snug">{m.blurb}</span>
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={applyToExisting}
                  className="mt-2 text-[11.5px] text-[#2563eb] hover:underline underline-offset-2"
                >
                  Apply this access to all current members
                </button>
              </div>

              {/* ── The link ── */}
              <div>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={linkLoading ? 'Loading…' : url}
                    className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-[12px] text-gray-600 outline-none"
                  />
                  <button
                    onClick={copyLink}
                    disabled={!url}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40 flex-shrink-0"
                    style={{ background: '#2563eb' }}
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                </div>
                <button
                  onClick={rotateLink}
                  className="mt-1.5 flex items-center gap-1 text-[11.5px] text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <RefreshCw size={11} />
                  Reset link (old copies stop working)
                </button>
              </div>

              {/* ── Email invite ── */}
              <div>
                <div className="text-[12px] font-medium text-gray-500 mb-2">Invite by email</div>
                <div className="flex items-center gap-2">
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleInvite();
                    }}
                    placeholder="friend@email.com"
                    className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-200 text-[12.5px] outline-none focus:border-[#2563eb]"
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as any)}
                    aria-label="Invite role"
                    className="px-2 py-2 rounded-lg border border-gray-200 text-[12px] text-gray-700 outline-none bg-white"
                  >
                    <option value="editor">Editor</option>
                    <option value="suggester">Suggester</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    onClick={handleInvite}
                    disabled={sending || !email.trim()}
                    aria-label="Send invite"
                    className="p-2 rounded-lg text-white transition-all hover:brightness-110 disabled:opacity-40 flex-shrink-0"
                    style={{ background: '#2563eb' }}
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>

              {/* ── Members ── */}
              {members.length > 0 && (
                <div>
                  <div className="text-[12px] font-medium text-gray-500 mb-2">
                    People with access
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {members.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
                        style={{ background: '#f8fafc' }}
                      >
                        <div
                          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-medium text-white flex-shrink-0"
                          style={{ background: '#64748b' }}
                        >
                          {(m.invited_email?.[0] ?? '?').toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] text-gray-800 truncate">
                            {m.invited_email ?? 'Member'}
                          </div>
                          {!m.accepted_at && (
                            <div className="text-[10px] text-amber-600">Invite pending</div>
                          )}
                        </div>
                        {m.role === 'owner' ? (
                          <span className="text-[11px] text-gray-400 px-1.5">Owner</span>
                        ) : (
                          <>
                            <select
                              value={m.role}
                              onChange={(e) => changeMemberRole(m.id, e.target.value as any)}
                              aria-label={`Role for ${m.invited_email ?? 'member'}`}
                              className="px-1.5 py-1 rounded-md border border-gray-200 text-[11px] text-gray-700 outline-none bg-white"
                            >
                              <option value="editor">Editor</option>
                              <option value="suggester">Suggester</option>
                              <option value="viewer">Viewer</option>
                            </select>
                            <button
                              onClick={() => handleRemove(m.id)}
                              aria-label={`Remove ${m.invited_email ?? 'member'}`}
                              className="p-1 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
