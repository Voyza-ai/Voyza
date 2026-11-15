'use client';

import { useEffect, useMemo, useState } from 'react';
import { listTripMembers, type TripMember } from '@/lib/api';
import type { PresenceUser } from '@/hooks/useCanvasRealtime';

type Props = {
  tripId: string;
  /** Who has the trip open right now (self included). */
  presence: PresenceUser[];
  selfId: string | null;
  /** Bumped when membership may have changed (share dialog closed, a role event). */
  refreshKey: number;
  onClick?: () => void;
};

const MAX_SHOWN = 4;

function hueFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * The people on a shared trip, as overlapping profile pictures beside the
 * Share button (where Docs and Figma put them). Everyone who has joined is
 * shown; whoever has the trip open right now carries a green dot. Hidden
 * until the trip is actually shared — a lone picture of yourself says
 * nothing the navbar doesn't.
 */
export default function CollaboratorAvatars({ tripId, presence, selfId, refreshKey, onClick }: Props) {
  const [members, setMembers] = useState<TripMember[]>([]);

  // Someone new opening the trip (e.g. through a share link) is a member we
  // may not have listed yet.
  const presenceKey = presence
    .map((p) => p.id)
    .sort()
    .join(',');

  useEffect(() => {
    let live = true;
    listTripMembers(tripId)
      .then((r) => {
        if (live) setMembers(r.members ?? []);
      })
      .catch(() => {
        // not shared with us / transient — nothing to show
      });
    return () => {
      live = false;
    };
  }, [tripId, refreshKey, presenceKey]);

  const online = useMemo(() => new Set(presence.map((p) => p.id)), [presence]);

  const people = useMemo(() => {
    const joined = members.filter((m) => !m.pending && m.userId);
    const list = joined.map((m) => ({
      id: m.userId as string,
      name: m.fullName || m.displayName || 'Member',
      avatarUrl: m.avatarUrl,
      role: m.role,
    }));
    // Present but not listed yet (joined seconds ago).
    for (const p of presence) {
      if (!list.some((x) => x.id === p.id)) {
        list.push({ id: p.id, name: p.name || 'Someone', avatarUrl: null, role: 'viewer' });
      }
    }
    // Online first, then the owner, then everyone else.
    return list.sort((a, b) => {
      const ao = online.has(a.id) ? 0 : 1;
      const bo = online.has(b.id) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      if (a.role === 'owner' && b.role !== 'owner') return -1;
      if (b.role === 'owner' && a.role !== 'owner') return 1;
      return 0;
    });
  }, [members, presence, online]);

  if (people.length < 2) return null;

  const shown = people.slice(0, MAX_SHOWN);
  const rest = people.length - shown.length;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center -space-x-2 rounded-full pr-0.5"
      aria-label={`${people.length} people on this trip`}
      data-testid="collaborator-avatars"
    >
      {shown.map((p) => {
        const isSelf = p.id === selfId;
        const isOnline = online.has(p.id);
        const label = `${isSelf ? 'You' : p.name}${isOnline ? ' · here now' : ''}`;
        return (
          <span
            key={p.id}
            title={label}
            className="relative w-8 h-8 rounded-full ring-2 ring-white flex items-center justify-center text-[11px] font-semibold text-white overflow-visible"
            style={{
              background: p.avatarUrl ? '#e5e7eb' : isSelf ? '#2563eb' : `hsl(${hueFor(p.id)}, 55%, 48%)`,
              opacity: isOnline ? 1 : 0.55,
            }}
          >
            {p.avatarUrl ? (
              <img src={p.avatarUrl} alt="" className="w-full h-full rounded-full object-cover" />
            ) : (
              initialsOf(p.name)
            )}
            {isOnline && (
              <span
                className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white"
                style={{ background: '#22c55e' }}
              />
            )}
          </span>
        );
      })}
      {rest > 0 && (
        <span
          title={people
            .slice(MAX_SHOWN)
            .map((p) => p.name)
            .join(', ')}
          className="relative w-8 h-8 rounded-full ring-2 ring-white flex items-center justify-center text-[11px] font-medium text-gray-600 bg-gray-100"
        >
          +{rest}
        </span>
      )}
    </button>
  );
}
