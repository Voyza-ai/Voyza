'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Sparkles, Check, X, Clock, Plane, TrainFront, ArrowRight } from 'lucide-react';
import { Trip, Transport } from '@/lib/types';
import {
  planChat,
  planChatSuggestions,
  ChatProposal,
  ChatTurn,
  LegOption,
  LegRefresh,
  ModeComparison,
} from '@/lib/api';
import { useTripStore } from '@/store/tripStore';
import { displayAmount } from '@/lib/tripTotals';

type Message = {
  id: number;
  role: 'user' | 'ai';
  content: string;
  /** Present on AI messages that carry a proposal card (date_shift only). */
  proposal?: ChatProposal;
  /** UI state for proposal cards so Accept/Reject hide the buttons. */
  proposalState?: 'pending' | 'accepted' | 'rejected';
  /** Present on AI messages that carry an inline flight-vs-train comparison. */
  comparison?: ModeComparison;
  /**
   * The opening lines. Their amounts are group totals fixed when the panel
   * opened, and are worded at render time (`messageText`) so they read in
   * the unit the Total / Per person toggle shows, like every other price.
   */
  intro?: { kind: 'greeting'; cities: number; savings: number } | { kind: 'shiftTip'; text: string; savings: number };
};

/**
 * What a message says, in the unit the price toggle shows. The greeting's
 * baseline is the optimizer's: the cities in the order they were given
 * (optimizer.ts savingsVsNaive), not a "most common routing".
 */
function messageText(m: Message, priceMode: 'total' | 'perPerson', travelers: number): string {
  if (!m.intro) return m.content;
  const perPerson = priceMode === 'perPerson' && travelers > 1;
  const amount = `$${displayAmount(m.intro.savings, priceMode, travelers).toLocaleString()}${perPerson ? ' per person' : ''}`;
  if (m.intro.kind === 'shiftTip') return `${m.intro.text} would save about ${amount}.`;
  return m.intro.savings > 0
    ? `I built this ${m.intro.cities}-city trip to save you ${amount} vs your original city order. Ask me anything — pin cities to specific dates, set travel-time constraints, or ask why I ordered things this way.`
    : `You're working on a ${m.intro.cities}-city trip. Ask me anything — swap transports, shift dates, rework a city, or ask why things are ordered this way.`;
}

type AIChatPanelProps = {
  trip: Trip;
  /**
   * Where applied edits go. Defaults to the global trip store (results
   * page). The canvas passes its own handler so chat edits land in the
   * canvas's local state (unsaved-changes tracking, realtime broadcast)
   * instead of the store.
   */
  onTripUpdate?: (trip: Trip) => void;
  /**
   * Freshest trip snapshot for mutations that patch the CURRENT state
   * (leg refreshes). Defaults to reading the trip store. The canvas
   * passes a reader over its live local state.
   */
  getLatestTrip?: () => Trip | null;
};

/**
 * Rule-based fallback suggestions used ONLY if the backend call fails.
 * Normally the backend returns Claude-tailored prompts on mount. Kept
 * trip-aware so the chip row never looks generic.
 */
function fallbackSuggestions(trip: Trip): string[] {
  const cities = trip.cities.map((c) => c.name);
  if (cities.length === 0) return ['Why this order?', 'How can I save money?', 'Add a rest day', 'Swap a city'];
  const first = cities[0];
  const last = cities[cities.length - 1];
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

/**
 * The chips for a trip, kept for this tab so a reload doesn't buy them again.
 *
 * Each set costs an AI call and a slot of the 30-per-15-minutes limit on
 * /api/plan. Once the results page survives a reload (restoreTripSession),
 * asking again on that mount would pay twice for the four chips that were
 * already on screen, out of a rate limit a demo shares with everything else.
 *
 * Read back ONLY for a trip restored after a reload; every other mount asks,
 * exactly as it always has. Keyed by what the chips are written about ("Why
 * Hotel Levell for Amsterdam?"): the party, home, each stop with its dates,
 * chosen stay and onward mode, so a restored trip that differs in any of
 * those still asks. Only an answer is kept (the server's own fallback list
 * counts, since the client cannot tell it apart); a failed request leaves
 * nothing behind. sessionStorage, so it ends with the tab.
 */
const SUGGESTIONS_STORAGE_KEY = 'bluemurr-chat-suggestions';

function suggestionsKey(trip: Trip): string {
  return JSON.stringify([
    trip.travelers,
    trip.origin?.city ?? null,
    trip.cities.map((c) => [
      c.name,
      c.dates?.arrival ?? null,
      c.dates?.departure ?? null,
      c.customHotel?.name ?? c.hotel?.name ?? null,
      c.transportOut?.mode ?? null,
    ]),
  ]);
}

function readCachedSuggestions(key: string): string[] | null {
  try {
    const raw = window.sessionStorage.getItem(SUGGESTIONS_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    const list = saved?.key === key ? saved.suggestions : null;
    return Array.isArray(list) && list.length > 0 && list.every((s) => typeof s === 'string')
      ? list
      : null;
  } catch {
    return null; // storage blocked or unreadable — ask the server, as before
  }
}

function cacheSuggestions(key: string, suggestions: string[]) {
  try {
    window.sessionStorage.setItem(SUGGESTIONS_STORAGE_KEY, JSON.stringify({ key, suggestions }));
  } catch {
    // Full or blocked — the next mount simply asks again.
  }
}

/** Short date like "Mar 5" from YYYY-MM-DD. */
function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Map a LegOption from the chat API into the Transport shape the
 * flowchart's Connector already renders. Keeps the data flow simple:
 * chat returns options → we convert → push into the city's transportOut
 * (alternatives array + main), and the UI reacts.
 */
function legOptionToTransport(opt: LegOption, fromCity: string, toCity: string, date: string): Transport {
  return {
    mode: opt.mode,
    operator: opt.operator,
    duration: opt.duration,
    price: opt.price,
    from: fromCity,
    to: toCity,
    departTime: opt.departTime ?? undefined,
    arriveTime: opt.arriveTime ?? undefined,
    departDate: date,
    layovers: opt.stops ?? 0,
    bookingUrl: opt.bookingUrl ?? undefined,
    flightNumber: opt.mode === 'flight' ? (opt.flightNumber ?? undefined) : undefined,
    trainNumber: opt.mode === 'train' ? (opt.flightNumber ?? undefined) : undefined,
  };
}

/**
 * Apply a LegRefresh to the current trip: find the matching leg by
 * city names, set the cheapest new option as the main transport, stash
 * the rest as alternatives. Also mirrors the new transport onto the
 * destination city's transportIn so the flowchart's Connector stays
 * in sync on both ends.
 *
 * Returns a new Trip object (does not mutate the input).
 */
function applyLegRefreshToTrip(trip: Trip, refresh: LegRefresh): Trip {
  // The leg is a CONSECUTIVE pair, the same one the backend priced
  // (plan.ts findTripLeg takes the first i with cities[i] = from and
  // cities[i+1] = to). Two independent findIndex calls used to pick the
  // ends separately, so on Rome → Florence → Rome a refresh of
  // Florence → Rome mirrored the new train onto the FIRST Rome, and a pair
  // that is no leg at all was patched anyway. Not a leg → change nothing.
  const from = refresh.fromCity.toLowerCase();
  const to = refresh.toCity.toLowerCase();
  const fromIdx = trip.cities.findIndex(
    (c, i) =>
      i + 1 < trip.cities.length &&
      c.name.toLowerCase() === from &&
      trip.cities[i + 1].name.toLowerCase() === to,
  );
  if (fromIdx < 0) return trip;
  const toIdx = fromIdx + 1;

  const [cheapest, ...rest] = refresh.options;
  if (!cheapest) return trip;

  const altTransports = rest.map((o) =>
    legOptionToTransport(o, refresh.fromCity, refresh.toCity, refresh.date),
  );
  // The backend lists the leg's CURRENT transport first, at priceDelta 0
  // (plan.ts transportToLegOption; isSameLegOption is the same test as
  // here). Rebuilding it from a LegOption would drop what a LegOption
  // cannot carry — `noTrainData`, stations, baggage — so when the best
  // option is the one already on the card, keep the card's own copy and
  // refresh only its alternatives.
  const current = trip.cities[fromIdx].transportOut;
  const isCurrent =
    !!current &&
    cheapest.priceDelta === 0 &&
    cheapest.mode === current.mode &&
    cheapest.operator === current.operator &&
    cheapest.departTime === (current.departTime ?? null) &&
    Math.abs(cheapest.price - current.price) < 0.01;
  const mainTransport: Transport = isCurrent
    ? { ...current }
    : legOptionToTransport(cheapest, refresh.fromCity, refresh.toCity, refresh.date);
  mainTransport.alternatives = altTransports;

  const nextCities = trip.cities.map((c, i) => {
    if (i === fromIdx) {
      return { ...c, transportOut: mainTransport };
    }
    if (i === toIdx) {
      // transportIn mirrors (without its own nested alternatives — the
      // origin city owns the alternatives list).
      const { alternatives: _alts, ...flat } = mainTransport;
      return { ...c, transportIn: flat };
    }
    return c;
  });

  return {
    ...trip,
    constraints: refresh.updatedConstraints ?? trip.constraints,
    cities: nextCities,
  } as Trip;
}

export default function AIChatPanel({ trip, onTripUpdate, getLatestTrip }: AIChatPanelProps) {
  const setTrip = useTripStore((s) => s.setTrip);

  // Host-provided sinks with trip-store defaults — the results page uses
  // the store; the canvas injects its local-state handlers.
  const applyTrip = useCallback(
    (t: Trip) => {
      if (onTripUpdate) onTripUpdate(t);
      else setTrip(t);
    },
    [onTripUpdate, setTrip],
  );
  const latestTrip = useCallback(
    (): Trip | null =>
      getLatestTrip ? getLatestTrip() : useTripStore.getState().currentTrip,
    [getLatestTrip],
  );

  const [messages, setMessages] = useState<Message[]>(() => {
    const initial: Message[] = [
      {
        id: 0,
        role: 'ai',
        content: '',
        intro: { kind: 'greeting', cities: trip.cities.length, savings: trip.savings },
      },
    ];
    // Date-shift savings tip — used to be a page banner above the flowchart;
    // it now arrives here so the cards keep the full page height. Purely
    // informational (replan flow isn't wired yet), same as the old banner.
    const shift = trip.dateShiftSuggestion;
    if (shift && shift.savings > 0) {
      const [y, m, d] = shift.newStartDate.split('-').map(Number);
      const nice = new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const dir = shift.dayOffset < 0 ? 'earlier' : 'later';
      const n = Math.abs(shift.dayOffset);
      initial.push({
        id: 1,
        role: 'ai',
        content: '',
        intro: { kind: 'shiftTip', text: `💡 Heads up — starting ${n} day${n === 1 ? '' : 's'} ${dir} (${nice})`, savings: shift.savings },
      });
    }
    return initial;
  });
  const priceMode = useTripStore((s) => s.priceMode);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(fallbackSuggestions(trip));
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const idRef = useRef(2);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const key = suggestionsKey(trip);
    const cached = useTripStore.getState().restoredFromSession ? readCachedSuggestions(key) : null;
    if (cached) {
      setSuggestions(cached);
      setSuggestionsLoaded(true);
      return;
    }
    let cancelled = false;
    planChatSuggestions({ currentTrip: trip })
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.suggestions) && res.suggestions.length > 0) {
          setSuggestions(res.suggestions);
          cacheSuggestions(key, res.suggestions);
        }
        setSuggestionsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setSuggestionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
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

    // Build history from current text messages only (proposal cards are UI state).
    const history: ChatTurn[] = messages
      .filter((m) => !m.proposal)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: messageText(m, priceMode, trip.travelers) }));

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    try {
      const result = await planChat({ message: trimmed, currentTrip: trip, history });

      if (result.type === 'leg_refresh') {
        // The chat wants to update the transport card directly — no inline
        // card, just a summary + the card shows new options. Patch the
        // FRESHEST trip state (store on results, local state on canvas).
        const currentTrip = latestTrip();
        if (currentTrip) {
          applyTrip(applyLegRefreshToTrip(currentTrip, result.refresh));
        }
        setMessages((prev) => [
          ...prev,
          { id: idRef.current++, role: 'ai', content: result.reply },
        ]);
      } else if (result.type === 'mode_comparison') {
        // Inline side-by-side card. No trip mutation — the user can
        // click "Show on card" to switch, which re-prompts the chat
        // with show_transport_options for the actual swap.
        setMessages((prev) => [
          ...prev,
          {
            id: idRef.current++,
            role: 'ai',
            content: result.reply,
            comparison: result.comparison,
          },
        ]);
      } else if (result.type === 'proposal') {
        setMessages((prev) => [
          ...prev,
          {
            id: idRef.current++,
            role: 'ai',
            content: result.reply,
            proposal: result.proposal,
            proposalState: 'pending',
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { id: idRef.current++, role: 'ai', content: result.reply },
        ]);
      }
    } catch {
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
  }, [isTyping, trip, messages, applyTrip, latestTrip, priceMode]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSend(input);
  };

  const acceptProposal = (messageId: number) => {
    // Applied here, not inside the setMessages updater: an updater runs
    // during render (twice under StrictMode), and applying the trip there
    // updated the page that hosts this panel mid-render.
    const msg = messages.find((m) => m.id === messageId);
    if (!msg?.proposal || msg.proposalState === 'accepted') return;
    // date_shift is the only proposal kind now — apply the prebuilt trip.
    applyTrip(msg.proposal.proposedTrip as Trip);
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, proposalState: 'accepted' } : m)),
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
          <div className="text-white text-sm font-medium leading-tight">BlueMurr AI</div>
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
              <div
                className={`max-w-[88%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user' ? 'text-gray-900 rounded-br-md' : 'text-gray-700 rounded-bl-md'
                }`}
                style={{
                  background: msg.role === 'user' ? 'rgba(46,107,196,0.12)' : 'rgba(0,0,0,0.03)',
                  border: msg.role === 'user' ? '1px solid rgba(46,107,196,0.2)' : '1px solid rgba(0,0,0,0.06)',
                }}
              >
                {messageText(msg, priceMode, trip.travelers)}
              </div>

              {/* Proposal card — only for date_shift (pin/min-days).
                  Transport changes now refresh the flowchart card directly
                  and don't render an inline card here. */}
              {msg.proposal && msg.proposal.kind === 'date_shift' && (
                <DateShiftProposalCard
                  proposal={msg.proposal}
                  state={msg.proposalState ?? 'pending'}
                  onAccept={() => acceptProposal(msg.id)}
                  onReject={() => rejectProposal(msg.id)}
                />
              )}

              {/* Inline flight-vs-train comparison card. Informational —
                  the "Show on card" button asks chat to switch which fires
                  show_transport_options under the hood. */}
              {msg.comparison && (
                <ModeComparisonCard
                  comparison={msg.comparison}
                  currentMode={legMode(trip, msg.comparison.fromCity, msg.comparison.toCity)}
                  onSwitch={(mode) => {
                    const c = msg.comparison!;
                    handleSend(
                      `Switch ${c.fromCity} → ${c.toCity} to ${mode === 'flight' ? 'flights' : 'trains'}.`,
                    );
                  }}
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

      {/* Suggested prompts — visible until the user sends their first
          message. Counting messages breaks when the date-shift savings tip
          adds a second assistant bubble on load. */}
      {!messages.some((m) => m.role === 'user') && (
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

// ─── Date-shift proposal card ───────────────────────────────
// Only rendered for pin_city_dates / set_min_days. These move multiple
// cities at once, so we keep the Accept/Reject gate. Transport changes
// (set_transport_window / show_transport_options) bypass this entirely
// and update the flowchart card directly via leg_refresh.
type DateShiftProposalCardProps = {
  proposal: Extract<ChatProposal, { kind: 'date_shift' }>;
  state: 'pending' | 'accepted' | 'rejected';
  onAccept: () => void;
  onReject: () => void;
};

function DateShiftProposalCard({
  proposal,
  state,
  onAccept,
  onReject,
}: DateShiftProposalCardProps) {
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
        <div className="text-[12px] font-medium text-gray-900">Proposed date change</div>
      </div>

      <div className="px-4 py-3">
        {proposal.diff.length === 0 ? (
          <div className="text-[12px] text-gray-500">No date changes — constraint saved.</div>
        ) : (
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
          </div>
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

// ─── Mode-comparison card (flight vs train, inline in chat) ─────
// Triggered by Claude's `compare_modes` tool. Read-only summary of
// best flight + best train side-by-side. Each side has a "Switch to
// this" button that re-prompts the chat with a show_transport_options
// request — the user opts into the actual trip mutation.
type ModeComparisonCardProps = {
  comparison: ModeComparison;
  /** The mode the leg uses now — never offered as a switch. Null when the
   *  leg has no option (or is not found), so either found mode is offered. */
  currentMode: 'flight' | 'train' | null;
  onSwitch: (mode: 'flight' | 'train') => void;
};

/**
 * The mode a trip leg uses now: the consecutive pair `from` → `to` (the leg
 * plan.ts findTripLeg compares). A leg nothing was found for is `unavailable`
 * and its 'flight' is the empty placeholder's, so it has no mode.
 */
function legMode(trip: Trip, from: string, to: string): 'flight' | 'train' | null {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  const i = trip.cities.findIndex(
    (c, k) => k + 1 < trip.cities.length && c.name.toLowerCase() === f && trip.cities[k + 1].name.toLowerCase() === t,
  );
  const leg = i >= 0 ? trip.cities[i].transportOut : null;
  return leg && !leg.unavailable ? leg.mode : null;
}

function ModeComparisonCard({ comparison, currentMode, onSwitch }: ModeComparisonCardProps) {
  const { flight, train, recommendation, cheapest, fastest } = comparison;

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
        <ArrowRight size={14} style={{ color: '#2e6bc4' }} />
        <div className="text-[12px] font-medium text-gray-900">
          {comparison.fromCity} → {comparison.toCity}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-0">
        <ModeCell
          label="Flight"
          icon={<Plane size={13} />}
          option={flight}
          isCheapest={cheapest === 'flight'}
          isFastest={fastest === 'flight'}
          isRecommended={recommendation === 'flight'}
          isCurrent={currentMode === 'flight'}
          onClick={() => onSwitch('flight')}
        />
        <div className="border-l border-gray-100" />
        <ModeCell
          label="Train"
          icon={<TrainFront size={13} />}
          option={train}
          isCheapest={cheapest === 'train'}
          isFastest={fastest === 'train'}
          isRecommended={recommendation === 'train'}
          isCurrent={currentMode === 'train'}
          onClick={() => onSwitch('train')}
        />
      </div>
    </motion.div>
  );
}

type ModeCellProps = {
  label: string;
  icon: React.ReactNode;
  option: ModeComparison['flight'];
  isCheapest: boolean;
  isFastest: boolean;
  isRecommended: boolean;
  /** The leg already uses this mode: no "Switch to" for it. */
  isCurrent: boolean;
  onClick: () => void;
};

function ModeCell({
  label,
  icon,
  option,
  isCheapest,
  isFastest,
  isRecommended,
  isCurrent,
  onClick,
}: ModeCellProps) {
  if (!option) {
    return (
      <div className="px-3 py-3 col-span-1 flex flex-col items-start gap-1">
        <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
          {icon}
          {label}
        </div>
        <div className="text-[12px] text-gray-400 italic">No options found</div>
      </div>
    );
  }

  return (
    <div className="px-3 py-3 col-span-1 flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
        {icon}
        {label}
        {isRecommended && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
            style={{ background: 'rgba(46,107,196,0.12)', color: '#2e6bc4' }}
          >
            Best pick
          </span>
        )}
      </div>
      <div className="text-[14px] font-semibold text-gray-900">
        {/* A price the provider did not give is unknown, not $0. */}
        {option.price > 0 ? `$${Math.round(option.price).toLocaleString()}` : '—'}
        {isCheapest && (
          <span className="ml-1 text-[10px] text-emerald-600 font-medium">cheapest</span>
        )}
      </div>
      <div className="text-[11px] text-gray-500">
        {option.duration}
        {isFastest && <span className="ml-1 text-emerald-600 font-medium">fastest</span>}
      </div>
      <div className="text-[11px] text-gray-400 truncate w-full">{option.operator}</div>
      {!isCurrent && (
        <button
          onClick={onClick}
          className="mt-1 text-[11px] font-medium px-2 py-1 rounded-md transition"
          style={{
            background: 'rgba(46,107,196,0.08)',
            color: '#2e6bc4',
            border: '1px solid rgba(46,107,196,0.2)',
          }}
        >
          Switch to {label.toLowerCase()}
        </button>
      )}
    </div>
  );
}
