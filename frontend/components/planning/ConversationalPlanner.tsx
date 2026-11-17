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
  LocateFixed,
  Loader2,
} from 'lucide-react';
import { converse, ConverseResponse } from '@/lib/api';
import { useTripStore } from '@/store/tripStore';
import { humanDay, humanDayRange } from '@/lib/dateHelpers';
import VibePills from './VibePills';
import BudgetPicker from './BudgetPicker';
import TripSummaryCard from './TripSummaryCard';
import { CHAT_EDIT_PREFILL } from '@/lib/tripSummary';
import { dedupeVibes, joinVibes, splitVibeText, vibeBubbleText, vibeList, vibePhrase } from '@/lib/vibes';

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
import { useConversationalPlanner } from './useConversationalPlanner';
export default function ConversationalPlanner({
  seedMessage,
  onFindTrip,
  findTripLoading,
  findTripStatus,
  findTripError,
  onSwitchToGuided,
}: ConversationalPlannerProps) {
  const {
    answers,
    setAnswer,
    messages,
    input,
    setInput,
    inputRef,
    isTyping,
    widget,
    setWidget,
    vibeDraft,
    setVibeDraft,
    showRecap,
    quickReplies,
    failCount,
    cityPicker,
    setCityPicker,
    scrollRef,
    send,
    locating,
    handleUseMyLocation,
    submitCityPicker,
    recapRows,
    meetsMinimums,
  } = useConversationalPlanner(seedMessage);

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
                      ? 'bg-[#2563eb] text-white rounded-br-md'
                      : 'text-gray-800 rounded-bl-md'
                  }`}
                  style={msg.role === 'assistant' ? { background: '#ffffff', boxShadow: 'inset 0 0 0 1px #e5e7eb' } : undefined}
                >
                  {msg.content}
                </div>

                {/* Failed send → honest reason + Retry */}
                {msg.failed && (
                  <div className="flex items-center gap-3 mt-2">
                    <span className="flex items-center gap-1.5 text-[13px] text-red-600">
                      <WifiOff size={13} />
                      {msg.failed === 'network'
                        ? "Can't reach the server"
                        : 'The assistant is unavailable right now'}
                    </span>
                    <button
                      onClick={() => send(msg.content, { retryOfId: msg.id })}
                      className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[13px] font-medium text-white transition-all hover:brightness-110"
                      style={{ background: '#2563eb' }}
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
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-gray-500 text-[15px]">
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-gray-400"
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
              className="self-center flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200 text-gray-700 hover:text-gray-900 text-[14px] transition-all"
              style={{ background: '#ffffff' }}
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
                  <span className="text-gray-600 text-[14px]">{c.country}</span>
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
                                ? 'bg-[#2563eb] border-[#2563eb] text-white'
                                : 'border-gray-200 text-gray-700 hover:border-[#2563eb]/50'
                            }`}
                            style={!on ? { background: '#ffffff' } : undefined}
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
                        className="px-3.5 py-2 rounded-full text-[14px] bg-white border border-dashed border-gray-300 text-gray-800 placeholder-gray-500 outline-none focus:border-[#2563eb]/60 w-[170px]"
                      />
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={submitCityPicker}
                disabled={Object.values(cityPicker.selected).flat().length === 0}
                className="self-start flex items-center gap-2 px-5 py-2.5 rounded-xl text-[15px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
                style={{ background: '#2563eb' }}
              >
                <Plus size={15} />
                Add these cities
              </button>
            </motion.div>
          )}

          {/* ── Vibe widget ── */}
          {widget === 'vibe' && (
            <VibePills
              selected={vibeDraft}
              onChange={setVibeDraft}
              onContinue={() => {
                const picked = dedupeVibes(vibeDraft);
                if (picked.length === 0) return;
                // Stored as picked, whatever the AI makes of the sentence.
                setAnswer('vibes', picked);
                setAnswer('vibe', joinVibes(picked));
                setWidget(null);
                setVibeDraft([]);
                send(`${vibeBubbleText(picked)} vibes`);
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
              className="rounded-2xl border border-[#2563eb]/25 p-5 flex flex-col gap-3"
              style={{ background: '#eef3fb' }}
            >
              <span className="text-gray-600 text-[12px] uppercase tracking-[0.18em] font-medium">
                Your trip so far
              </span>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                {recapRows.map((row) => {
                  const Icon = row.icon;
                  return (
                    <div key={row.label} className="flex items-start gap-2.5">
                      <Icon size={14} className="text-[#2563eb] mt-1 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-gray-600 text-[11px]">{row.label}</div>
                        <div className="text-gray-900 text-[14px] truncate" title={row.value}>
                          {row.value}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-gray-600 text-[13px]">
                  Want to change anything? Just say it.
                </span>
                <button
                  onClick={onFindTrip}
                  className="px-6 py-2.5 rounded-xl text-[15px] font-semibold text-white transition-all hover:brightness-110 hover:scale-[1.02] active:scale-[0.98]"
                  style={{ background: '#2563eb' }}
                >
                  Find my trip →
                </button>
              </div>
            </motion.div>
          )}

          {/* Find-trip progress / error (same pipeline as before) */}
          {findTripLoading && (
            <div className="flex items-center gap-3 text-gray-600 text-[15px]">
              <motion.div
                className="w-4 h-4 border-2 border-[#2563eb] border-t-transparent rounded-full"
                animate={{ rotate: 360 }}
                transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
              />
              {findTripStatus || 'Finding the best routes…'}
            </div>
          )}
          {findTripError && (
            <div className="text-red-600 text-[14px]">{findTripError}</div>
          )}
        </div>
      </div>

      {/* ── Quick replies + input bar ── */}
      <div className="relative z-10 flex-shrink-0 px-6 pb-6">
        <div className="max-w-3xl mx-auto flex flex-col gap-3">
          {/* Running trip summary — hidden until the first answer, and once the
              recap card (the same facts, in full) takes over. Clicking a fact
              starts the revision in the input: this planner already
              understands "change the budget to …". */}
          {!showRecap && !findTripLoading && (
            <TripSummaryCard
              answers={answers}
              onEdit={(field) => {
                setInput(CHAT_EDIT_PREFILL[field]);
                requestAnimationFrame(() => {
                  const el = inputRef.current;
                  if (el) {
                    el.focus();
                    el.setSelectionRange(el.value.length, el.value.length);
                  }
                });
              }}
              editable={() => !isTyping}
            />
          )}
          {/* Location offer — visible until an origin is known */}
          {!answers.origin && !isTyping && (
            <div className="flex">
              <button
                onClick={handleUseMyLocation}
                disabled={locating}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13.5px] border border-[#2563eb]/30 text-[#2563eb] hover:text-[#1d4ed8] hover:border-[#2563eb]/60 transition-all"
                style={{ background: '#eff6ff' }}
              >
                {locating ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <LocateFixed size={13} />
                )}
                {locating ? 'Finding your nearest airport…' : 'Use my location'}
              </button>
            </div>
          )}
          {quickReplies.length > 0 && !isTyping && (
            <div className="flex flex-wrap gap-2">
              {quickReplies.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="px-3.5 py-1.5 rounded-full text-[13.5px] border border-gray-200 text-gray-700 hover:text-gray-900 hover:border-[#2563eb]/50 transition-all"
                  style={{ background: '#ffffff' }}
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
              // Pills picked and then something typed: the picks go with it
              // rather than vanishing with the widget.
              const picked = widget === 'vibe' ? dedupeVibes(vibeDraft) : [];
              if (picked.length > 0 && v.trim()) {
                setAnswer('vibes', picked);
                setAnswer('vibe', joinVibes(picked));
                setVibeDraft([]);
                send(`${vibeBubbleText(picked)} vibes. ${v.trim()}`);
                return;
              }
              send(v);
            }}
            className="flex items-center gap-2"
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Say anything — destinations, dates, changes of heart…"
              className="flex-1 min-w-0 px-5 py-3.5 rounded-2xl text-[16px] bg-white border border-gray-200 text-gray-900 placeholder-gray-500 outline-none focus:border-[#2563eb]/60 transition-colors"
              disabled={isTyping}
            />
            <button
              type="submit"
              disabled={!input.trim() || isTyping}
              aria-label="Send message"
              className="p-3.5 rounded-2xl text-white transition-all hover:brightness-110 disabled:opacity-30"
              style={{ background: '#2563eb' }}
            >
              <Send size={18} />
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
