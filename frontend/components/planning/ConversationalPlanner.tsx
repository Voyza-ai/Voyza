'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send,
  RotateCcw,
  WifiOff,
  Sparkles,
  MapPin,
  Calendar,
  Users,
  Wallet,
  Home,
  Plus,
  Check,
  ListChecks,
} from 'lucide-react';
import { converse, ConverseResponse } from '@/lib/api';
import { useTripStore } from '@/store/tripStore';
import VibePills from './VibePills';
import BudgetPicker from './BudgetPicker';

type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Failed sends keep the text + show Retry instead of an AI reply. */
  failed?: 'network' | 'assistant';
};

type Widget = 'city_picker' | 'vibe' | 'budget' | null;

type ConversationalPlannerProps = {
  /** First message to send automatically (landing-page hero seed). */
  seedMessage?: string;
  /** The existing find-trip pipeline from PlanningChat. */
  onFindTrip: () => void;
  findTripLoading: boolean;
  findTripStatus: string;
  findTripError: string | null;
  /** Escape hatch when the AI is repeatedly down. */
  onSwitchToGuided: () => void;
};

let idCounter = 0;
const nextId = () => `cp-${Date.now()}-${idCounter++}`;

/**
 * The AI-driven planning conversation. Every user message goes to
 * /api/plan/converse with the full history + known answers; the reply is
 * rendered, extracted facts land in the trip store, and the AI's chosen
 * `action` summons widgets (city picker / vibe pills / budget slider) or
 * the final recap card. Question order is emergent — the AI listens,
 * never marches through a list, and any earlier answer can be changed at
 * any time ("actually make it 3 weeks").
 */
export default function ConversationalPlanner({
  seedMessage,
  onFindTrip,
  findTripLoading,
  findTripStatus,
  findTripError,
  onSwitchToGuided,
}: ConversationalPlannerProps) {
  const answers = useTripStore((s) => s.answers);
  const setAnswer = useTripStore((s) => s.setAnswer);
  const chatHistory = useTripStore((s) => s.chatHistory);
  const setChatHistory = useTripStore((s) => s.setChatHistory);

  // Hydrate from the store so returning from results resumes the
  // conversation instead of starting over (replanning).
  const [messages, setMessages] = useState<ChatMsg[]>(() =>
    chatHistory.length > 0
      ? chatHistory.map((m) => ({ id: nextId(), role: m.role, content: m.content }))
      : [],
  );
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [widget, setWidget] = useState<Widget>(null);
  const [showRecap, setShowRecap] = useState(false);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [failCount, setFailCount] = useState(0);
  const [cityPicker, setCityPicker] = useState<{
    countries: Array<{ country: string; cities: string[] }>;
    selected: Record<string, string[]>;
    custom: Record<string, string>;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentSeedRef = useRef(false);
  // Source of truth for handlers: React state updaters run at render time,
  // AFTER the fetch below would fire — reading history out of an updater
  // sent EMPTY history on every turn (the model kept losing the thread).
  const messagesRef = useRef<ChatMsg[]>(messages);

  // Keep the store's chatHistory in sync (successful turns only) so the
  // conversation survives navigation to/from results.
  const syncStore = useCallback(
    (msgs: ChatMsg[]) => {
      setChatHistory(
        msgs.filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content })),
      );
    },
    [setChatHistory],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isTyping, widget, showRecap]);

  /** Known-state snapshot the backend uses to avoid re-asking. */
  const knownState = useCallback(() => {
    const a = useTripStore.getState().answers;
    return {
      destinations: a.destinations ?? undefined,
      origin: a.origin ?? null,
      dates: a.dateRange ?? null,
      travelers: a.travelers ?? null,
      budget: a.budget ?? null,
      budgetPerPerson: a.budgetPerPerson ?? null,
      vibe: a.vibe ?? null,
      returnToHome: a.returnToHome ?? null,
      notes: a.extraNotes ?? null,
    };
  }, []);

  const applyUpdates = useCallback(
    (u: ConverseResponse['updates']) => {
      if (u.destinations) setAnswer('destinations', u.destinations);
      if (u.origin !== undefined && u.origin !== null) setAnswer('origin', u.origin);
      if (u.dates) setAnswer('dateRange', u.dates);
      if (u.travelers !== undefined && u.travelers !== null) setAnswer('travelers', u.travelers);
      if (u.budget !== undefined && u.budget !== null) setAnswer('budget', u.budget);
      if (u.budgetPerPerson !== undefined && u.budgetPerPerson !== null)
        setAnswer('budgetPerPerson', u.budgetPerPerson);
      if (u.vibe !== undefined && u.vibe !== null) setAnswer('vibe', u.vibe);
      if (u.returnToHome !== undefined && u.returnToHome !== null)
        setAnswer('returnToHome', u.returnToHome);
      if (u.notes !== undefined && u.notes !== null) setAnswer('extraNotes', u.notes);
      setAnswer('planningMode', 'destination');
    },
    [setAnswer],
  );

  /** Minimum viable trip — mirrors the backend's 'ready' bar, enforced in
   *  code so a hallucinated 'ready' can't slip through. */
  const meetsMinimums = useCallback(() => {
    const a = useTripStore.getState().answers;
    return Boolean(a.destinations?.length && a.dateRange?.start && a.dateRange?.end && a.travelers);
  }, []);

  const send = useCallback(
    async (text: string, opts?: { retryOfId?: string }) => {
      const trimmed = text.trim();
      if (!trimmed || isTyping) return;

      setIsTyping(true);
      setQuickReplies([]);
      setWidget(null);
      setShowRecap(false);

      const base = messagesRef.current;
      const nextMsgs: ChatMsg[] = opts?.retryOfId
        ? base.map((m) => (m.id === opts.retryOfId ? { ...m, failed: undefined } : m))
        : [...base, { id: nextId(), role: 'user', content: trimmed }];
      messagesRef.current = nextMsgs;
      setMessages(nextMsgs);

      try {
        const history = nextMsgs
          .filter((m) => !m.failed)
          .slice(0, -1)
          .map((m) => ({ role: m.role, content: m.content }));

        const result = await converse({
          message: trimmed,
          history,
          known: knownState(),
        });

        applyUpdates(result.updates);
        setFailCount(0);

        const withReply = [
          ...messagesRef.current,
          { id: nextId(), role: 'assistant' as const, content: result.reply },
        ];
        messagesRef.current = withReply;
        setMessages(withReply);
        syncStore(withReply);
        setQuickReplies(result.quickReplies ?? []);

        // The AI's chosen next step → UI. Widget-summons for a field the
        // user JUST answered (or that's already known) are suppressed —
        // belt-and-braces against the model echoing a picker back at an
        // answer ("culture vibes" must never re-open the vibe pills).
        const a = useTripStore.getState().answers;
        if (result.action === 'show_city_picker' && result.updates.countries?.length) {
          setCityPicker({
            countries: result.updates.countries,
            selected: Object.fromEntries(result.updates.countries.map((c) => [c.country, []])),
            custom: {},
          });
          setWidget('city_picker');
        } else if (result.action === 'show_vibe_picker' && !a.vibe) {
          setWidget('vibe');
        } else if (result.action === 'show_budget_slider' && a.budget == null) {
          setWidget('budget');
        } else if (meetsMinimums() && (result.action === 'ready' || result.action === 'show_vibe_picker' || result.action === 'show_budget_slider')) {
          // Suppressed a redundant widget (or genuine ready) with a complete
          // plan on the table → recap.
          setShowRecap(true);
        }
      } catch (err: any) {
        const isNetwork = err?.message?.includes('fetch') || err?.name === 'TypeError';
        setFailCount((n) => n + 1);
        const marked = messagesRef.current.map((m, i, arr) =>
          i === arr.length - 1 && m.role === 'user'
            ? { ...m, failed: (isNetwork ? 'network' : 'assistant') as ChatMsg['failed'] }
            : m,
        );
        messagesRef.current = marked;
        setMessages(marked);
      } finally {
        setIsTyping(false);
      }
    },
    [isTyping, knownState, applyUpdates, meetsMinimums, syncStore],
  );

  // Seed from the landing hero (or greet) — once.
  useEffect(() => {
    if (sentSeedRef.current) return;
    sentSeedRef.current = true;
    if (seedMessage) {
      send(seedMessage);
    } else if (messages.length === 0) {
      const greeting: ChatMsg[] = [
        {
          id: nextId(),
          role: 'assistant',
          content:
            "Tell me about the trip you're dreaming of — where, when, who's coming, budget… in whatever order it comes out. I'm listening.",
        },
      ];
      messagesRef.current = greeting;
      setMessages(greeting);
    } else if (meetsMinimums()) {
      // Resumed with a complete plan (came back from results to tweak).
      setShowRecap(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Widget submit paths (feed back through the conversation) ──
  const submitCityPicker = () => {
    if (!cityPicker) return;
    const picked = Object.values(cityPicker.selected).flat();
    if (picked.length === 0) return;
    setCityPicker(null);
    send(`Let's do ${picked.join(', ')}`);
  };

  const a = answers;
  const recapRows: Array<{ icon: typeof MapPin; label: string; value: string }> = [
    { icon: MapPin, label: 'Cities', value: (a.destinations ?? []).join(' → ') || '—' },
    {
      icon: Calendar,
      label: 'Dates',
      value: a.dateRange?.start ? `${a.dateRange.start} → ${a.dateRange.end}` : '—',
    },
    { icon: Users, label: 'Travelers', value: a.travelers ? String(a.travelers) : '—' },
    {
      icon: Wallet,
      label: 'Budget',
      value: a.budget
        ? `$${a.budget.toLocaleString()} ${a.budgetPerPerson ? 'per person' : 'total'}`
        : 'No limit set',
    },
    { icon: Home, label: 'From', value: a.origin ?? 'Not set' },
    { icon: Sparkles, label: 'Vibe', value: a.vibe ?? 'Open' },
  ];

  return (
    <>
      {/* ── Conversation ── */}
      <div ref={scrollRef} className="relative z-10 flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        <div className="max-w-3xl mx-auto flex flex-col gap-5 pt-6">
          <AnimatePresence mode="popLayout">
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[80%] px-5 py-3.5 text-[17px] leading-relaxed rounded-2xl ${
                    msg.role === 'user'
                      ? 'bg-[#4f8ef7] text-white rounded-br-md'
                      : 'text-white/90 rounded-bl-md'
                  }`}
                  style={msg.role === 'assistant' ? { background: 'rgba(255,255,255,0.05)' } : undefined}
                >
                  {msg.content}
                </div>

                {/* Failed send → honest reason + Retry */}
                {msg.failed && (
                  <div className="flex items-center gap-3 mt-2">
                    <span className="flex items-center gap-1.5 text-[13px] text-red-300/80">
                      <WifiOff size={13} />
                      {msg.failed === 'network'
                        ? "Can't reach the server"
                        : 'The assistant is unavailable right now'}
                    </span>
                    <button
                      onClick={() => send(msg.content, { retryOfId: msg.id })}
                      className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[13px] font-medium text-white transition-all hover:brightness-110"
                      style={{ background: '#4f8ef7' }}
                    >
                      <RotateCcw size={12} />
                      Retry
                    </button>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Typing */}
          {isTyping && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-white/40 text-[15px]">
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-white/40"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
                  />
                ))}
              </span>
            </motion.div>
          )}

          {/* Repeated AI failures → guided fallback */}
          {failCount >= 3 && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={onSwitchToGuided}
              className="self-center flex items-center gap-2 px-4 py-2 rounded-xl border border-white/15 text-white/70 hover:text-white text-[14px] transition-all"
              style={{ background: 'rgba(255,255,255,0.05)' }}
            >
              <ListChecks size={15} />
              The assistant keeps failing — continue with guided questions instead
            </motion.button>
          )}

          {/* ── City picker widget ── */}
          {widget === 'city_picker' && cityPicker && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4">
              {cityPicker.countries.map((c) => (
                <div key={c.country} className="flex flex-col gap-2">
                  <span className="text-white/50 text-[14px]">{c.country}</span>
                  <div className="flex flex-wrap gap-2">
                    {[...c.cities, ...(cityPicker.selected[c.country] ?? []).filter((x) => !c.cities.includes(x))].map(
                      (city) => {
                        const on = (cityPicker.selected[c.country] ?? []).includes(city);
                        return (
                          <button
                            key={city}
                            onClick={() =>
                              setCityPicker((prev) => {
                                if (!prev) return prev;
                                const cur = prev.selected[c.country] ?? [];
                                return {
                                  ...prev,
                                  selected: {
                                    ...prev.selected,
                                    [c.country]: on ? cur.filter((x) => x !== city) : [...cur, city],
                                  },
                                };
                              })
                            }
                            className={`px-4 py-2 rounded-full text-[15px] border transition-all hover:scale-[1.04] ${
                              on
                                ? 'bg-[#4f8ef7] border-[#4f8ef7] text-white'
                                : 'border-white/15 text-white/70 hover:border-[#4f8ef7]/50'
                            }`}
                            style={!on ? { background: 'rgba(255,255,255,0.04)' } : undefined}
                          >
                            {on && <Check size={13} className="inline mr-1.5 -mt-0.5" />}
                            {city}
                          </button>
                        );
                      },
                    )}
                    {/* custom city input */}
                    <div className="flex items-center gap-1">
                      <input
                        value={cityPicker.custom[c.country] ?? ''}
                        onChange={(e) =>
                          setCityPicker((prev) =>
                            prev ? { ...prev, custom: { ...prev.custom, [c.country]: e.target.value } } : prev,
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          const raw = (cityPicker.custom[c.country] ?? '').trim();
                          if (!raw) return;
                          setCityPicker((prev) => {
                            if (!prev) return prev;
                            const cur = prev.selected[c.country] ?? [];
                            return {
                              ...prev,
                              selected: { ...prev.selected, [c.country]: [...cur, raw] },
                              custom: { ...prev.custom, [c.country]: '' },
                            };
                          });
                        }}
                        placeholder="Type another city…"
                        className="px-3.5 py-2 rounded-full text-[14px] bg-transparent border border-dashed border-white/20 text-white/80 placeholder-white/25 outline-none focus:border-[#4f8ef7]/60 w-[170px]"
                      />
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={submitCityPicker}
                disabled={Object.values(cityPicker.selected).flat().length === 0}
                className="self-start flex items-center gap-2 px-5 py-2.5 rounded-xl text-[15px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
                style={{ background: '#4f8ef7' }}
              >
                <Plus size={15} />
                Add these cities
              </button>
            </motion.div>
          )}

          {/* ── Vibe widget ── */}
          {widget === 'vibe' && (
            <VibePills
              onSelect={(v) => {
                setWidget(null);
                send(`${v} vibes`);
              }}
            />
          )}

          {/* ── Budget slider widget ── */}
          {widget === 'budget' && (
            <BudgetPicker
              onSelect={(amount, perPerson) => {
                setWidget(null);
                send(`Budget is $${amount.toLocaleString()} ${perPerson ? 'per person' : 'total'}`);
              }}
              onSkip={() => {
                setWidget(null);
                send('No budget limit — skip that');
              }}
            />
          )}

          {/* ── Recap card + Find my trip (never auto-runs) ── */}
          {showRecap && !findTripLoading && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-[#4f8ef7]/30 p-5 flex flex-col gap-3"
              style={{ background: 'rgba(79,142,247,0.07)' }}
            >
              <span className="text-white/50 text-[12px] uppercase tracking-[0.18em] font-medium">
                Your trip so far
              </span>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                {recapRows.map((row) => {
                  const Icon = row.icon;
                  return (
                    <div key={row.label} className="flex items-start gap-2.5">
                      <Icon size={14} className="text-[#4f8ef7] mt-1 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-white/35 text-[11px]">{row.label}</div>
                        <div className="text-white/90 text-[14px] truncate" title={row.value}>
                          {row.value}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-white/35 text-[13px]">
                  Want to change anything? Just say it.
                </span>
                <button
                  onClick={onFindTrip}
                  className="px-6 py-2.5 rounded-xl text-[15px] font-semibold text-white transition-all hover:brightness-110 hover:scale-[1.02] active:scale-[0.98]"
                  style={{ background: '#4f8ef7' }}
                >
                  Find my trip →
                </button>
              </div>
            </motion.div>
          )}

          {/* Find-trip progress / error (same pipeline as before) */}
          {findTripLoading && (
            <div className="flex items-center gap-3 text-white/60 text-[15px]">
              <motion.div
                className="w-4 h-4 border-2 border-[#4f8ef7] border-t-transparent rounded-full"
                animate={{ rotate: 360 }}
                transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
              />
              {findTripStatus || 'Finding the best routes…'}
            </div>
          )}
          {findTripError && (
            <div className="text-red-300/90 text-[14px]">{findTripError}</div>
          )}
        </div>
      </div>

      {/* ── Quick replies + input bar ── */}
      <div className="relative z-10 flex-shrink-0 px-6 pb-6">
        <div className="max-w-3xl mx-auto flex flex-col gap-3">
          {quickReplies.length > 0 && !isTyping && (
            <div className="flex flex-wrap gap-2">
              {quickReplies.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="px-3.5 py-1.5 rounded-full text-[13.5px] border border-white/15 text-white/70 hover:text-white hover:border-[#4f8ef7]/50 transition-all"
                  style={{ background: 'rgba(255,255,255,0.04)' }}
                >
                  {q}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = input;
              setInput('');
              send(v);
            }}
            className="flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Say anything — destinations, dates, changes of heart…"
              className="flex-1 min-w-0 px-5 py-3.5 rounded-2xl text-[16px] bg-transparent border border-white/15 text-white placeholder-white/25 outline-none focus:border-[#4f8ef7]/60 transition-colors"
              disabled={isTyping}
            />
            <button
              type="submit"
              disabled={!input.trim() || isTyping}
              aria-label="Send message"
              className="p-3.5 rounded-2xl text-white transition-all hover:brightness-110 disabled:opacity-30"
              style={{ background: '#4f8ef7' }}
            >
              <Send size={18} />
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
