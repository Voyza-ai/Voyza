'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Send,
  RotateCcw,
  WifiOff,
  ListChecks,
  LocateFixed,
  Loader2,
  Check,
  Plus,
  CalendarDays,
} from 'lucide-react';
import { useConversationalPlanner } from '@/components/planning/useConversationalPlanner';
import VibePills from '@/components/planning/VibePills';
import BudgetPicker from '@/components/planning/BudgetPicker';
import { summarizeAnswers, CHAT_EDIT_PREFILL, type SummaryField } from '@/lib/tripSummary';
import { dedupeVibes, joinVibes, vibeBubbleText } from '@/lib/vibes';
import { humanDay } from '@/lib/dateHelpers';
import BottomSheet from './BottomSheet';
import { M } from './theme';

type MobilePlannerProps = {
  seedMessage?: string;
  onFindTrip: () => void;
  findTripLoading: boolean;
  findTripStatus: string;
  findTripError: string | null;
  onSwitchToGuided: () => void;
};

/**
 * The conversational planner, full-screen for a phone. The conversation is
 * the desktop one (useConversationalPlanner → /api/plan/converse, the same
 * answer extraction, the same "where from" and round-trip questions); only
 * the layout differs: quick replies sit above the keyboard, and the city
 * picker, vibes, budget and dates open as bottom sheets.
 */
export default function MobilePlanner({
  seedMessage,
  onFindTrip,
  findTripLoading,
  findTripStatus,
  findTripError,
  onSwitchToGuided,
}: MobilePlannerProps) {
  const p = useConversationalPlanner(seedMessage);
  const [datesOpen, setDatesOpen] = useState(false);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');

  const focusInput = () =>
    requestAnimationFrame(() => {
      const el = p.inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });

  const editField = (field: SummaryField) => {
    if (p.isTyping) return;
    if (field === 'dates') {
      setDateStart(p.answers.dateRange?.start ?? '');
      setDateEnd(p.answers.dateRange?.end ?? '');
      setDatesOpen(true);
      return;
    }
    p.setInput(CHAT_EDIT_PREFILL[field]);
    focusInput();
  };

  const submit = () => {
    const v = p.input;
    p.setInput('');
    // Pills picked and then something typed: the picks go with it.
    const picked = p.widget === 'vibe' ? dedupeVibes(p.vibeDraft) : [];
    if (picked.length > 0 && v.trim()) {
      p.setAnswer('vibes', picked);
      p.setAnswer('vibe', joinVibes(picked));
      p.setVibeDraft([]);
      p.send(`${vibeBubbleText(picked)} vibes. ${v.trim()}`);
      return;
    }
    p.send(v);
  };

  const submitVibes = () => {
    const picked = dedupeVibes(p.vibeDraft);
    if (picked.length === 0) return;
    // Stored as picked, whatever the AI makes of the sentence (as on desktop).
    p.setAnswer('vibes', picked);
    p.setAnswer('vibe', joinVibes(picked));
    p.setWidget(null);
    p.setVibeDraft([]);
    p.send(`${vibeBubbleText(picked)} vibes`);
  };

  const summary = summarizeAnswers(p.answers);
  const summaryParts = summary.flatMap((g) => g.pieces.filter((x): x is { field: SummaryField; text: string } => typeof x !== 'string'));
  const busy = p.isTyping || findTripLoading;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: M.bg }} data-testid="m-planner">
      {/* Top bar */}
      <header
        className="flex-shrink-0 flex items-center gap-1 px-2 bg-white border-b"
        style={{ borderColor: M.line, paddingTop: 'max(8px, env(safe-area-inset-top))', paddingBottom: 8 }}
      >
        <Link href="/m" aria-label="Back to home" className="w-11 h-11 rounded-full flex items-center justify-center text-gray-700 active:bg-gray-100">
          <ArrowLeft size={22} />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="text-[17px] font-semibold text-gray-900 leading-tight">Plan a trip</div>
          <div className="text-[12px] text-gray-500 leading-tight">BlueMurr AI · just talk</div>
        </div>
      </header>

      {/* Conversation */}
      <div ref={p.scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {p.messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  data-role={msg.role}
                  className={`m-bubble max-w-[85%] px-4 py-2.5 text-[16px] leading-snug rounded-[20px] ${
                    msg.role === 'user' ? 'text-white rounded-br-md' : 'text-gray-800 rounded-bl-md bg-white'
                  }`}
                  style={msg.role === 'user' ? { background: M.blue } : { boxShadow: `inset 0 0 0 1px ${M.line}` }}
                >
                  {msg.content}
                </div>
                {msg.failed && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="flex items-center gap-1 text-[13px] text-red-600">
                      <WifiOff size={13} />
                      {msg.failed === 'network' ? "Can't reach the server" : 'The assistant is unavailable'}
                    </span>
                    <button
                      onClick={() => p.send(msg.content, { retryOfId: msg.id })}
                      className="min-h-[36px] flex items-center gap-1 px-3 rounded-full text-[13px] font-medium text-white"
                      style={{ background: M.blue }}
                    >
                      <RotateCcw size={12} /> Retry
                    </button>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {p.isTyping && (
            <div className="flex items-center gap-1 px-4 py-3 bg-white rounded-[20px] rounded-bl-md self-start" style={{ boxShadow: `inset 0 0 0 1px ${M.line}` }} aria-label="BlueMurr is typing">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-gray-400"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
                />
              ))}
            </div>
          )}

          {p.failCount >= 3 && (
            <button
              onClick={onSwitchToGuided}
              className="self-center min-h-[44px] flex items-center gap-2 px-4 rounded-xl border bg-white text-gray-700 text-[14px]"
              style={{ borderColor: M.line }}
            >
              <ListChecks size={15} /> Continue with guided questions instead
            </button>
          )}

          {/* Recap + Find my trip (never auto-runs) */}
          {p.showRecap && !findTripLoading && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border p-4 flex flex-col gap-3"
              style={{ background: M.blueSoft, borderColor: 'rgba(37,99,235,0.25)' }}
              data-testid="m-recap"
            >
              <span className="text-[11px] uppercase tracking-[0.16em] font-semibold text-gray-600">Your trip so far</span>
              <div className="flex flex-col gap-2">
                {p.recapRows.map((row) => {
                  const Icon = row.icon;
                  return (
                    <div key={row.label} className="flex items-center gap-3">
                      <Icon size={15} className="flex-shrink-0" style={{ color: M.blue }} />
                      <span className="w-[72px] flex-shrink-0 text-[13px] text-gray-500">{row.label}</span>
                      <span className="flex-1 min-w-0 text-[15px] text-gray-900 truncate">{row.value}</span>
                    </div>
                  );
                })}
              </div>
              <span className="text-[13px] text-gray-600">Want to change anything? Just say it.</span>
            </motion.div>
          )}

          {findTripLoading && (
            <div className="flex items-center gap-3 text-gray-600 text-[15px] py-2" data-testid="m-searching">
              <Loader2 size={18} className="animate-spin" style={{ color: M.blue }} />
              {findTripStatus || 'Finding the best routes…'}
            </div>
          )}
          {findTripError && <div className="text-red-600 text-[14px]">{findTripError}</div>}
        </div>
      </div>

      {/* Bottom dock: what's known, quick replies, input — above the keyboard */}
      <div
        className="flex-shrink-0 bg-white border-t flex flex-col gap-2 pt-2"
        style={{ borderColor: M.line, paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}
      >
        {summaryParts.length > 0 && !findTripLoading && (
          <div className="flex gap-1.5 overflow-x-auto px-3 scrollbar-hide" data-testid="m-summary" aria-label="Trip so far">
            {summaryParts.map((part) => (
              <button
                key={`${part.field}-${part.text}`}
                onClick={() => editField(part.field)}
                disabled={p.isTyping}
                className="flex-shrink-0 min-h-[32px] px-3 rounded-full text-[13px] font-medium"
                style={{ background: M.blueSoft, color: M.blueDeep }}
              >
                {part.text}
              </button>
            ))}
          </div>
        )}

        {!busy && (p.quickReplies.length > 0 || !p.answers.origin || !p.answers.dateRange?.start) && (
          <div className="flex gap-2 overflow-x-auto px-3 scrollbar-hide" data-testid="m-quick-replies">
            {!p.answers.origin && (
              <button
                onClick={p.handleUseMyLocation}
                disabled={p.locating}
                className="flex-shrink-0 min-h-[40px] flex items-center gap-1.5 px-3.5 rounded-full text-[14px] border"
                style={{ background: '#eff6ff', borderColor: 'rgba(37,99,235,0.3)', color: M.blue }}
              >
                {p.locating ? <Loader2 size={14} className="animate-spin" /> : <LocateFixed size={14} />}
                {p.locating ? 'Locating…' : 'Use my location'}
              </button>
            )}
            {p.answers.destinations?.length && !p.answers.dateRange?.start ? (
              <button
                onClick={() => editField('dates')}
                className="flex-shrink-0 min-h-[40px] flex items-center gap-1.5 px-3.5 rounded-full text-[14px] border bg-white text-gray-800"
                style={{ borderColor: M.line }}
              >
                <CalendarDays size={14} /> Pick dates
              </button>
            ) : null}
            {p.quickReplies.map((q) => (
              <button
                key={q}
                onClick={() => p.send(q)}
                className="flex-shrink-0 min-h-[40px] px-3.5 rounded-full text-[14px] border bg-white text-gray-800 whitespace-nowrap"
                style={{ borderColor: M.line }}
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {p.showRecap && !findTripLoading && (
          <div className="px-3">
            <button
              onClick={onFindTrip}
              className="w-full min-h-[52px] rounded-2xl text-[17px] font-semibold text-white active:scale-[0.99]"
              style={{ background: M.blue }}
              data-testid="m-find-trip"
            >
              Find my trip →
            </button>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex items-center gap-2 px-3"
        >
          <input
            ref={p.inputRef}
            value={p.input}
            onChange={(e) => p.setInput(e.target.value)}
            placeholder="Where to, when, who's coming…"
            enterKeyHint="send"
            className="flex-1 min-w-0 h-12 px-4 rounded-full text-[16px] bg-gray-100 text-gray-900 placeholder-gray-500 outline-none focus:bg-white focus:ring-2 focus:ring-[#2563eb]/40"
            disabled={p.isTyping}
            aria-label="Message BlueMurr"
          />
          <button
            type="submit"
            disabled={!p.input.trim() || p.isTyping}
            aria-label="Send message"
            className="w-12 h-12 flex-shrink-0 rounded-full flex items-center justify-center text-white disabled:opacity-30"
            style={{ background: M.blue }}
          >
            <Send size={19} />
          </button>
        </form>
      </div>

      {/* ── Widgets as bottom sheets ── */}
      <BottomSheet
        open={p.widget === 'city_picker' && !!p.cityPicker}
        onClose={() => p.setWidget(null)}
        title="Pick your cities"
        subtitle="Tap as many as you like"
        testId="m-city-picker"
        footer={
          <div className="px-4 pt-2 pb-[max(14px,env(safe-area-inset-bottom))] border-t" style={{ borderColor: M.line }}>
            <button
              onClick={p.submitCityPicker}
              disabled={!p.cityPicker || Object.values(p.cityPicker.selected).flat().length === 0}
              className="w-full min-h-[52px] flex items-center justify-center gap-2 rounded-2xl text-[16px] font-semibold text-white disabled:opacity-40"
              style={{ background: M.blue }}
            >
              <Plus size={17} /> Add these cities
            </button>
          </div>
        }
      >
        <div className="px-5 pb-4 flex flex-col gap-5">
          {p.cityPicker?.countries.map((c) => (
            <div key={c.country} className="flex flex-col gap-2">
              <span className="text-[13px] font-semibold text-gray-500 uppercase tracking-wide">{c.country}</span>
              <div className="flex flex-wrap gap-2">
                {[...c.cities, ...(p.cityPicker!.selected[c.country] ?? []).filter((x) => !c.cities.includes(x))].map((city) => {
                  const on = (p.cityPicker!.selected[c.country] ?? []).includes(city);
                  return (
                    <button
                      key={city}
                      onClick={() =>
                        p.setCityPicker((prev) => {
                          if (!prev) return prev;
                          const cur = prev.selected[c.country] ?? [];
                          return {
                            ...prev,
                            selected: { ...prev.selected, [c.country]: on ? cur.filter((x) => x !== city) : [...cur, city] },
                          };
                        })
                      }
                      className={`min-h-[44px] px-4 rounded-full text-[15px] border ${on ? 'text-white' : 'text-gray-800 bg-white'}`}
                      style={on ? { background: M.blue, borderColor: M.blue } : { borderColor: M.line }}
                    >
                      {on && <Check size={14} className="inline mr-1 -mt-0.5" />}
                      {city}
                    </button>
                  );
                })}
              </div>
              <input
                value={p.cityPicker?.custom[c.country] ?? ''}
                onChange={(e) =>
                  p.setCityPicker((prev) => (prev ? { ...prev, custom: { ...prev.custom, [c.country]: e.target.value } } : prev))
                }
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const raw = (p.cityPicker?.custom[c.country] ?? '').trim();
                  if (!raw) return;
                  p.setCityPicker((prev) => {
                    if (!prev) return prev;
                    const cur = prev.selected[c.country] ?? [];
                    return {
                      ...prev,
                      selected: { ...prev.selected, [c.country]: [...cur, raw] },
                      custom: { ...prev.custom, [c.country]: '' },
                    };
                  });
                }}
                enterKeyHint="done"
                placeholder="Type another city…"
                className="h-11 px-4 rounded-full text-[16px] bg-white border border-dashed border-gray-300 outline-none focus:border-[#2563eb]/60"
              />
            </div>
          ))}
        </div>
      </BottomSheet>

      <BottomSheet
        open={p.widget === 'vibe'}
        onClose={() => p.setWidget(null)}
        title="What's the vibe?"
        subtitle="Pick one or a few"
        testId="m-vibe-sheet"
        footer={
          <div className="px-4 pt-2 pb-[max(14px,env(safe-area-inset-bottom))] border-t" style={{ borderColor: M.line }}>
            <button
              onClick={submitVibes}
              disabled={dedupeVibes(p.vibeDraft).length === 0}
              className="w-full min-h-[52px] rounded-2xl text-[16px] font-semibold text-white disabled:opacity-40"
              style={{ background: M.blue }}
            >
              Continue
            </button>
          </div>
        }
      >
        <div className="px-5 pb-4">
          <VibePills wrap hideContinue selected={p.vibeDraft} onChange={p.setVibeDraft} onContinue={submitVibes} />
        </div>
      </BottomSheet>

      <BottomSheet open={p.widget === 'budget'} onClose={() => p.setWidget(null)} title="Budget" testId="m-budget-sheet">
        <div className="px-5 pb-[max(16px,env(safe-area-inset-bottom))]">
          <BudgetPicker
            onSelect={(amount, perPerson) => {
              p.setWidget(null);
              p.send(`Budget is $${amount.toLocaleString()} ${perPerson ? 'per person' : 'total'}`);
            }}
            onSkip={() => {
              p.setWidget(null);
              p.send('No budget limit — skip that');
            }}
          />
        </div>
      </BottomSheet>

      <BottomSheet
        open={datesOpen}
        onClose={() => setDatesOpen(false)}
        title="When are you going?"
        testId="m-dates-sheet"
        footer={
          <div className="px-4 pt-2 pb-[max(14px,env(safe-area-inset-bottom))] border-t" style={{ borderColor: M.line }}>
            <button
              disabled={!dateStart || !dateEnd || dateEnd < dateStart}
              onClick={() => {
                setDatesOpen(false);
                p.send(`Dates: ${humanDay(dateStart)} to ${humanDay(dateEnd)}`);
              }}
              className="w-full min-h-[52px] rounded-2xl text-[16px] font-semibold text-white disabled:opacity-40"
              style={{ background: M.blue }}
            >
              Use these dates
            </button>
          </div>
        }
      >
        <div className="px-5 pb-4 grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[13px] text-gray-500">
            Leave
            <input
              type="date"
              min={today}
              value={dateStart}
              onChange={(e) => {
                setDateStart(e.target.value);
                if (dateEnd && e.target.value > dateEnd) setDateEnd('');
              }}
              className="h-12 px-3 rounded-xl border text-[16px] text-gray-900 bg-white"
              style={{ borderColor: M.line }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-gray-500">
            Come back
            <input
              type="date"
              min={dateStart || today}
              value={dateEnd}
              onChange={(e) => setDateEnd(e.target.value)}
              className="h-12 px-3 rounded-xl border text-[16px] text-gray-900 bg-white"
              style={{ borderColor: M.line }}
            />
          </label>
        </div>
      </BottomSheet>
    </div>
  );
}
