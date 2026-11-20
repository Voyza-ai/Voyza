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

/** Faces shown before the "+N" circle. */
const MAX_SHOWN = 3;

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
  const [listOpen, setListOpen] = useState(false);

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
    const list: Array<{ id: string; name: string; avatarUrl: string | null | undefined; role: string | null }> = joined.map((m) => ({
      id: m.userId as string,
      name: m.fullName || m.displayName || 'Member',
      avatarUrl: m.avatarUrl,
      role: m.role,
    }));
    // Present but not listed yet (joined seconds ago).
    for (const p of presence) {
      if (!list.some((x) => x.id === p.id)) {
        // Role unknown until the member list catches up.
        list.push({ id: p.id, name: p.name || 'Someone', avatarUrl: null, role: null });
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

  const face = (p: (typeof people)[number], size: 'lg' | 'sm') => {
    const isSelf = p.id === selfId;
    const isOnline = online.has(p.id);
    const dim = size === 'lg' ? 'w-8 h-8 text-[11px] ring-2' : 'w-6 h-6 text-[9.5px] ring-1';
    return (
      <span
        className={`relative ${dim} rounded-full ring-white flex items-center justify-center font-semibold text-white overflow-visible flex-shrink-0`}
        style={{
          background: p.avatarUrl ? '#e5e7eb' : isSelf ? '#2563eb' : `hsl(${hueFor(p.id)}, 55%, 48%)`,
          opacity: size === 'lg' && !isOnline ? 0.55 : 1,
        }}
      >
        {p.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.avatarUrl} alt="" className="w-full h-full rounded-full object-cover" />
        ) : (
          initialsOf(p.name)
        )}
        {isOnline && (
          <span
            className={`absolute -bottom-0.5 -right-0.5 ${size === 'lg' ? 'w-2.5 h-2.5 ring-2' : 'w-2 h-2 ring-1'} rounded-full ring-white`}
            style={{ background: '#22c55e' }}
          />
        )}
      </span>
    );
  };

  return (
    <div className="relative flex items-center" onMouseLeave={() => setListOpen(false)}>
      <button
        type="button"
        onClick={onClick}
        className="flex items-center -space-x-1 rounded-full pr-0.5"
        aria-label={`${people.length} people on this trip`}
        data-testid="collaborator-avatars"
      >
        {shown.map((p) => (
          <span key={p.id} title={`${p.id === selfId ? 'You' : p.name}${online.has(p.id) ? ' · here now' : ''}`}>
            {face(p, 'lg')}
          </span>
        ))}
        {rest > 0 && (
          <span
            onMouseEnter={() => setListOpen(true)}
            onFocus={() => setListOpen(true)}
            className="relative w-8 h-8 rounded-full ring-2 ring-white flex items-center justify-center text-[11px] font-medium text-gray-600 bg-gray-100"
            data-testid="collaborators-more"
          >
            +{rest}
          </span>
        )}
      </button>

      {/* Hovering "+N": everyone on the trip, online first. */}
      {listOpen && rest > 0 && (
        <div
          role="list"
          aria-label="People on this trip"
          data-testid="collaborators-list"
          className="absolute left-0 top-full mt-2 z-50 w-[240px] max-h-[320px] overflow-y-auto rounded-xl border bg-white py-1.5 shadow-lg"
          style={{ borderColor: '#e5e7eb' }}
        >
          <div className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wider text-gray-400 font-medium">
            {people.length} people on this trip
          </div>
          {people.map((p) => (
            <div role="listitem" key={p.id} className="flex items-center gap-2.5 px-3 py-1.5">
              {face(p, 'sm')}
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] text-gray-800 truncate">
                  {p.name}
                  {p.id === selfId && <span className="text-gray-400"> (you)</span>}
                </div>
                <div className="text-[10.5px] text-gray-500 first-letter:uppercase">
                  {[p.role, online.has(p.id) ? 'here now' : null].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
