'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Sparkles, Check, X, Clock } from 'lucide-react';
import { Trip } from '@/lib/types';
import {
  planChat,
  planChatSuggestions,
  ChatProposal,
  ChatTurn,
} from '@/lib/api';
import { useTripStore } from '@/store/tripStore';

type Message = {
  id: number;
  role: 'user' | 'ai';
  content: string;
  /** Present on AI messages that carry a proposal card. */
  proposal?: ChatProposal;
  /** UI state for proposal cards so Accept/Reject hide the buttons. */
  proposalState?: 'pending' | 'accepted' | 'rejected';
};

type AIChatPanelProps = {
  trip: Trip;
};

/**
 * Rule-based fallback suggestions used ONLY if the backend call fails
 * (offline, rate limit). Normally the backend returns Claude-tailored
 * prompts on mount. Kept trip-aware so the chip row never looks generic.
 */
function fallbackSuggestions(trip: Trip): string[] {
  const cities = trip.cities.map((c) => c.name);
  if (cities.length === 0) return ['Why this order?', 'How can I save money?', 'Add a rest day', 'Swap a city'];
  const first = cities[0];
  const last = cities[cities.length - 1];
  // Most expensive city by hotel rate.
  let expensive = first;
  let max = 0;
  for (const c of trip.cities) {
    const rate = c.hotel?.pricePerNight ?? 0;
    if (rate > max) { max = rate; expensive = c.name; }
  }
  return [
    'Why this order of cities?',
    `Make ${expensive} cheaper`,
    `Pin ${first} to specific dates`,
    `Add a day in ${last}`,
  ];
}

/** Short date like "Mar 5" from YYYY-MM-DD. */
function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function AIChatPanel({ trip }: AIChatPanelProps) {
  const setTrip = useTripStore((s) => s.setTrip);

  // Conversation history — sent to the backend each turn for multi-turn
  // context. Excludes proposal cards themselves (the backend only cares
  // about text). We derive it from `messages` at send time.
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: 'ai',
      content: `I built this ${trip.cities.length}-city trip to save you $${trip.savings} vs the most common routing. Ask me anything — pin cities to specific dates, set travel-time constraints, or ask why I ordered things this way.`,
    },
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(fallbackSuggestions(trip));
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const idRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch tailored suggestions once on mount. If it fails, the fallback
  // (already set as initial state) stays put — never leave the UI blank.
  useEffect(() => {
    let cancelled = false;
    planChatSuggestions({ currentTrip: trip })
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.suggestions) && res.suggestions.length > 0) {
          setSuggestions(res.suggestions);
        }
        setSuggestionsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setSuggestionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // Only re-fetch if the trip identity changes — not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.cities.length, trip.cities[0]?.name]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const handleSend = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isTyping) return;

    const userMsg: Message = { id: idRef.current++, role: 'user', content: trimmed };

    // Build history from the current messages state BEFORE appending the
    // user's turn. We send only plain text turns — proposal cards are UI
    // state, not conversational content.
    const history: ChatTurn[] = messages
      .filter((m) => !m.proposal)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    try {
      const result = await planChat({ message: trimmed, currentTrip: trip, history });
      const aiMsg: Message = {
        id: idRef.current++,
        role: 'ai',
        content: result.reply,
        proposal: result.type === 'proposal' ? result.proposal : undefined,
        proposalState: result.type === 'proposal' ? 'pending' : undefined,
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: idRef.current++,
          role: 'ai',
          content: "Sorry — I couldn't reach the server. Try again in a moment.",
        },
      ]);
    } finally {
      setIsTyping(false);
    }
  }, [isTyping, trip, messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSend(input);
  };

  // Accept a proposal: swap the in-memory trip in the Zustand store.
  // Per product spec, this does NOT hit the DB — the existing Save
  // button on the results page owns persistence.
  const acceptProposal = (messageId: number, proposal: ChatProposal) => {
    setTrip(proposal.proposedTrip as Trip);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, proposalState: 'accepted' } : m,
      ),
    );
  };

  const rejectProposal = (messageId: number) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, proposalState: 'rejected' } : m,
      ),
    );
  };

  return (
    <div
      className="flex flex-col h-full rounded-3xl border-2 overflow-hidden"
      style={{
        background: '#eef3fb',
        borderColor: '#2e6bc4',
        boxShadow: '0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)',
      }}
    >
      {/* Header */}
      <div className="px-5 py-4 flex items-center gap-2.5" style={{ background: '#2e6bc4' }}>
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)' }}
        >
          <Sparkles size={14} className="text-white" />
        </div>
        <div>
          <div className="text-white text-sm font-medium leading-tight">Voyza AI</div>
          <div className="text-white/60 text-[11px]">Tweak your trip in plain English</div>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 scrollbar-hide"
        style={{ scrollbarWidth: 'none' }}
      >
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              {/* Text bubble */}
              <div
                className={`max-w-[88%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user' ? 'text-gray-900 rounded-br-md' : 'text-gray-700 rounded-bl-md'
                }`}
                style={{
                  background: msg.role === 'user' ? 'rgba(46,107,196,0.12)' : 'rgba(0,0,0,0.03)',
                  border: msg.role === 'user' ? '1px solid rgba(46,107,196,0.2)' : '1px solid rgba(0,0,0,0.06)',
                }}
              >
                {msg.content}
              </div>

              {/* Proposal card — rendered under the bubble when the AI is
                  proposing a trip change. Accept swaps the Zustand trip;
                  Reject dismisses the card but keeps the chat going. */}
              {msg.proposal && (
                <ProposalCard
                  proposal={msg.proposal}
                  state={msg.proposalState ?? 'pending'}
                  onAccept={() => acceptProposal(msg.id, msg.proposal!)}
                  onReject={() => rejectProposal(msg.id)}
                />
              )}
            </motion.div>
          ))}

          {isTyping && (
            <motion.div
              key="typing"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex justify-start"
            >
              <div
                className="px-3.5 py-3 rounded-2xl rounded-bl-md flex items-center gap-1"
                style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}
              >
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-gray-400"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Suggested prompts — shown only while the user hasn't engaged yet */}
      {messages.length <= 1 && (
        <div className="px-5 pb-3 flex flex-wrap gap-1.5">
          {suggestions.map((prompt) => (
            <button
              key={prompt}
              onClick={() => handleSend(prompt)}
              className="text-[11px] text-[#2e6bc4] hover:text-[#1e5ab3] px-2.5 py-1.5 rounded-full border transition-colors"
              style={{
                background: 'rgba(46,107,196,0.08)',
                borderColor: 'rgba(46,107,196,0.25)',
                opacity: suggestionsLoaded ? 1 : 0.6,
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="p-3 flex items-center gap-2"
        style={{ borderTop: '2px solid #2e6bc4' }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your trip..."
          className="flex-1 text-gray-900 text-[13px] placeholder:text-gray-400 outline-none px-3 py-2 rounded-lg"
          style={{ background: 'rgba(46,107,196,0.06)' }}
        />
        <button
          type="submit"
          disabled={!input.trim() || isTyping}
          className="w-9 h-9 rounded-full flex items-center justify-center text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:scale-105 active:scale-95"
          style={{
            background: input.trim() && !isTyping ? '#2e6bc4' : 'rgba(0,0,0,0.05)',
            color: input.trim() && !isTyping ? '#ffffff' : 'rgba(0,0,0,0.4)',
          }}
          aria-label="Send"
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}

// ─── Proposal card ───────────────────────────────────────────
// Shown inline in the chat after an AI message that proposes a trip
// change. Two flavors:
//   - kind='date_shift': lists every city whose dates moved (the diff).
//   - kind='transport_window': summarizes the constraint being saved.
// Accept/Reject buttons stay visible until the user picks one, then the
// card swaps to a confirmation stub ("Applied" / "Dismissed").
type ProposalCardProps = {
  proposal: ChatProposal;
  state: 'pending' | 'accepted' | 'rejected';
  onAccept: () => void;
  onReject: () => void;
};

function ProposalCard({ proposal, state, onAccept, onReject }: ProposalCardProps) {
  const isPending = state === 'pending';
  const isAccepted = state === 'accepted';

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1, duration: 0.25 }}
      className="mt-2 max-w-[88%] w-full"
      style={{
        background: 'white',
        border: '1px solid rgba(46,107,196,0.25)',
        borderRadius: 14,
        boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
      }}
    >
      <div className="px-4 py-3 flex items-center gap-2 border-b border-gray-100">
        <Clock size={14} style={{ color: '#2e6bc4' }} />
        <div className="text-[12px] font-medium text-gray-900">
          {proposal.kind === 'date_shift' ? 'Proposed date change' : 'Proposed constraint'}
        </div>
      </div>

      <div className="px-4 py-3">
        {proposal.kind === 'date_shift' ? (
          <div className="flex flex-col gap-1.5">
            {proposal.diff.map((d) => (
              <div key={d.city} className="flex items-center text-[12px]">
                <div className="w-20 text-gray-600">{d.city}</div>
                <div className="text-gray-400">
                  {fmt(d.oldArrival)} – {fmt(d.oldDeparture)}
                </div>
                <div className="mx-2 text-gray-400">→</div>
                <div className="text-gray-900 font-medium">
                  {fmt(d.newArrival)} – {fmt(d.newDeparture)}
                </div>
              </div>
            ))}
            {proposal.diff.length === 0 && (
              <div className="text-[12px] text-gray-500">No date changes — constraint saved.</div>
            )}
          </div>
        ) : (
          <TransportWindowSummary proposal={proposal} />
        )}
      </div>

      {isPending && (
        <div className="px-4 py-2.5 border-t border-gray-100 flex justify-end gap-2">
          <button
            onClick={onReject}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition"
          >
            <X size={13} className="inline mr-1 -mt-0.5" />
            Reject
          </button>
          <button
            onClick={onAccept}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white transition"
            style={{ background: '#2e6bc4' }}
          >
            <Check size={13} className="inline mr-1 -mt-0.5" />
            Accept
          </button>
        </div>
      )}

      {!isPending && (
        <div
          className="px-4 py-2 border-t border-gray-100 text-[11px]"
          style={{ color: isAccepted ? '#16a34a' : '#9ca3af' }}
        >
          {isAccepted ? '✓ Applied to your trip' : '× Dismissed'}
        </div>
      )}
    </motion.div>
  );
}

function TransportWindowSummary({ proposal }: { proposal: ChatProposal }) {
  const i = proposal.toolInput ?? {};
  const bits: string[] = [];
  if (i.earliestDepart) bits.push(`depart ≥ ${i.earliestDepart}`);
  if (i.latestDepart) bits.push(`depart ≤ ${i.latestDepart}`);
  if (i.earliestArrive) bits.push(`arrive ≥ ${i.earliestArrive}`);
  if (i.latestArrive) bits.push(`arrive ≤ ${i.latestArrive}`);
  return (
    <div className="text-[12px] text-gray-700 leading-relaxed">
      <div className="font-medium text-gray-900">
        {i.from} → {i.to}
      </div>
      <div className="mt-0.5">{bits.join(' · ') || 'No time bounds'}</div>
      <div className="mt-2 text-[11px] text-gray-500">
        Saved to this trip. Applied the next time we re-pick this leg.
      </div>
    </div>
  );
}
