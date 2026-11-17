'use client';

// ConversationalPlanner's logic, moved here verbatim so the desktop planner and
// the mobile planner (components/mobile/MobilePlanner) share one conversation:
// the same /api/plan/converse turns, answer extraction, widget summons and recap.

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
import { CHAT_EDIT_PREFILL } from '@/lib/tripSummary';
import { dedupeVibes, joinVibes, splitVibeText, vibeBubbleText, vibeList, vibePhrase } from '@/lib/vibes';

export type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Failed sends keep the text + show Retry instead of an AI reply. */
  failed?: 'network' | 'assistant';
};

export type Widget = 'city_picker' | 'vibe' | 'budget' | null;

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

export function useConversationalPlanner(seedMessage?: string) {
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [widget, setWidget] = useState<Widget>(null);
  // The vibe widget's picked pills, before Continue.
  const [vibeDraft, setVibeDraft] = useState<string[]>([]);
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

  // A "set" string must be non-empty — the model occasionally returns ""
  // instead of null for fields the user didn't mention this turn, and an
  // empty string must never overwrite a fact we already collected (this
  // erased a location-detected origin and got the user re-asked for it).
  const isSet = (v: string | null | undefined): v is string =>
    typeof v === 'string' && v.trim().length > 0;

  const applyUpdates = useCallback(
    async (u: ConverseResponse['updates']) => {
      if (u.destinations) setAnswer('destinations', u.destinations);
      if (isSet(u.origin)) setAnswer('origin', u.origin);
      if (u.dates) setAnswer('dateRange', u.dates);
      if (u.travelers !== undefined && u.travelers !== null) setAnswer('travelers', u.travelers);
      if (u.budget !== undefined && u.budget !== null) setAnswer('budget', u.budget);
      if (u.budgetPerPerson !== undefined && u.budgetPerPerson !== null)
        setAnswer('budgetPerPerson', u.budgetPerPerson);
      if (isSet(u.vibe)) {
        // "a beach and food trip" → Beach + Food when the words are vibes we
        // know; anything else stays one vibe, as said.
        const vibes = splitVibeText(u.vibe);
        setAnswer('vibes', vibes);
        setAnswer('vibe', joinVibes(vibes));
      }
      if (u.returnToHome !== undefined && u.returnToHome !== null)
        setAnswer('returnToHome', u.returnToHome);
      if (isSet(u.notes)) setAnswer('extraNotes', u.notes);
      setAnswer('planningMode', 'destination');

      // Airports last, because it is the one answer that needs an await.
      //
      // This path set `origin` and never `originAirports`, and it is the MAIN
      // conversational route — `PlanningChat` fills them in three places, this
      // component only in the geolocation branch. So a trip planned by talking
      // reached the optimizer with an empty airport list, took the
      // single-airport `getIataCode` fallback, and silently lost the
      // multi-airport price comparison that makes NYC, London and Tokyo
      // origins worth anything.
      //
      // Recomputed on every origin update rather than filled once: if the
      // traveller moves their origin from New York to Boston, the old JFK/LGA/
      // EWR list is not stale data to preserve, it is wrong data to replace.
      // An unresolvable origin correctly yields an empty list — the same
      // fallback as before, rather than airports for the previous city.
      // Resolved through `locationResolver`, which replaced the hand-written
      // `originAirports` table this branch was written against — that module
      // no longer exists. Same call the geolocation branch below already
      // makes, so the two origin paths in this file now agree on a source.
      if (isSet(u.origin)) {
        const { originAirportsForCity } = await import('@/lib/locationResolver');
        setAnswer('originAirports', originAirportsForCity(u.origin));
      }
    },
    [setAnswer],
  );

  /** Minimum viable trip — mirrors the backend's 'ready' bar, enforced in
   *  code so a hallucinated 'ready' can't slip through. */
  const meetsMinimums = useCallback(() => {
    const a = useTripStore.getState().answers;
    return Boolean(
      a.destinations?.length &&
        a.dateRange?.start &&
        a.dateRange?.end &&
        a.travelers &&
        a.origin && // where they're flying FROM — required for the flight search
        typeof a.returnToHome === 'boolean', // round-trip vs one-way — asked, never assumed
    );
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

        await applyUpdates(result.updates);
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

  // "Use my location": geolocation → nearest airport city (offline lookup)
  // → origin set directly + announced through the conversation so the AI
  // acknowledges it and never re-asks. All failures fall back to typing.
  const [locating, setLocating] = useState(false);
  const handleUseMyLocation = async () => {
    if (locating || isTyping) return;
    setLocating(true);
    try {
      const { detectNearestAirportCity } = await import('@/lib/nearestAirport');
      const result = await detectNearestAirportCity();

      if (!result.ok) {
        const content =
          result.reason === 'unsupported'
            ? "Your browser doesn't support location sharing — just tell me the city you're starting from."
            : "No worries — I couldn't get your location. Just tell me the city you're starting from.";
        const withMsg = [
          ...messagesRef.current,
          { id: nextId(), role: 'assistant' as const, content },
        ];
        messagesRef.current = withMsg;
        setMessages(withMsg);
        syncStore(withMsg);
        return;
      }

      const cityName = result.city.city;
      // Awaited, so this reaches the server for anything the bundled hot set
      // does not carry, and passes the trip's destinations as context.
      const { resolveLocation, originAirportsForCity } = await import('@/lib/locationResolver');
      const answer = await resolveLocation(cityName, {
        tripDestinationNames: answers.destinations,
      });
      // TODO(location-phase-4): on `ambiguous` ask which reading they mean —
      // `answer.candidates` carries the `label` to show and the `placeId` to
      // persist. Taking the best reading until that UI is approved, which is
      // what the table it replaces could express.
      setAnswer('origin', cityName);
      // The hand-written table leads, the resolver's answer is the fallback.
      // Driving the real UI found why: `Newark, NJ` resolved to NOTHING here,
      // because the hot set has no comma-qualified key and the round trip can
      // fail, while the table answers it offline. And the frontend's answer
      // WINS — `optimizer.ts` uses `originAirports` from the body verbatim —
      // so serving the resolver here would bypass `LOCATION_RESOLVER_MODE`
      // and the shadow log meant to justify the switch.
      //
      // `answer` is still computed: its candidates are what the phase-4
      // question gets built from.
      const fromTable = originAirportsForCity(cityName);
      setAnswer(
        'originAirports',
        fromTable.length > 0
          ? fromTable
          : answer.status === 'resolved'
            ? answer.airports.map((a) => a.iata)
            : answer.status === 'ambiguous'
              ? (answer.candidates[0]?.airports.map((a) => a.iata) ?? [])
              : [],
      );
      await send(`I'm starting from ${cityName} (detected from my location)`);
    } finally {
      setLocating(false);
    }
  };

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
      value: a.dateRange?.start
        ? a.dateRange.end && a.dateRange.end !== a.dateRange.start
          ? humanDayRange(a.dateRange.start, a.dateRange.end)
          : humanDay(a.dateRange.start)
        : '—',
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
    { icon: Sparkles, label: 'Vibe', value: vibeList(a).length > 0 ? vibePhrase(vibeList(a)) : 'Open' },
  ];


  return {
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
  };
}

export type ConversationalPlannerState = ReturnType<typeof useConversationalPlanner>;
