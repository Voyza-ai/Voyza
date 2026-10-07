'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  AlertTriangle,
  UserMinus,
  KeyRound,
  CheckCircle2,
  XCircle,
  UserPlus,
  Copy,
  X,
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useNotificationsStore } from '@/store/notificationsStore';
import { useNotifications } from '@/hooks/useNotifications';
import {
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  clearAllNotifications,
  cloneTrip,
  type AppNotification,
} from '@/lib/api';

/** Compact relative timestamp: "2m", "3h", "5d", else a short date. */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function iconFor(n: AppNotification) {
  switch (n.type) {
    case 'account_deletion_scheduled':
      return <AlertTriangle size={15} className="text-amber-500" />;
    case 'trip_owner_anonymized':
      return <UserMinus size={15} className="text-gray-500" />;
    case 'ownership_transferred':
      return <KeyRound size={15} className="text-[#2563eb]" />;
    case 'suggestion_decided':
      return n.data?.status === 'approved' ? (
        <CheckCircle2 size={15} className="text-emerald-500" />
      ) : (
        <XCircle size={15} className="text-gray-400" />
      );
    case 'canvas_invite':
      return <UserPlus size={15} className="text-[#2563eb]" />;
  }
}

/**
 * Navbar notification bell: unread badge, dropdown list (fed by
 * useNotifications — initial fetch + realtime inserts), mark-all-read,
 * per-row delete, and type-specific click actions. All mutations are
 * optimistic against the store; API calls follow fire-and-forget with a
 * catch so a network blip never wedges the UI.
 */
export default function NotificationBell() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  useNotifications(user?.id);

  const items = useNotificationsStore((s) => s.items);
  const unreadCount = useNotificationsStore((s) => s.unreadCount);
  const loaded = useNotificationsStore((s) => s.loaded);
  const storeMarkRead = useNotificationsStore((s) => s.markRead);
  const storeMarkAllRead = useNotificationsStore((s) => s.markAllRead);
  const storeRemove = useNotificationsStore((s) => s.remove);

  const [open, setOpen] = useState(false);
  const [cloningId, setCloningId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click — same pattern as the avatar menu next door.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!user) return null;

  const markRead = (n: AppNotification) => {
    if (n.read_at) return;
    storeMarkRead(n.id);
    markNotificationRead(n.id).catch(() => {});
  };

  const handleRowClick = (n: AppNotification) => {
    markRead(n);
    const tripId = n.data?.tripId;
    switch (n.type) {
      case 'ownership_transferred':
      case 'suggestion_decided':
        if (tripId) {
          setOpen(false);
          router.push(`/canvas/${tripId}`);
        }
        break;
      case 'canvas_invite': {
        // Heal legacy rows: early notifications stored /canvas/join/<token>,
        // a page that never existed on the frontend (404). Rebuild the real
        // join URL — /canvas/<tripId>?share=<token> — from the same payload.
        let link: string | undefined = n.data?.link;
        if (link?.startsWith('/canvas/join/') && tripId) {
          const token = link.split('/').pop();
          link = `/canvas/${tripId}?share=${token}`;
        }
        if (link) {
          setOpen(false);
          router.push(link);
        }
        break;
      }
      // account_deletion_scheduled + trip_owner_anonymized: mark-read only
      // (the latter's action is its explicit Clone button).
    }
  };

  const handleClone = async (n: AppNotification) => {
    if (!n.data?.tripId || cloningId) return;
    setCloningId(n.id);
    try {
      const res = await cloneTrip(n.data.tripId);
      markRead(n);
      setOpen(false);
      router.push(`/canvas/${res.tripId}`);
    } catch {
      // Clone failed (trip gone?) — leave the notification for a retry.
    } finally {
      setCloningId(null);
    }
  };

  const handleMarkAll = () => {
    if (unreadCount === 0) return;
    storeMarkAllRead();
    markAllNotificationsRead().catch(() => {});
  };

  const handleClearAll = () => {
    if (items.length === 0) return;
    useNotificationsStore.getState().setAll([], 0);
    clearAllNotifications().catch(() => {});
  };

  const handleDelete = (e: React.MouseEvent, n: AppNotification) => {
    e.stopPropagation(); // don't trigger the row navigation
    storeRemove(n.id);
    deleteNotification(n.id).catch(() => {});
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        className="relative w-8 h-8 rounded-full flex items-center justify-center text-white transition-opacity hover:opacity-80"
        style={{ background: 'rgba(255,255,255,0.2)' }}
      >
        <Bell size={15} />
        {unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold flex items-center justify-center"
            data-testid="notification-badge"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-lg shadow-lg border border-gray-100 z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-800">Notifications</span>
            <div className="flex items-center gap-3">
              {/* Enabled only while something is UNREAD — clicking a row
                  already marks it read, so a fully-read list grays this out. */}
              <button
                onClick={handleMarkAll}
                disabled={unreadCount === 0}
                className="text-[11px] text-[#2563eb] hover:text-[#1e50c8] disabled:text-gray-300 transition-colors"
              >
                Mark all read
              </button>
              <button
                onClick={handleClearAll}
                disabled={items.length === 0}
                className="text-[11px] text-[#2563eb] hover:text-[#1e50c8] disabled:text-gray-300 transition-colors"
              >
                Clear all
              </button>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-gray-400">
                {loaded ? "You're all caught up" : 'Loading…'}
              </div>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  onClick={() => handleRowClick(n)}
                  className="group px-3 py-2.5 border-b border-gray-50 flex gap-2.5 cursor-pointer hover:bg-gray-50 transition-colors"
                >
                  <div className="flex-shrink-0 mt-0.5">{iconFor(n)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {!n.read_at && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#2563eb] flex-shrink-0" />
                      )}
                      <p
                        className={`text-[13px] truncate ${
                          n.read_at ? 'text-gray-600' : 'font-medium text-gray-900'
                        }`}
                      >
                        {n.title}
                      </p>
                    </div>
                    {n.body && (
                      <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                    {n.type === 'trip_owner_anonymized' && n.data?.tripId && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleClone(n);
                        }}
                        disabled={cloningId === n.id}
                        className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-white bg-[#2563eb] hover:brightness-110 disabled:opacity-50 transition-all"
                      >
                        <Copy size={10} />
                        {cloningId === n.id ? 'Cloning…' : 'Clone trip'}
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-[10px] text-gray-400">{timeAgo(n.created_at)}</span>
                    <button
                      onClick={(e) => handleDelete(e, n)}
                      aria-label="Delete notification"
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-gray-500 transition-opacity"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
