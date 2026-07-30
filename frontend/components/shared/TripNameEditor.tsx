'use client';

/**
 * Inline editable trip name.
 *
 * Renaming a trip changes what everyone it's shared with sees, so it stays
 * an owner-only action: non-owners get the name as plain text and, if they
 * try to edit it, an explanation rather than a silent no-op or a raw 403.
 *
 * Saving is optimistic — the new name shows immediately and reverts if the
 * request fails, so a dropped connection can't leave the header showing a
 * name the server never accepted.
 */

import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';

export const TRIP_NAME_MAX = 200;

export default function TripNameEditor({
  value,
  canRename,
  onRename,
  onDenied,
  className = '',
  inputClassName = '',
  placeholder = 'Name this trip',
}: {
  /** Current name. May be empty — the placeholder covers that case. */
  value: string;
  /** Only the trip's owner may rename it. */
  canRename: boolean;
  /** Persist the new name. Throwing reverts the optimistic update. */
  onRename: (name: string) => Promise<void>;
  /** Called when a non-owner tries to edit, so the caller can explain why. */
  onDenied?: () => void;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against blur firing a second save right after Enter/Escape.
  const settledRef = useRef(false);

  // Keep the draft in step with the canonical name whenever it changes
  // underneath us — e.g. a collaborator renamed the trip while we watched.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const begin = () => {
    if (!canRename) {
      onDenied?.();
      return;
    }
    setDraft(value);
    settledRef.current = false;
    setEditing(true);
  };

  const commit = async () => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = draft.trim().slice(0, TRIP_NAME_MAX);
    setEditing(false);

    // Nothing typed, or unchanged — leave the existing name alone.
    if (!next || next === value) {
      setDraft(value);
      return;
    }

    setSaving(true);
    try {
      await onRename(next);
    } catch {
      setDraft(value); // revert the optimistic name
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    settledRef.current = true;
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        maxLength={TRIP_NAME_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder={placeholder}
        aria-label="Trip name"
        className={`bg-white border rounded-lg px-2 py-0.5 outline-none focus:border-[#2563eb] ${inputClassName || className}`}
      />
    );
  }

  const shown = value || placeholder;

  return (
    <button
      type="button"
      onClick={begin}
      // Non-owners still get a button so the explanation is reachable by
      // keyboard, but it shouldn't advertise itself as an edit affordance.
      title={canRename ? 'Rename this trip' : 'Only the trip owner can rename this trip'}
      className={`group/name inline-flex items-center gap-1.5 min-w-0 max-w-full text-left ${
        canRename ? 'cursor-text' : 'cursor-default'
      } ${saving ? 'opacity-60' : ''}`}
    >
      <span className={`truncate ${!value ? 'text-gray-400 italic' : ''} ${className}`}>
        {shown}
      </span>
      {canRename && (
        <Pencil
          size={12}
          className="flex-shrink-0 text-gray-400 opacity-0 group-hover/name:opacity-100 transition-opacity"
        />
      )}
    </button>
  );
}
