'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Send, SkipForward, Pencil, Check, X } from 'lucide-react';
import { useTripStore } from '@/store/tripStore';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { mockTrip } from '@/lib/mockData';
import { interpretPlan, optimizeTrip } from '@/lib/api';
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
  const msgCounter = useRef(0);

  const nextId = () => `msg-${++msgCounter.current}`;

  // Seed the conversation
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    if (answers.rawInput) {
      // User already typed a destination on the welcome page — skip intent, go straight to place path
      const rawInput = answers.rawInput;
      const placeSteps = PLACE_STEPS.slice(1); // skip destination step
      setIntent('place');
      setSteps(placeSteps);
      setCurrentStepIndex(0);

      setMessages([
        { id: nextId(), role: 'assistant', content: `Love it — "${rawInput}". Let's make it happen.` },
      ]);
      setAnswer('destinations', [rawInput]);
      setAnswer('rawInput', undefined);

      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: placeSteps[0].question, stepId: placeSteps[0].id },
        ]);
      }, 800);
    } else {
      // Fresh start — ask for intent
      setMessages([
        { id: nextId(), role: 'assistant', content: "What kind of trip are you planning?", stepId: 'intent' },
      ]);
      setTimeout(() => setShowIntent(true), 500);
    }
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

  const advanceToNextStep = (fromIndex: number) => {
    const nextIndex = fromIndex + 1;
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
  const handleTextSubmit = () => {
    if (!textInput.trim() || !steps.length) return;
    const step = steps[currentStepIndex];

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: textInput.trim() },
    ]);

    if (step.id === 'destination') {
      setAnswer('destinations', [textInput.trim()]);
    } else if (step.id === 'notes') {
      setAnswer('extraNotes', textInput.trim());
    }

    setTextInput('');
    advanceToNextStep(currentStepIndex);
  };

  // Open chat submit — user types everything at once
  const handleChatSubmit = () => {
    if (!textInput.trim()) return;
    const userMessage = textInput.trim();

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: userMessage },
    ]);

    // Store the raw chat message — the AI will parse this later
    setAnswer('rawInput', userMessage);
    setTextInput('');

    // For now, show an acknowledgment and proceed to "Find my trip"
    // Later: call the AI to parse the message and extract destinations, dates, budget, etc.
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: "Got it — I have a good picture of what you're after. Let me find the best options." },
      ]);
      setTimeout(() => {
        setIsComplete(true);
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: "Ready when you are." },
        ]);
      }, 800);
    }, 600);
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

  const handleSkip = () => {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: 'Skip' },
    ]);
    advanceToNextStep(currentStepIndex);
  };

  const handleFindTrip = async () => {
    // Try backend API first, fall back to mock
    try {
      const parsed = await interpretPlan({
        rawInput: answers.rawInput ?? answers.destinations?.join(', ') ?? '',
        userLocation: 'unknown',
      });

      if (parsed.destinations && parsed.destinations.length >= 2) {
        const result = await optimizeTrip({
          cities: parsed.destinations.map((d: string) => ({ name: d })),
          startDate: parsed.dates?.start ?? new Date().toISOString().split('T')[0],
          travelers: parsed.travelers ?? answers.travelers ?? 1,
          budget: parsed.budget ?? answers.budget,
        });
        // For now, use mock trip but with optimized ordering info
        // Full integration would build the trip from optimization results
        setTrip(mockTrip);
        router.push('/results');
        return;
      }
    } catch {
      // Fall back to mock
    }

    setTrip(mockTrip);
    router.push('/results');
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
      case 'dates':
        handleDatesSelect(value, '', true);
        setTextInput('');
        return;
      case 'travelers': {
        const match = value.match(/\d+/);
        const count = match ? Math.min(parseInt(match[0], 10), 99) : 1;
        handleTravelersSelect(count || 1);
        setTextInput('');
        return;
      }
      case 'budget': {
        const match = value.replace(/[, ]/g, '').match(/\d+/);
        const amount = match ? parseInt(match[0], 10) : 0;
        handleBudgetSelect(amount || 0, false);
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
              {currentStep.type === 'budget' && (
                <BudgetPicker onSelect={handleBudgetSelect} onSkip={currentStep.skippable ? handleSkip : undefined} />
              )}
            </motion.div>
          )}

          {/* Find my trip button */}
          {isComplete && (
            <motion.div
              className="flex justify-center mt-8 mb-10"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.8 }}
            >
              <button
                onClick={handleFindTrip}
                className="flex items-center gap-3 bg-[#4f8ef7] hover:bg-[#3d7de6] text-white font-semibold px-12 py-5 rounded-full text-[18px] shadow-lg shadow-blue-500/25 transition-all hover:scale-[1.03] active:scale-[0.97]"
              >
                Find my trip
                <ArrowRight size={22} />
              </button>
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
