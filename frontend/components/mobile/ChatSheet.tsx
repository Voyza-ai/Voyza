'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import type { Trip } from '@/lib/types';
import AIChatPanel from '@/components/results/AIChatPanel';
import BottomSheet from './BottomSheet';

/**
 * BlueMurr AI in a dark sheet. It is the desktop chat panel itself
 * (appearance="sheet"): the same /api/plan/chat turns, suggestion chips,
 * proposal cards and Accept / Reject. It stays mounted while closed so the
 * conversation is kept, as the desktop panel's hide does.
 */
export default function ChatSheet({ trip, open, onClose }: { trip: Trip; open: boolean; onClose: () => void }) {
  return (
    <>
      <BottomSheet
        open={open}
        onClose={onClose}
        tone="dark"
        tall
        title={
          <span className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: '#2563eb' }}>
              <Sparkles size={14} className="text-white" />
            </span>
            BlueMurr AI
          </span>
        }
        subtitle="Change your trip in plain English"
        testId="m-chat-sheet"
      >
        <div className="h-full" id="m-chat-slot" />
      </BottomSheet>
      <ChatPortal trip={trip} open={open} />
    </>
  );
}

/**
 * The chat lives in a hidden holder while the sheet is closed and moves into
 * the sheet's slot when it opens, so closing the sheet never unmounts it: the
 * conversation and any pending proposal survive, as with the desktop panel.
 */
function ChatPortal({ trip, open }: { trip: Trip; open: boolean }) {
  const [nodes] = useState(() => {
    if (typeof document === 'undefined') return null;
    const park = document.createElement('div');
    park.style.display = 'none';
    const holder = document.createElement('div');
    holder.style.height = '100%';
    park.appendChild(holder);
    return { park, holder };
  });

  useEffect(() => {
    if (!nodes) return;
    document.body.appendChild(nodes.park);
    return () => nodes.park.remove();
  }, [nodes]);

  useEffect(() => {
    if (!nodes) return;
    let raf = 0;
    const place = () => {
      const slot = document.getElementById('m-chat-slot');
      const target = open && slot ? slot : nodes.park;
      if (nodes.holder.parentElement !== target) target.appendChild(nodes.holder);
      // The sheet's slot mounts a frame after `open` flips.
      if (open && !slot) raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [nodes, open]);

  if (!nodes) return null;
  return createPortal(<AIChatPanel trip={trip} appearance="sheet" />, nodes.holder);
}
