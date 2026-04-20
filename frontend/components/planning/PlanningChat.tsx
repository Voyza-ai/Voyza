'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Send, SkipForward, Pencil, Check, X, MapPin } from 'lucide-react';
import { useTripStore } from '@/store/tripStore';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { interpretPlan, optimizeTrip, searchHotels, searchActivities, searchRestaurants, suggestDestinations, OptimizeResult, ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { Trip, City, Transport, ScheduledEvent, Restaurant } from '@/lib/types';
import { parseDateInput } from '@/lib/parseDate';
import IntentPicker from './IntentPicker';
import VibePills from './VibePills';
import DatePicker from './DatePicker';
import TravelersPicker from './TravelersPicker';
import BudgetPicker from './BudgetPicker';

type StepType = 'intent' | 'text' | 'vibes' | 'dates' | 'travelers' | 'budget' | 'notes';

type Step = {
  id: string;
  question: string;
  type: StepType;
  skippable?: boolean;
  placeholder?: string;
};

// Place path: user knows where they want to go
const PLACE_STEPS: Step[] = [
  { id: 'destination', question: "Where are you dreaming of going?", type: 'text', placeholder: 'Type a destination...' },
  { id: 'vibe', question: "What's the vibe you're going for?", type: 'vibes' },
  { id: 'dates', question: "When are you thinking?", type: 'dates', skippable: true },
  { id: 'travelers', question: "How many people?", type: 'travelers' },
  { id: 'budget', question: "What's your budget looking like?", type: 'budget', skippable: true },
  { id: 'notes', question: "Anything else I should know?", type: 'notes', skippable: true, placeholder: 'E.g. "I want to avoid long layovers"' },
];

// Vibe path: user wants to explore based on a feeling
const VIBE_STEPS: Step[] = [
  { id: 'vibe', question: "What vibe are you chasing?", type: 'vibes' },
  { id: 'dates', question: "When are you thinking?", type: 'dates', skippable: true },
  { id: 'travelers', question: "How many people?", type: 'travelers' },
  { id: 'budget', question: "What's your budget looking like?", type: 'budget', skippable: true },
  { id: 'notes', question: "Anything else I should know?", type: 'notes', skippable: true, placeholder: 'E.g. "Somewhere warm with good food"' },
];

// Budget path: user leads with what they can spend
const BUDGET_STEPS: Step[] = [
  { id: 'budget', question: "What's your total budget for this trip?", type: 'budget' },
  { id: 'dates', question: "When are you thinking?", type: 'dates', skippable: true },
  { id: 'travelers', question: "How many people?", type: 'travelers' },
  { id: 'vibe', question: "Any vibe in mind, or totally open?", type: 'vibes', skippable: true },
  { id: 'notes', question: "Anything else I should know?", type: 'notes', skippable: true, placeholder: 'E.g. "Europe preferred" or "beach access a must"' },
];

type Intent = 'place' | 'vibe' | 'budget' | 'chat';

type Message = {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  stepId?: string;
};

export default function PlanningChat() {
  const router = useRouter();
  const { answers, setAnswer, setTrip } = useTripStore();
  const [intent, setIntent] = useState<Intent | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [textInput, setTextInput] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const [showIntent, setShowIntent] = useState(false);
  const [chatMode, setChatMode] = useState(false); // open chat mode
  const [vibe, setVibe] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingMsgValue, setEditingMsgValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialized = useRef(false);
  const mountedRef = useRef(true);
  const msgCounter = useRef(0);

  const nextId = () => `msg-${++msgCounter.current}`;

  // Show a one-time warning bubble if the backend returned a mock AI response
  // (Anthropic key missing or SDK error). Without this the user sees garbled
  // destinations parsed by naive comma-splitting and has no idea why the
  // suggestions look wrong. Ref guards against showing the warning twice.
  const mockWarningShown = useRef(false);
  const warnIfMock = (parsed: any) => {
    if (!parsed?._mock || mockWarningShown.current) return;
    mockWarningShown.current = true;
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'assistant',
        content:
          "Heads up — our AI service is unavailable right now, so I'm using a simple fallback to parse your request. Results may be less accurate than usual.",
      },
    ]);
  };

  // Seed the conversation.
  //
  // React 18 StrictMode dev mode mounts → unmounts → remounts every component.
  // Our constraints:
  //   - We must seed messages exactly once (duplicate "What kind of trip"
  //     bubbles look broken)
  //   - We must schedule the intent picker reveal exactly once (the 500ms
  //     timer drives the picker's entrance animation)
  //   - A cleanup that clears the timer on the *first* unmount breaks
  //     StrictMode: the second mount's early-return (on initialized=true)
  //     means no new timer gets scheduled, and the picker never appears —
  //     this is the "intent picker disappears on fresh load" bug
  //
  // Solution: don't cancel timers. Instead, guard the callback with a
  // `mounted` flag so setShowIntent is a no-op if the component actually
  // unmounts for good (navigation, etc.) but fires normally for the
  // StrictMode unmount+remount cycle (the flag is re-set to true on the
  // remount before the timer fires).
  useEffect(() => {
    mountedRef.current = true;
    if (initialized.current) return () => { mountedRef.current = false; };
    initialized.current = true;

    const snapshotRawInput = answers.rawInput;

    if (snapshotRawInput) {
      const placeSteps = PLACE_STEPS.slice(1);
      setIntent('place');
      setSteps(placeSteps);
      setCurrentStepIndex(0);
      setMessages([
        { id: nextId(), role: 'assistant', content: `Love it — "${snapshotRawInput}". Let's make it happen.` },
      ]);
      setAnswer('destinations', [snapshotRawInput]);
      setAnswer('rawInput', undefined);

      window.setTimeout(() => {
        if (!mountedRef.current) return;
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: placeSteps[0].question, stepId: placeSteps[0].id },
        ]);
      }, 800);
    } else {
      setMessages([
        { id: nextId(), role: 'assistant', content: "What kind of trip are you planning?", stepId: 'intent' },
      ]);
      window.setTimeout(() => {
        if (!mountedRef.current) return;
        setShowIntent(true);
      }, 500);
    }

    return () => {
      mountedRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll — wait for layout (including the answer widget that appears
  // with a small delay) to settle before scrolling, otherwise we scroll past
  // the new content before it has a chance to mount.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = window.setTimeout(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, 80);
    return () => window.clearTimeout(id);
  }, [messages, isComplete, showIntent, currentStepIndex, intent, chatMode]);

  // Auto-resize the chat textarea as the user types. Grows from 1 line up to
  // MAX_INPUT_HEIGHT (~4 lines), then scrolls internally. Runs whenever
  // textInput changes so clearing the input after submit also resets height.
  // 16px text * 1.4 line-height * 4 lines = ~90px + 12px py padding ≈ 102px.
  const MAX_INPUT_HEIGHT = 102;
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [textInput]);

  const handleIntentSelect = (selectedIntent: Intent) => {
    setShowIntent(false);

    // Chat mode — completely different flow
    if (selectedIntent === 'chat') {
      setIntent('chat');
      setChatMode(true);

      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: 'Let me just tell you' },
      ]);

      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: "Go for it — tell me everything. Where, when, budget, vibe, who's coming — whatever you've got. I'll figure out the rest." },
        ]);
      }, 500);

      return;
    }

    // Guided paths
    setIntent(selectedIntent);

    const labels: Record<string, string> = {
      place: 'I have a place in mind',
      vibe: "I'm chasing a vibe",
      budget: 'I know my budget',
    };

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: labels[selectedIntent] },
    ]);

    const pathMap: Record<string, Step[]> = {
      place: PLACE_STEPS,
      vibe: VIBE_STEPS,
      budget: BUDGET_STEPS,
    };

    const chosenSteps = pathMap[selectedIntent];
    setSteps(chosenSteps);
    setCurrentStepIndex(0);

    const acks: Record<string, string> = {
      place: "Great, let's find the perfect trip for you.",
      vibe: "Love that energy — let's find something amazing.",
      budget: "Smart — let's see how far your money can take you.",
    };

    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: acks[selectedIntent] },
      ]);
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: chosenSteps[0].question, stepId: chosenSteps[0].id },
        ]);
      }, 600);
    }, 500);
  };

  // Find the next step whose answer isn't already in the store — so that if
  // the AI extracted budget/vibe/travelers from the user's destination text
  // we don't re-ask questions we already know the answers to.
  const isStepAlreadyAnswered = (stepId: string): boolean => {
    switch (stepId) {
      case 'vibe':     return !!answers.vibe;
      case 'dates':    return !!answers.dateRange?.start;
      case 'travelers': return typeof answers.travelers === 'number';
      case 'budget':   return typeof answers.budget === 'number';
      case 'budgetPerPerson': return typeof answers.budgetPerPerson === 'boolean';
      default:         return false;
    }
  };

  const advanceToNextStep = (fromIndex: number) => {
    let nextIndex = fromIndex + 1;
    // Skip any steps whose answer is already in the store.
    while (nextIndex < steps.length && isStepAlreadyAnswered(steps[nextIndex].id)) {
      nextIndex++;
    }

    if (nextIndex >= steps.length) {
      setIsComplete(true);
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: "Perfect — I've got everything I need. Ready to find your trip?" },
        ]);
      }, 600);
      return;
    }

    setCurrentStepIndex(nextIndex);
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: steps[nextIndex].question, stepId: steps[nextIndex].id },
      ]);
    }, 600);
  };

  // Guided text submit (destination, notes)
  const handleTextSubmit = async () => {
    if (!textInput.trim() || !steps.length) return;
    const step = steps[currentStepIndex];
    const value = textInput.trim();

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: value },
    ]);
    setTextInput('');

    if (step.id === 'destination') {
      // Call AI interpret IMMEDIATELY so we can detect countries and show
      // the city picker inline BEFORE asking about vibe/dates/etc.
      // If the AI also extracts vibe/dates/travelers/budget from the user's
      // input, store them so we can skip those follow-up steps.
      try {
        const parsed = await interpretPlan({ rawInput: value });
        warnIfMock(parsed);

        // Store anything else the AI extracted from the destination text
        if (parsed.vibe && !answers.vibe) setAnswer('vibe', parsed.vibe);
        if (parsed.travelers && !answers.travelers) setAnswer('travelers', parsed.travelers);
        if (parsed.budget && !answers.budget) setAnswer('budget', parsed.budget);
        if (typeof parsed.budgetPerPerson === 'boolean' && answers.budgetPerPerson === undefined) {
          setAnswer('budgetPerPerson', parsed.budgetPerPerson);
        }
        // Dates: try AI's absolute date first, then fall back to parsing the
        // raw user text for relative phrases ("next week", "tomorrow") so we
        // don't re-ask a question the user already answered.
        const aiDate = parsed.dates?.start;
        if (!answers.dateRange) {
          if (aiDate) {
            setAnswer('dateRange', { start: aiDate, end: parsed.dates.end ?? aiDate });
          } else {
            const fallback = parseDateInput(value);
            // Only commit the fallback if the raw text actually looked
            // date-ish (contained a month, day, or date keyword). Otherwise
            // we'd set today+30 for any destination like "Japan".
            if (/\b(tomorrow|today|next|month|week|year|summer|winter|spring|fall|autumn|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i.test(value)) {
              setAnswer('dateRange', { start: fallback, end: fallback });
            }
          }
        }

        if (parsed.needsCitySelection && parsed.countries?.length > 0) {
          // Store any direct cities (not from a country) as a base
          const directCities: string[] = parsed.destinations?.filter(
            (d: string) => !parsed.countries.some((c: any) => c.cities.includes(d)),
          ) ?? [];
          const defaultSelections: Record<string, string[]> = {};
          for (const c of parsed.countries) {
            defaultSelections[c.country] = [c.cities[0]];
          }
          if (directCities.length > 0) defaultSelections['_direct'] = directCities;

          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              content: `I see you want to visit ${parsed.countries.map((c: any) => c.country).join(' and ')}! Which cities?`,
            },
          ]);

          setCitySelectionData({
            countries: parsed.countries,
            selectedCities: defaultSelections,
            parsedData: parsed,
          });
          return; // wait for picker confirmation — don't advance yet
        }

        // No country detected. If AI also couldn't extract real cities, fall back
        // to suggestDestinations based on whatever vibe/budget hints the AI found
        // (e.g. user typed "beach trip" → suggest beach cities).
        if (!parsed.destinations || parsed.destinations.length === 0) {
          try {
            const suggestions = await suggestDestinations({
              vibe: parsed.vibe ?? value,
              budget: parsed.budget ?? undefined,
            });
            if (suggestions.length > 0) {
              const suggestedCities = suggestions.map((s) => s.name);
              setMessages((prev) => [
                ...prev,
                {
                  id: nextId(),
                  role: 'assistant',
                  content: `Based on "${value}", here are some ideas. Pick the ones you like:`,
                },
              ]);
              setCitySelectionData({
                countries: [{ country: 'Suggested for you', cities: suggestedCities }],
                selectedCities: { 'Suggested for you': [suggestedCities[0]] },
                parsedData: parsed,
              });
              return; // wait for picker confirmation
            }
          } catch {
            // suggestion API failed — fall through
          }
          // Last resort: store the raw input so the optimizer can try to geocode.
          setAnswer('destinations', [value]);
        } else {
          setAnswer('destinations', parsed.destinations);
        }
      } catch {
        // Interpret failed — fall back to the raw input as a single destination
        setAnswer('destinations', [value]);
      }
    } else if (step.id === 'notes') {
      setAnswer('extraNotes', value);
    }

    advanceToNextStep(currentStepIndex);
  };

  // Open chat submit — user types everything at once. Calls AI interpret
  // immediately, then asks only for whatever's missing (budget, vibe, etc.)
  // before going to Find my trip.
  const handleChatSubmit = async () => {
    if (!textInput.trim()) return;
    const userMessage = textInput.trim();

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: userMessage },
    ]);
    setAnswer('rawInput', userMessage);
    setTextInput('');

    try {
      const parsed = await interpretPlan({ rawInput: userMessage });
      warnIfMock(parsed);

      // Store whatever the AI extracted
      if (parsed.vibe && !answers.vibe) setAnswer('vibe', parsed.vibe);
      if (parsed.travelers && !answers.travelers) setAnswer('travelers', parsed.travelers);
      if (parsed.budget && !answers.budget) setAnswer('budget', parsed.budget);
      if (typeof parsed.budgetPerPerson === 'boolean' && answers.budgetPerPerson === undefined) {
        setAnswer('budgetPerPerson', parsed.budgetPerPerson);
      }
      // Dates: AI's absolute value first, then fall back to parsing the raw
      // chat text for relative phrases ("next week") so we don't re-ask.
      if (!answers.dateRange) {
        if (parsed.dates?.start) {
          setAnswer('dateRange', { start: parsed.dates.start, end: parsed.dates.end ?? parsed.dates.start });
        } else if (/\b(tomorrow|today|next|month|week|year|summer|winter|spring|fall|autumn|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i.test(userMessage)) {
          const fallback = parseDateInput(userMessage);
          setAnswer('dateRange', { start: fallback, end: fallback });
        }
      }

      // Country detected → show picker inline
      if (parsed.needsCitySelection && parsed.countries?.length > 0) {
        const directCities: string[] = parsed.destinations?.filter(
          (d: string) => !parsed.countries.some((c: any) => c.cities.includes(d)),
        ) ?? [];
        const defaultSelections: Record<string, string[]> = {};
        for (const c of parsed.countries) {
          defaultSelections[c.country] = [c.cities[0]];
        }
        if (directCities.length > 0) defaultSelections['_direct'] = directCities;

        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: `I see you want to visit ${parsed.countries.map((c: any) => c.country).join(' and ')}! Which cities?`,
          },
        ]);

        setCitySelectionData({
          countries: parsed.countries,
          selectedCities: defaultSelections,
          parsedData: parsed,
        });
        return;
      }

      if (parsed.destinations?.length > 0) {
        setAnswer('destinations', parsed.destinations);
      }

      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: "Got it — I have a good picture of what you're after." },
      ]);

      // Ask follow-up questions as chat bubbles for anything the user
      // didn't mention (dates, travelers, budget, vibe).
      const remaining = buildRemainingSteps(parsed);
      if (remaining.length === 0) {
        setIsComplete(true);
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: 'Ready when you are.' },
        ]);
      } else {
        setChatMode(false);
        setSteps(remaining);
        setCurrentStepIndex(0);
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: remaining[0].question, stepId: remaining[0].id },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: "I had trouble understanding that. Could you try again with a city or country?" },
      ]);
    }
  };

  const handleVibeSelect = (selectedVibe: string) => {
    setVibe(selectedVibe);
    setAnswer('vibe', selectedVibe);
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: selectedVibe },
    ]);
    advanceToNextStep(currentStepIndex);
  };

  const handleDatesSelect = (start: string, end: string, flexible: boolean) => {
    setAnswer('dateRange', { start, end });
    setAnswer('flexible', flexible);
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: start },
    ]);
    advanceToNextStep(currentStepIndex);
  };

  const handleTravelersSelect = (count: number) => {
    setAnswer('travelers', count);
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: count === 1 ? 'Just me' : `${count} people` },
    ]);
    advanceToNextStep(currentStepIndex);
  };

  const handleBudgetSelect = (budget: number, perPerson: boolean) => {
    setAnswer('budget', budget);
    setAnswer('budgetPerPerson', perPerson);
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: `$${budget.toLocaleString()}${perPerson ? ' per person' : ' total'}` },
    ]);
    advanceToNextStep(currentStepIndex);
  };

  // Called by the inline "Per person / Total" picker when we already know
  // the budget amount but need to clarify whether it's per-person or total.
  const handleBudgetPerPersonConfirm = (perPerson: boolean) => {
    setAnswer('budgetPerPerson', perPerson);
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: perPerson ? 'Per person' : 'Total for the trip' },
    ]);
    advanceToNextStep(currentStepIndex);
  };

  const handleSkip = () => {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: 'Skip' },
    ]);
    advanceToNextStep(currentStepIndex);
  };

  const buildTripFromOptimize = (
    result: OptimizeResult,
    travelers: number,
  ): Trip => {
    const route = result.bestRoute;
    const emptyTransport: Transport = {
      mode: 'flight',
      operator: '',
      duration: '',
      price: 0,
    };

    // Helper: extract a Transport from an optimizer leg's comparison data
    const legToTransport = (leg: any, fromCity: string, toCity: string): Transport => {
      const comp = leg?.comparison;
      if (!comp) return { ...emptyTransport, from: fromCity, to: toCity };

      const rec = comp.recommendation; // 'flight' | 'train' | 'unavailable'
      const flight = comp.flightOption;
      const train = comp.trainOption;

      // Pick the recommended option, fall back to whichever exists
      const useFlight = rec === 'flight' || (!train && flight);
      const picked = useFlight ? flight : train;

      if (!picked) return { ...emptyTransport, from: fromCity, to: toCity };

      const mode: 'flight' | 'train' = useFlight ? 'flight' : 'train';
      const durationMin = picked.durationMinutes ?? 0;
      const hours = Math.floor(durationMin / 60);
      const mins = durationMin % 60;
      const durationStr = hours > 0
        ? `${hours}h ${mins > 0 ? `${mins}m` : ''}`
        : `${mins}m`;

      // Parse departure/arrival times from ISO strings
      const departIso = picked.departure ?? '';
      const arriveIso = picked.arrival ?? '';
      const departTime = departIso ? new Date(departIso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : undefined;
      const arriveTime = arriveIso ? new Date(arriveIso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : undefined;
      const departDate = departIso ? departIso.split('T')[0] : undefined;

      // Build alternatives from the non-recommended option
      const alternatives: Transport[] = [];
      const other = useFlight ? train : flight;
      if (other && other.price != null) {
        const otherMode: 'flight' | 'train' = useFlight ? 'train' : 'flight';
        const otherDur = other.durationMinutes ?? 0;
        const oH = Math.floor(otherDur / 60);
        const oM = otherDur % 60;
        const otherDepartIso = other.departure ?? '';
        const otherArriveIso = other.arrival ?? '';
        alternatives.push({
          mode: otherMode,
          operator: otherMode === 'flight' ? (other.carrier ?? '') : (other.operator ?? ''),
          duration: oH > 0 ? `${oH}h ${oM > 0 ? `${oM}m` : ''}` : `${oM}m`,
          price: other.price ?? 0,
          from: fromCity,
          to: toCity,
          departTime: otherDepartIso ? new Date(otherDepartIso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : undefined,
          arriveTime: otherArriveIso ? new Date(otherArriveIso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : undefined,
          bookingUrl: other.bookingUrl || undefined,
        });
      }

      return {
        mode,
        operator: mode === 'flight' ? (picked.carrier ?? '') : (picked.operator ?? ''),
        duration: durationStr,
        price: picked.price ?? 0,
        from: fromCity,
        to: toCity,
        departTime,
        arriveTime,
        departDate,
        layovers: mode === 'flight' ? (picked.stops ?? 0) : 0,
        bookingUrl: picked.bookingUrl || undefined,
        flightNumber: mode === 'flight' ? (picked.carrierCode ?? undefined) : undefined,
        alternatives,
      };
    };

    const cities: City[] = route.ordering.map((name, i) => {
      // Leg at index i-1 connects city i-1 → city i
      const leg = i > 0 ? route.legs?.[i - 1] : null;
      const cityDates = result.dates?.[name] ?? {
        arrival: new Date().toISOString().split('T')[0],
        departure: new Date().toISOString().split('T')[0],
      };

      const transportIn: Transport = i === 0
        ? emptyTransport
        : legToTransport(leg, route.ordering[i - 1], name);

      return {
        name,
        country: '',
        dates: cityDates,
        transportIn,
        transportOut: emptyTransport,
        hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
        hotels: [],
        selectedHotelIndex: 0,
        activities: [],
        restaurants: [],
        vibes: [],
      };
    });

    // Wire transportOut for each city to the next city's transportIn
    for (let i = 0; i < cities.length - 1; i++) {
      cities[i].transportOut = cities[i + 1].transportIn;
    }

    return {
      title: cities.map((c) => c.name).join(' → '),
      status: 'planning',
      totalCost: Math.round(route.totalCost ?? 0),
      savings: Math.round(result.savingsVsNaive ?? 0),
      travelers,
      cities,
      savingsTips: [],
      dateShiftSuggestion: result.dateShiftSuggestion,
    };
  };

  // Exposed so runOptimizeAndBuild can attach the normalized total budget
  // to the trip after buildTripFromOptimize returns. Kept separate from the
  // builder to avoid threading more arguments through the flowchart mapping.

  /**
   * Spread AI-picked activities AND restaurants across the days of a city
   * stay, assigning realistic time blocks. Each day gets:
   *   - Breakfast (8-9 AM) if a breakfast/any restaurant is available
   *   - Morning activity (10 AM – 12 PM)
   *   - Lunch (12:30-1:30 PM) if a lunch/any restaurant is available
   *   - Afternoon activity (2-5 PM)
   *   - Dinner (7:30-9:30 PM) if a dinner/any restaurant is available
   *   - OR evening activity if no dinner slot picked
   *
   * Activities and restaurants are consumed from queues as days advance,
   * so the full list is spread across the whole stay (no duplicates, no
   * day ends up empty until supply runs out).
   */
  const buildScheduleFromActivities = (
    activities: ActivitySuggestion[],
    restaurants: RestaurantSuggestion[],
    arrivalISO: string,
    departureISO: string,
  ): Record<string, ScheduledEvent[]> => {
    const schedule: Record<string, ScheduledEvent[]> = {};
    const arrival = new Date(arrivalISO);
    const departure = new Date(departureISO);
    const dayCount = Math.max(
      1,
      Math.ceil((departure.getTime() - arrival.getTime()) / (1000 * 60 * 60 * 24)),
    );

    // Activity buckets by time-of-day
    const actBuckets = {
      morning: [...activities.filter((s) => s.timeOfDay === 'morning')],
      afternoon: [...activities.filter((s) => s.timeOfDay === 'afternoon')],
      evening: [...activities.filter((s) => s.timeOfDay === 'evening')],
    };

    // Restaurant buckets by meal
    const restBuckets = {
      breakfast: [...restaurants.filter((r) => r.mealType === 'breakfast')],
      lunch: [...restaurants.filter((r) => r.mealType === 'lunch')],
      dinner: [...restaurants.filter((r) => r.mealType === 'dinner')],
      any: [...restaurants.filter((r) => r.mealType === 'any')],
    };

    let idCounter = 0;
    const pad = (n: number) => String(n).padStart(2, '0');

    const takeRestaurant = (
      preferred: keyof typeof restBuckets,
    ): RestaurantSuggestion | undefined => {
      if (restBuckets[preferred].length > 0) return restBuckets[preferred].shift();
      if (restBuckets.any.length > 0) return restBuckets.any.shift();
      return undefined;
    };

    const minToTime = (total: number): string => {
      const h = Math.floor(total / 60);
      const m = total % 60;
      return `${pad(h)}:${pad(m)}`;
    };

    /**
     * Place an event within its preferred slot without overlapping the
     * previous event. Returns the event (and the new cursor) or null if
     * there's no room left in the slot.
     *
     * - `cursor`        current end-of-day position in minutes since midnight
     * - `slotStartMin`  earliest minute this event should start
     * - `slotEndMin`    latest minute this event may end
     * - `desiredDurMin` AI-provided duration; clamped to fit the slot
     */
    const tryPlace = (
      cursor: number,
      slotStartMin: number,
      slotEndMin: number,
      desiredDurMin: number,
      make: (startMin: number, endMin: number) => ScheduledEvent,
    ): { event: ScheduledEvent; cursor: number } | null => {
      // Leave a 15-minute buffer between events so the day doesn't feel packed.
      const BUFFER = 15;
      const start = Math.max(slotStartMin, cursor === 0 ? slotStartMin : cursor + BUFFER);
      if (start >= slotEndMin) return null;
      // Need at least 30 minutes of room to justify scheduling anything.
      if (slotEndMin - start < 30) return null;
      const end = Math.min(slotEndMin, start + Math.max(30, desiredDurMin));
      return { event: make(start, end), cursor: end };
    };

    const makeActivityEvent =
      (s: ActivitySuggestion) =>
      (startMin: number, endMin: number): ScheduledEvent => ({
        id: `sched-${++idCounter}`,
        title: s.name,
        startTime: minToTime(startMin),
        endTime: minToTime(endMin),
        category: s.category === 'food' || s.category === 'nightlife' ? 'restaurant' : 'activity',
        notes: s.reason,
      });

    const makeMealEvent =
      (r: RestaurantSuggestion) =>
      (startMin: number, endMin: number): ScheduledEvent => ({
        id: `sched-${++idCounter}`,
        title: `${r.name} (${r.cuisine})`,
        startTime: minToTime(startMin),
        endTime: minToTime(endMin),
        category: 'restaurant',
        notes: `${r.priceRange} · ${r.reason}`,
      });

    // Time slots in minutes-since-midnight. Activities get capped to fit,
    // which means a 4-hour "Great Wall hike" in the morning slot renders as
    // a 2-hour block (10:00 → 12:00) — the full duration stays in the event
    // notes for the user to see.
    const SLOT = {
      breakfast: [8 * 60, 9 * 60 + 30] as [number, number],          // 08:00–09:30
      morning:   [10 * 60, 12 * 60] as [number, number],             // 10:00–12:00
      lunch:     [12 * 60 + 30, 14 * 60] as [number, number],        // 12:30–14:00
      afternoon: [14 * 60 + 15, 18 * 60 + 30] as [number, number],   // 14:15–18:30
      dinner:    [19 * 60, 21 * 60 + 30] as [number, number],        // 19:00–21:30
      lateEve:   [22 * 60, 23 * 60 + 30] as [number, number],        // 22:00–23:30 (post-dinner activity)
    };

    for (let dayIdx = 0; dayIdx < dayCount; dayIdx++) {
      const dayDate = new Date(arrival);
      dayDate.setDate(dayDate.getDate() + dayIdx);
      const dateKey = dayDate.toISOString().split('T')[0];
      const events: ScheduledEvent[] = [];
      let cursor = 0;

      const push = (result: { event: ScheduledEvent; cursor: number } | null) => {
        if (result) {
          events.push(result.event);
          cursor = result.cursor;
        }
      };

      // Breakfast — 45 min
      const bk = takeRestaurant('breakfast');
      if (bk) push(tryPlace(cursor, SLOT.breakfast[0], SLOT.breakfast[1], 45, makeMealEvent(bk)));

      // Morning activity — AI duration capped to 2h by the slot
      const morningAct = actBuckets.morning.shift();
      if (morningAct) {
        const dur = Math.round((morningAct.durationHours ?? 2) * 60);
        push(tryPlace(cursor, SLOT.morning[0], SLOT.morning[1], dur, makeActivityEvent(morningAct)));
      }

      // Lunch — 90 min, won't start before cursor (so a morning activity
      // that ran long naturally bumps lunch later or skips it entirely)
      const ln = takeRestaurant('lunch');
      if (ln) push(tryPlace(cursor, SLOT.lunch[0], SLOT.lunch[1], 90, makeMealEvent(ln)));

      // Afternoon activity
      const afternoonAct = actBuckets.afternoon.shift();
      if (afternoonAct) {
        const dur = Math.round((afternoonAct.durationHours ?? 3) * 60);
        push(tryPlace(cursor, SLOT.afternoon[0], SLOT.afternoon[1], dur, makeActivityEvent(afternoonAct)));
      }

      // Dinner — 120 min
      const dn = takeRestaurant('dinner');
      if (dn) push(tryPlace(cursor, SLOT.dinner[0], SLOT.dinner[1], 120, makeMealEvent(dn)));

      // Evening activity. If we have a dinner, put the activity in the
      // post-dinner slot. If no dinner, use the dinner slot for the activity.
      const eveningAct = actBuckets.evening.shift();
      if (eveningAct) {
        const dur = Math.round((eveningAct.durationHours ?? 2) * 60);
        if (dn) {
          push(tryPlace(cursor, SLOT.lateEve[0], SLOT.lateEve[1], dur, makeActivityEvent(eveningAct)));
        } else {
          push(tryPlace(cursor, SLOT.dinner[0], SLOT.dinner[1], dur, makeActivityEvent(eveningAct)));
        }
      }

      if (events.length > 0) schedule[dateKey] = events;
    }

    return schedule;
  };

  const [findTripLoading, setFindTripLoading] = useState(false);
  const [findTripStatus, setFindTripStatus] = useState('');
  const [findTripError, setFindTripError] = useState<string | null>(null);

  // City selection state — shown when user mentions countries
  const [citySelectionData, setCitySelectionData] = useState<{
    countries: Array<{ country: string; cities: string[] }>;
    selectedCities: Record<string, string[]>; // country → selected cities
    parsedData: any; // the full interpret response to resume after selection
  } | null>(null);

  const handleCityToggle = (country: string, city: string) => {
    if (!citySelectionData) return;
    const current = citySelectionData.selectedCities[country] ?? [];
    const updated = current.includes(city)
      ? current.filter((c) => c !== city)
      : [...current, city];
    setCitySelectionData({
      ...citySelectionData,
      selectedCities: { ...citySelectionData.selectedCities, [country]: updated },
    });
  };

  // Holds the "type another city" text for each country row.
  const [customCityInputs, setCustomCityInputs] = useState<Record<string, string>>({});

  const handleAddCustomCity = (country: string) => {
    const raw = (customCityInputs[country] ?? '').trim();
    if (!raw || !citySelectionData) return;
    const capitalized = raw.charAt(0).toUpperCase() + raw.slice(1);

    // Append to the country's cities list (so it renders as a pill) and
    // auto-select it.
    const newCountries = citySelectionData.countries.map((c) =>
      c.country === country && !c.cities.includes(capitalized)
        ? { ...c, cities: [...c.cities, capitalized] }
        : c,
    );
    const currentSel = citySelectionData.selectedCities[country] ?? [];
    const updatedSel = currentSel.includes(capitalized) ? currentSel : [...currentSel, capitalized];

    setCitySelectionData({
      ...citySelectionData,
      countries: newCountries,
      selectedCities: { ...citySelectionData.selectedCities, [country]: updatedSel },
    });
    setCustomCityInputs((prev) => ({ ...prev, [country]: '' }));
  };

  // Build a list of guided steps for any fields the user/AI hasn't supplied.
  // Used after the city picker (and in chat mode) so we keep the conversation
  // going with real chat bubbles instead of silently showing just the text
  // box at the bottom.
  //
  // Order matters — we ask:
  //   1. travelers (needed to interpret budget correctly)
  //   2. dates (when are you going?)
  //   3. budget (can now ask per-person vs total knowing travelers)
  //   4. vibe (last — lowest functional impact)
  const buildRemainingSteps = (parsed: any): Step[] => {
    const missing: Step[] = [];
    const hasVibe = answers.vibe || parsed?.vibe;
    const hasDates = answers.dateRange?.start || parsed?.dates?.start;
    const hasTravelers = typeof answers.travelers === 'number' || typeof parsed?.travelers === 'number';
    const hasBudget = typeof answers.budget === 'number' || typeof parsed?.budget === 'number';
    const travelersAmbiguous = parsed?.travelersAmbiguous === true && hasTravelers;
    const budgetPerPersonKnown =
      typeof answers.budgetPerPerson === 'boolean' ||
      typeof parsed?.budgetPerPerson === 'boolean';

    if (!hasTravelers) {
      missing.push({ id: 'travelers', question: 'How many people total, including you?', type: 'travelers' });
    } else if (travelersAmbiguous) {
      // AI flagged the phrasing as ambiguous (e.g. "traveling with 3 people")
      // — ask once to confirm whether that number includes them.
      const n = answers.travelers ?? parsed.travelers;
      missing.push({
        id: 'travelers',
        question: `Just to confirm — is that ${n} people total (including you), or ${n} others (${n + 1} total)?`,
        type: 'travelers',
      });
    }

    if (!hasDates) {
      missing.push({ id: 'dates', question: 'When are you thinking?', type: 'dates', skippable: true });
    }

    if (!hasBudget) {
      missing.push({ id: 'budget', question: "What's your budget looking like?", type: 'budget', skippable: true });
    } else if (!budgetPerPersonKnown) {
      // We know the number but not whether it's per-person or total — ask.
      const amount = answers.budget ?? parsed.budget;
      missing.push({
        id: 'budgetPerPerson',
        question: `Is $${amount.toLocaleString()} per person or total for the trip?`,
        type: 'budget',
      });
    }

    if (!hasVibe) {
      missing.push({ id: 'vibe', question: "What's the vibe you're going for?", type: 'vibes', skippable: true });
    }

    return missing;
  };

  const handleCitySelectionConfirm = () => {
    if (!citySelectionData) return;
    const allSelected = Object.values(citySelectionData.selectedCities).flat();
    if (allSelected.length === 0) return;

    // Add a message showing what the user picked. Show country groupings
    // plus any direct cities (e.g. "Shanghai" when the user typed
    // "Japan and Shanghai" — Shanghai isn't under any country entry).
    const groups = Object.entries(citySelectionData.selectedCities)
      .filter(([key, cities]) => key !== '_direct' && cities.length > 0)
      .map(([country, cities]) => `${country}: ${cities.join(', ')}`);
    const directs = citySelectionData.selectedCities['_direct'] ?? [];
    if (directs.length > 0) groups.push(directs.join(', '));
    const summary = groups.join(' | ');
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: summary || allSelected.join(', ') },
    ]);

    // Lock the cities into the store so the rest of the guided flow (and the
    // final Find-my-trip call) uses them.
    setAnswer('destinations', allSelected);
    const parsed = citySelectionData.parsedData;
    setCitySelectionData(null);

    // If the user clicked Find-my-trip first (isComplete is true), run optimize.
    if (isComplete) {
      parsed.destinations = allSelected;
      parsed.needsCitySelection = false;
      runOptimizeAndBuild(parsed);
      return;
    }

    // Chat-mode OR place-path: check what info is still missing and ask for
    // the rest as conversation bubbles before going to Find my trip.
    const remaining = buildRemainingSteps(parsed);

    if (remaining.length === 0) {
      // Everything known — mark complete so the Find-my-trip button appears.
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: "Perfect — I've got everything. Ready to find your trip?" },
      ]);
      setIsComplete(true);
      return;
    }

    // Switch into guided follow-up mode: use the existing step system so
    // questions render as chat bubbles and the matching picker widget (dates,
    // travelers, etc.) appears inline.
    setChatMode(false);
    if (!intent) setIntent('chat');
    setSteps(remaining);
    setCurrentStepIndex(0);

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'assistant', content: 'Great choices!' },
      { id: nextId(), role: 'assistant', content: remaining[0].question, stepId: remaining[0].id },
    ]);
  };

  const runOptimizeAndBuild = async (parsed: any) => {
    const travelers = parsed.travelers ?? answers.travelers ?? 1;
    setFindTripLoading(true);
    setFindTripError(null);

    try {
      // Normalize whatever the user / AI produced into YYYY-MM-DD. The
      // optimize endpoint validates this with zod, so any freeform value
      // (e.g. "Next month") would otherwise surface as "ValidationError".
      const rawStart =
        parsed.dates?.start ??
        answers.dateRange?.start ??
        '';
      const startDate = parseDateInput(rawStart);

      // Normalize budget to a TOTAL trip budget (USD). If the user said
      // "$1500 per person", multiply by travelers. The AI interpret
      // response already returns a total budget, so only the guided-step
      // path needs this adjustment.
      const rawBudget = parsed.budget ?? answers.budget;
      const budgetPerPerson = answers.budgetPerPerson === true;
      const totalBudget =
        typeof rawBudget === 'number' && budgetPerPerson
          ? rawBudget * travelers
          : rawBudget;

      let trip: Trip;

      // Optimizer needs ≥2 cities. For single-city trips, build the trip
      // directly without routing (just hotel + dates).
      if (parsed.destinations.length < 2) {
        const cityName = parsed.destinations[0];
        const arrival = startDate;
        const departureDate = new Date(startDate);
        departureDate.setDate(departureDate.getDate() + 3);
        const departure = departureDate.toISOString().split('T')[0];

        trip = {
          title: cityName,
          status: 'planning',
          totalCost: 0,
          savings: 0,
          travelers,
          cities: [
            {
              name: cityName,
              country: '',
              dates: { arrival, departure },
              transportIn: { mode: 'flight', operator: '', duration: '', price: 0 },
              transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
              hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
              hotels: [],
              selectedHotelIndex: 0,
              activities: [],
              restaurants: [],
              vibes: [],
            },
          ],
          savingsTips: [],
        };
      } else {
        // Step 2: Optimize route
        setFindTripStatus('Finding the best routes...');
        const result = await optimizeTrip({
          cities: parsed.destinations.map((d: string) => ({ name: d })),
          startDate,
          travelers,
          budget: totalBudget,
        });

        trip = buildTripFromOptimize(result, travelers);
      }

      // Compute a per-night hotel cap from the total budget.
      // Rule of thumb: hotels get ~40% of the total trip budget. For a
      // 3-city, 6-night trip with a $3000 budget → $200/night cap for
      // searchHotels so we don't show $600/night suggestions.
      const totalNights = trip.cities.reduce((sum, c) => {
        const nights = Math.max(
          1,
          Math.round(
            (new Date(c.dates.departure).getTime() - new Date(c.dates.arrival).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        );
        return sum + nights;
      }, 0);
      const hotelNightlyCap =
        typeof totalBudget === 'number' && totalNights > 0
          ? Math.max(40, Math.floor((totalBudget * 0.4) / totalNights))
          : undefined;

      // Step 3: Fetch hotels for each city, respecting the nightly cap
      setFindTripStatus('Finding hotels...');
      const hotelPromises = trip.cities.map(async (city) => {
        try {
          const results = await searchHotels({
            city: city.name,
            checkin: city.dates.arrival,
            checkout: city.dates.departure,
            adults: travelers,
            // maxPrice in searchHotels is total-stay not per-night — compute
            // nights-for-this-city × nightly cap as the stay cap.
            ...(hotelNightlyCap !== undefined
              ? {
                  maxPrice:
                    hotelNightlyCap *
                    Math.max(
                      1,
                      Math.round(
                        (new Date(city.dates.departure).getTime() -
                          new Date(city.dates.arrival).getTime()) /
                          (1000 * 60 * 60 * 24),
                      ),
                    ),
                }
              : {}),
          });
          if (results.length > 0) {
            const hotels = results.map((r) => ({
              name: r.name,
              rating: r.rating,
              pricePerNight: r.pricePerNight,
              area: '',
              bookingUrl: r.bookingUrl,
            }));
            return { hotels, hotel: hotels[0], selectedHotelIndex: 0 };
          }
        } catch {
          // Hotel search failure is non-fatal
        }
        return null;
      });

      const hotelResults = await Promise.all(hotelPromises);
      hotelResults.forEach((hotelResult, idx) => {
        if (hotelResult) {
          trip.cities[idx] = { ...trip.cities[idx], ...hotelResult };
        }
      });

      // Step 4: fetch AI-picked activities AND restaurants per city in parallel
      setFindTripStatus('Finding things to do & places to eat...');
      const perCityPromises = trip.cities.map(async (city) => {
        const nights = Math.max(
          1,
          Math.round(
            (new Date(city.dates.departure).getTime() - new Date(city.dates.arrival).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        );
        const vibeHint = parsed.vibe ?? answers.vibe;
        const budgetHint = totalBudget;

        const [activitiesResult, restaurantsResult] = await Promise.all([
          searchActivities({ city: city.name, vibe: vibeHint, travelers, nights }).catch(
            () => [] as ActivitySuggestion[],
          ),
          searchRestaurants({ city: city.name, vibe: vibeHint, travelers, budget: budgetHint }).catch(
            () => [] as RestaurantSuggestion[],
          ),
        ]);

        return { activities: activitiesResult, restaurants: restaurantsResult };
      });

      const perCityResults = await Promise.all(perCityPromises);
      perCityResults.forEach(({ activities, restaurants }, idx) => {
        if (activities.length > 0) {
          trip.cities[idx].activities = activities.map((s) => s.name);
        }
        if (restaurants.length > 0) {
          trip.cities[idx].restaurants = restaurants.map(
            (r): Restaurant => ({
              name: r.name,
              cuisine: r.cuisine,
              priceRange: r.priceRange,
            }),
          );
        }
        if (activities.length > 0 || restaurants.length > 0) {
          trip.cities[idx].schedule = buildScheduleFromActivities(
            activities,
            restaurants,
            trip.cities[idx].dates.arrival,
            trip.cities[idx].dates.departure,
          );
        }
      });

      // Attach the user's (normalized) total-trip budget so the results
      // page can show a "you're over budget" warning banner if totalCost
      // ends up higher than what they said they wanted to spend.
      if (typeof totalBudget === 'number' && totalBudget > 0) {
        trip.budget = totalBudget;
      }

      setTrip(trip);
      router.push('/results');
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Something went wrong.';
      // Translate technical errors into human-readable messages
      const friendly = (() => {
        if (raw === 'ValidationError' || raw.toLowerCase().includes('validation')) {
          return "I couldn't make sense of one of your answers. Try rephrasing the dates or budget?";
        }
        if (raw.toLowerCase().includes('fetch')) {
          return "I couldn't reach the travel service. Check your connection and try again.";
        }
        return raw;
      })();
      setFindTripError(friendly);
      setMessages((prev) => {
        // Avoid stacking identical error bubbles if the user spams the button.
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.content.includes(friendly)) return prev;
        return [
          ...prev,
          { id: nextId(), role: 'assistant', content: `Sorry, I ran into a problem: ${friendly}` },
        ];
      });
    } finally {
      setFindTripLoading(false);
      setFindTripStatus('');
    }
  };

  const handleFindTrip = async () => {
    // Prevent re-entrancy: if already running, ignore subsequent clicks.
    // Without this guard, a user double-clicking "Find my trip" spawns
    // parallel optimize attempts that each append their own error bubble.
    if (findTripLoading) return;
    setFindTripLoading(true);
    setFindTripError(null);

    try {
      // If destinations are already locked in (from the early interpret call
      // during the destination step, or from chat mode), skip the second
      // interpret call and go straight to optimize.
      const lockedDestinations = answers.destinations ?? [];
      if (lockedDestinations.length > 0) {
        await runOptimizeAndBuild({
          destinations: lockedDestinations,
          travelers: answers.travelers ?? 1,
          budget: answers.budget,
          dates: answers.dateRange
            ? { start: answers.dateRange.start, end: answers.dateRange.end }
            : undefined,
          vibe: answers.vibe,
        });
        return;
      }

      // Fallback: no destinations yet (e.g. user went through vibe/budget path
      // without specifying a location). Re-run interpret on whatever they did say.
      setFindTripStatus('Understanding your trip...');
      const rawInput = answers.rawInput ?? '';
      if (!rawInput.trim()) {
        throw new Error('Please tell me at least one city or country you want to visit.');
      }

      const parsed = await interpretPlan({
        rawInput,
        userLocation: 'unknown',
      });
      warnIfMock(parsed);

      // If countries were detected (e.g. user typed "Japan"), show city picker —
      // check this BEFORE the empty-destinations check, since the AI returns
      // destinations: [] when all inputs are country names.
      if (parsed.needsCitySelection && parsed.countries && parsed.countries.length > 0) {
        setFindTripLoading(false);
        setFindTripStatus('');

        // Pre-select the first city per country as default
        const defaultSelections: Record<string, string[]> = {};
        for (const c of parsed.countries) {
          defaultSelections[c.country] = [c.cities[0]];
        }

        // For any destinations that aren't from a country (direct city names), keep them
        const directCities = parsed.destinations.filter(
          (d: string) => !parsed.countries.some((c: any) => c.cities.includes(d))
        );

        if (directCities.length > 0) {
          defaultSelections['_direct'] = directCities;
        }

        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: `I see you want to visit ${parsed.countries.map((c: any) => c.country).join(' and ')}! Which cities would you like to include?`,
          },
        ]);

        setCitySelectionData({
          countries: parsed.countries,
          selectedCities: defaultSelections,
          parsedData: parsed,
        });
        return;
      }

      // No country was detected — require at least one destination city
      if (!parsed.destinations || parsed.destinations.length === 0) {
        throw new Error('Could not identify any destinations. Please try describing your trip again.');
      }

      // No country selection needed — go straight to optimize
      await runOptimizeAndBuild(parsed);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Something went wrong.';
      // Translate technical errors into human-readable messages
      const friendly = (() => {
        if (raw === 'ValidationError' || raw.toLowerCase().includes('validation')) {
          return "I couldn't make sense of one of your answers. Try rephrasing the dates or budget?";
        }
        if (raw.toLowerCase().includes('fetch')) {
          return "I couldn't reach the travel service. Check your connection and try again.";
        }
        return raw;
      })();
      setFindTripError(friendly);
      setMessages((prev) => {
        // Avoid stacking identical error bubbles if the user spams the button.
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.content.includes(friendly)) return prev;
        return [
          ...prev,
          { id: nextId(), role: 'assistant', content: `Sorry, I ran into a problem: ${friendly}` },
        ];
      });
      setFindTripLoading(false);
      setFindTripStatus('');
    }
  };

  const currentStep = steps.length ? steps[currentStepIndex] : null;

  // Background hue based on vibe
  const bgStyle = (() => {
    switch (vibe) {
      case 'Beachy': return 'radial-gradient(ellipse at 50% 80%, rgba(255,180,50,0.06) 0%, transparent 60%)';
      case 'Skiing': return 'radial-gradient(ellipse at 50% 80%, rgba(140,200,255,0.06) 0%, transparent 60%)';
      case 'Architecture': return 'radial-gradient(ellipse at 50% 80%, rgba(200,160,255,0.06) 0%, transparent 60%)';
      case 'Adventure': return 'radial-gradient(ellipse at 50% 80%, rgba(80,220,140,0.06) 0%, transparent 60%)';
      case 'Culture': return 'radial-gradient(ellipse at 50% 80%, rgba(244,114,182,0.06) 0%, transparent 60%)';
      default: return vibe ? 'radial-gradient(ellipse at 50% 80%, rgba(79,142,247,0.05) 0%, transparent 60%)' : 'none';
    }
  })();

  // The bottom bar is ALWAYS rendered (until the form is complete).
  // Placeholder + submit handler swap based on the current step so that the
  // user can always type a free-form answer for whatever question is showing.
  const barPlaceholder = (() => {
    if (chatMode) return 'Tell me everything — where, when, who, budget...';
    if (!intent) return 'Or just tell me everything at once...';
    if (!currentStep) return 'Type a message...';
    switch (currentStep.type) {
      case 'text':    return currentStep.placeholder || 'Type a destination...';
      case 'vibes':   return 'Or describe your vibe here...';
      case 'dates':   return 'Or type when, e.g. "April 7-30, one week"';
      case 'travelers': return 'Or type how many people, e.g. "4"';
      case 'budget':  return 'Or type your budget, e.g. "$1500"';
      case 'notes':   return currentStep.placeholder || 'Anything else?';
      default:        return 'Type a message...';
    }
  })();

  const handleBarSubmit = () => {
    const value = textInput.trim();
    if (!value) return;

    // Open chat mode — capture as a single big message
    if (chatMode) {
      handleChatSubmit();
      return;
    }

    // Pre-intent — typing here switches into open chat mode
    if (!intent) {
      setShowIntent(false);
      setIntent('chat');
      setChatMode(true);
      handleChatSubmit();
      return;
    }

    if (!currentStep) return;

    switch (currentStep.type) {
      case 'text':
      case 'notes':
        handleTextSubmit();
        return;
      case 'vibes':
        handleVibeSelect(value);
        setTextInput('');
        return;
      case 'dates': {
        // Convert freeform phrases ("next month", "June 2026") into the
        // YYYY-MM-DD format the backend expects. Without this, typing
        // something like "Next month" in the chat bar would be stored
        // verbatim and later rejected by the optimize endpoint's zod schema.
        const isoStart = parseDateInput(value);
        handleDatesSelect(isoStart, isoStart, true);
        setTextInput('');
        return;
      }
      case 'travelers': {
        const match = value.match(/\d+/);
        const count = match ? Math.min(parseInt(match[0], 10), 99) : 1;
        handleTravelersSelect(count || 1);
        setTextInput('');
        return;
      }
      case 'budget': {
        // For the budgetPerPerson clarification step, parse the user's free
        // text (they might type "per person" or "total"). Otherwise parse a
        // number out of the message for the primary budget step.
        if (currentStep.id === 'budgetPerPerson') {
          const lower = value.toLowerCase();
          const perPerson = /per\s*person|each|pp\b/.test(lower) && !/total|combined/.test(lower);
          handleBudgetPerPersonConfirm(perPerson);
          setTextInput('');
          return;
        }
        const match = value.replace(/[, ]/g, '').match(/\d+/);
        const amount = match ? parseInt(match[0], 10) : 0;
        const perPerson = /per\s*person|each|pp\b/.test(value.toLowerCase());
        handleBudgetSelect(amount || 0, perPerson);
        setTextInput('');
        return;
      }
    }
  };

  return (
    <div className="relative flex flex-col h-screen" style={{ background: '#0f0f1a' }}>
      {/* Subtle vibe background shift */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{ background: bgStyle }}
        animate={{ opacity: vibe ? 1 : 0 }}
        transition={{ duration: 1.5 }}
      />

      {/* Header */}
      <div className="relative z-10 flex items-center justify-center pt-10 pb-5">
        <Link href="/" className="text-4xl font-bold tracking-tight hover:opacity-80 transition-opacity" style={{ color: '#4f8ef7' }}>
          VOYZA
        </Link>
      </div>

      {/* Chat area — flex-1 + min-h-0 lets the column actually scroll instead
          of pushing the pinned bottom bar off-screen. */}
      <div ref={scrollRef} className="relative z-10 flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        <div className="max-w-3xl mx-auto flex flex-col gap-5 pt-6">
          <AnimatePresence mode="popLayout">
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'user' && editingMsgId === msg.id ? (
                  /* Inline edit mode for user messages */
                  <div className="max-w-[80%] flex flex-col gap-2">
                    <textarea
                      autoFocus
                      value={editingMsgValue}
                      onChange={(e) => setEditingMsgValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          const trimmed = editingMsgValue.trim();
                          if (trimmed) {
                            setMessages((prev) =>
                              prev.map((m) =>
                                m.id === msg.id ? { ...m, content: trimmed } : m
                              )
                            );
                          }
                          setEditingMsgId(null);
                        }
                        if (e.key === 'Escape') setEditingMsgId(null);
                      }}
                      className="w-full bg-[#4f8ef7]/80 text-white rounded-2xl rounded-br-md px-5 py-3.5 text-[17px] leading-relaxed resize-none outline-none border-2 border-white/30 focus:border-white/60"
                      rows={2}
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingMsgId(null)}
                        className="flex items-center gap-1 text-[12px] text-white/50 hover:text-white/80 transition-colors px-2 py-1"
                      >
                        <X size={12} />
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const trimmed = editingMsgValue.trim();
                          if (trimmed) {
                            setMessages((prev) =>
                              prev.map((m) =>
                                m.id === msg.id ? { ...m, content: trimmed } : m
                              )
                            );
                          }
                          setEditingMsgId(null);
                        }}
                        className="flex items-center gap-1 text-[12px] text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1 transition-all"
                      >
                        <Check size={12} />
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Normal message display */
                  <div className="group relative max-w-[80%]">
                    <div
                      className={`w-fit px-5 py-3.5 rounded-2xl text-[17px] leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-[#4f8ef7] text-white rounded-br-md ml-auto'
                          : 'text-white/80'
                      }`}
                      style={msg.role === 'assistant' ? { background: 'rgba(255,255,255,0.05)' } : undefined}
                    >
                      {msg.content}
                    </div>
                    {/* Edit button — only on user messages */}
                    {msg.role === 'user' && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMsgId(msg.id);
                          setEditingMsgValue(msg.content);
                        }}
                        className="absolute -left-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ background: 'rgba(255,255,255,0.1)' }}
                        title="Edit message"
                      >
                        <Pencil size={11} className="text-white/60" />
                      </button>
                    )}
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Intent picker */}
          {showIntent && !intent && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="mt-2"
            >
              <IntentPicker onSelect={handleIntentSelect} />
            </motion.div>
          )}

          {/* Interactive input area for guided steps — only render once the
              assistant question for this step has actually appeared in the
              chat, so the widget never shows up before its question. */}
          {!isComplete && !chatMode && intent && currentStep &&
            messages.some((m) => m.stepId === currentStep.id) && (
            <motion.div
              key={`input-${currentStepIndex}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="mt-1"
            >
              {currentStep.type === 'vibes' && (
                <VibePills onSelect={handleVibeSelect} />
              )}
              {currentStep.type === 'dates' && (
                <DatePicker onSelect={handleDatesSelect} onSkip={handleSkip} />
              )}
              {currentStep.type === 'travelers' && (
                <TravelersPicker onSelect={handleTravelersSelect} />
              )}
              {currentStep.type === 'budget' && currentStep.id === 'budget' && (
                <BudgetPicker onSelect={handleBudgetSelect} onSkip={currentStep.skippable ? handleSkip : undefined} />
              )}
              {currentStep.type === 'budget' && currentStep.id === 'budgetPerPerson' && (
                <div className="flex gap-3 w-full">
                  <button
                    onClick={() => handleBudgetPerPersonConfirm(true)}
                    className="flex-1 flex flex-col items-center gap-1 py-5 rounded-2xl border border-white/10 text-white/80 hover:text-white hover:border-[#4f8ef7]/40 transition-all hover:scale-[1.03] active:scale-[0.97]"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  >
                    <span className="text-[15px] font-medium">Per person</span>
                    <span className="text-white/40 text-[12px]">Each traveler has that much to spend</span>
                  </button>
                  <button
                    onClick={() => handleBudgetPerPersonConfirm(false)}
                    className="flex-1 flex flex-col items-center gap-1 py-5 rounded-2xl border border-white/10 text-white/80 hover:text-white hover:border-[#4f8ef7]/40 transition-all hover:scale-[1.03] active:scale-[0.97]"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  >
                    <span className="text-[15px] font-medium">Total for the trip</span>
                    <span className="text-white/40 text-[12px]">Combined for everyone</span>
                  </button>
                </div>
              )}
            </motion.div>
          )}

          {/* City selection picker — shown when countries are detected */}
          {citySelectionData && (
            <motion.div
              className="mt-6 mb-4 w-full max-w-2xl mx-auto"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              {citySelectionData.countries.map((countryData) => (
                <div key={countryData.country} className="mb-5">
                  <div className="flex items-center gap-2 mb-3">
                    <MapPin size={16} className="text-[#4f8ef7]" />
                    <span className="text-white/90 font-medium text-[15px]">{countryData.country}</span>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    {countryData.cities.map((city) => {
                      const isSelected = (citySelectionData.selectedCities[countryData.country] ?? []).includes(city);
                      return (
                        <button
                          key={city}
                          onClick={() => handleCityToggle(countryData.country, city)}
                          className={`px-4 py-2 rounded-full text-[13px] font-medium transition-all border ${
                            isSelected
                              ? 'bg-[#4f8ef7] border-[#4f8ef7] text-white shadow-md shadow-blue-500/20'
                              : 'bg-white/5 border-white/15 text-white/70 hover:bg-white/10 hover:border-white/25'
                          }`}
                        >
                          {city}
                          {isSelected && <Check size={12} className="inline ml-1.5 -mt-0.5" />}
                        </button>
                      );
                    })}
                    {/* Inline "type another city" input */}
                    <input
                      type="text"
                      value={customCityInputs[countryData.country] ?? ''}
                      onChange={(e) =>
                        setCustomCityInputs((prev) => ({
                          ...prev,
                          [countryData.country]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddCustomCity(countryData.country);
                        }
                      }}
                      placeholder="+ another city"
                      className="bg-transparent border border-dashed border-white/20 text-white/70 placeholder-white/30 text-[13px] rounded-full px-4 py-2 outline-none focus:border-[#4f8ef7]/60 min-w-[140px]"
                    />
                  </div>
                </div>
              ))}

              {/* Direct cities the user mentioned by name (e.g. "Shanghai"
                  when they typed "Japan and Shanghai") — rendered as their
                  own section so they're visible and toggleable. */}
              {citySelectionData.selectedCities['_direct'] &&
                citySelectionData.selectedCities['_direct'].length > 0 && (
                <div className="mb-5">
                  <div className="flex items-center gap-2 mb-3">
                    <MapPin size={16} className="text-[#4f8ef7]" />
                    <span className="text-white/90 font-medium text-[15px]">Also visiting</span>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    {citySelectionData.selectedCities['_direct'].map((city) => (
                      <button
                        key={city}
                        onClick={() => {
                          // Toggle direct city on/off
                          const current = citySelectionData.selectedCities['_direct'] ?? [];
                          const updated = current.includes(city)
                            ? current.filter((c) => c !== city)
                            : [...current, city];
                          setCitySelectionData({
                            ...citySelectionData,
                            selectedCities: { ...citySelectionData.selectedCities, _direct: updated },
                          });
                        }}
                        className="px-4 py-2 rounded-full text-[13px] font-medium transition-all border bg-[#4f8ef7] border-[#4f8ef7] text-white shadow-md shadow-blue-500/20"
                      >
                        {city}
                        <Check size={12} className="inline ml-1.5 -mt-0.5" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-center mt-4">
                <button
                  onClick={handleCitySelectionConfirm}
                  disabled={Object.values(citySelectionData.selectedCities).flat().length === 0}
                  className="flex items-center gap-3 bg-[#4f8ef7] hover:bg-[#3d7de6] text-white font-semibold px-10 py-4 rounded-full text-[16px] shadow-lg shadow-blue-500/25 transition-all hover:scale-[1.03] active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Continue with these cities
                  <ArrowRight size={20} />
                </button>
              </div>
            </motion.div>
          )}

          {/* Find my trip button */}
          {isComplete && !citySelectionData && (
            <motion.div
              className="flex flex-col items-center mt-8 mb-10 gap-3"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.8 }}
            >
              <button
                onClick={handleFindTrip}
                disabled={findTripLoading}
                className="flex items-center gap-3 bg-[#4f8ef7] hover:bg-[#3d7de6] text-white font-semibold px-12 py-5 rounded-full text-[18px] shadow-lg shadow-blue-500/25 transition-all hover:scale-[1.03] active:scale-[0.97] disabled:opacity-60 disabled:hover:scale-100 disabled:cursor-not-allowed"
              >
                {findTripLoading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {findTripStatus || 'Working on it...'}
                  </>
                ) : (
                  <>
                    Find my trip
                    <ArrowRight size={22} />
                  </>
                )}
              </button>
              {findTripError && (
                <p className="text-red-400 text-sm text-center max-w-md">{findTripError}</p>
              )}
            </motion.div>
          )}
        </div>
      </div>

      {/* Floating chat pill — ALWAYS pinned to the bottom of the viewport
          (until the form is complete). Mounts ONCE; placeholder text just
          swaps in place so we don't get a re-fade on every step change. */}
      {!isComplete && (
        <div className="relative z-10 px-6 pb-6 pt-2 flex justify-center pointer-events-none">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="pointer-events-auto w-full max-w-2xl flex items-end gap-3 px-5 py-3 rounded-3xl border border-white/15 shadow-2xl shadow-black/40"
            style={{
              background: 'rgba(255,255,255,0.06)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits, Shift+Enter inserts a newline
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleBarSubmit();
                }
              }}
              placeholder={barPlaceholder}
              className="flex-1 min-w-0 w-full bg-transparent border-none outline-none resize-none text-white text-[16px] placeholder-white/35 py-1.5 leading-[1.4] max-h-[102px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{ caretColor: 'rgba(255,255,255,0.7)' }}
            />
            <button
              onClick={handleBarSubmit}
              disabled={!textInput.trim()}
              className="p-2.5 rounded-full bg-[#4f8ef7] hover:bg-[#3d7de6] text-white disabled:opacity-30 disabled:hover:bg-[#4f8ef7] transition-all flex-shrink-0"
            >
              <Send size={18} />
            </button>
          </motion.div>
        </div>
      )}

      {/* Skip button for non-text skippable steps */}
      {!isComplete && !chatMode && intent && currentStep && currentStep.skippable && currentStep.type !== 'text' && currentStep.type !== 'notes' && currentStep.type !== 'dates' && currentStep.type !== 'budget' && (
        <motion.div
          className="relative z-10 flex justify-center pb-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2 }}
        >
          <button
            onClick={handleSkip}
            className="flex items-center gap-1.5 text-white/25 hover:text-white/40 text-[15px] transition-colors"
          >
            Skip this <SkipForward size={16} />
          </button>
        </motion.div>
      )}
    </div>
  );
}
