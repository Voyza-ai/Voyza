'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Sparkles, Bot } from 'lucide-react';
import { Trip } from '@/lib/types';
import { editPlan } from '@/lib/api';
import { useTripStore } from '@/store/tripStore';

type Message = {
  id: number;
  role: 'user' | 'ai';
  content: string;
};

type AIChatPanelProps = {
  trip: Trip;
};

const SUGGESTED_PROMPTS = [
  'Why is this trip cheaper?',
  'Why this order of cities?',
  'Make Barcelona cheaper',
  'Add a beach day',
];

// Mock AI response generator — keyword based, just for the demo
const generateMockResponse = (input: string, trip: Trip): string => {
  const lower = input.toLowerCase();

  // "Why is this trip cheaper" — surface the savingsTips that used to live in the page footer
  if (
    (lower.includes('why') && (lower.includes('cheaper') || lower.includes('save'))) ||
    lower.includes('why this trip')
  ) {
    if (trip.savingsTips.length > 0) {
      const numbered = trip.savingsTips
        .map((t, i) => `${String(i + 1).padStart(2, '0')}. ${t}`)
        .join('\n');
      return `Here's why I was able to save you $${trip.savings} vs the default routing:\n\n${numbered}\n\nWant me to walk you through any of these in more detail?`;
    }
    return `I saved you $${trip.savings} vs the default routing by mixing trains and flights, picking the right day-of-week, and ordering the cities to avoid backtracking. Ask me about any leg for specifics.`;
  }

  if (lower.includes('order') || (lower.includes('why') && lower.includes('citi'))) {
    return `Good question. I sequenced ${trip.cities.map((c) => c.name).join(' → ')} because the Rome→Florence train is dramatically cheaper than flying ($35 vs ~$120) and saves you a half-day at airports. Then Florence→Barcelona→Lisbon flows west, which keeps each flight under 2 hours and avoids backtracking. Reversing this would cost about $249 more.`;
  }

  if (lower.includes('cheaper') || lower.includes('save') || lower.includes('budget')) {
    return `A few ways to trim cost: switching your Barcelona hotel from Casa Bonay to a similar 4★ in Gràcia would save about $32/night ($96 across 3 nights). Flying out of Lisbon on a Wednesday instead of Thursday is ~$45 cheaper per person. Want me to apply either of these?`;
  }

  if (lower.includes('beach') || lower.includes('sun')) {
    return `Easy add — Barcelona's Barceloneta beach is a 15-min walk from Casa Bonay, so I can slot a half-day there on your second day. If you want a real beach day, Sitges is a 35-min train south of Barcelona ($8 round trip). Want me to add it as a side trip?`;
  }

  if (lower.includes('swap') || lower.includes('replace') || lower.includes('change')) {
    return `Sure — which city should I swap out? Common alternatives for this route: Bologna or Milan in place of Florence, Valencia or Madrid in place of Barcelona, Porto in place of Lisbon. Each will reshuffle the optimal transport mix, so I'll re-run the optimization.`;
  }

  if (lower.includes('train')) {
    return `The only train segment in your trip is Rome → Florence on Trenitalia's Frecciarossa (1h 32m, $35). I could also route Barcelona → Madrid → Lisbon by high-speed rail, but that adds about 6 hours and only saves $18/person — flights win there. Want me to show you the comparison?`;
  }

  if (lower.includes('hotel') || lower.includes('stay')) {
    return `Your current stays average $99/night with a 4.35★ rating. The most expensive is Casa Bonay in Barcelona at $110/night — it's well-rated for the Eixample area. I picked each hotel for walkability to your top activities. Want me to swap any for cheaper or fancier options?`;
  }

  return `I can help you rework the trip — try asking about pricing, the city order, swapping a destination, or adjusting hotels. I have the full optimization context for ${trip.cities.length} cities and can re-run any leg.`;
};

export default function AIChatPanel({ trip }: AIChatPanelProps) {
  const setTrip = useTripStore((s) => s.setTrip);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: 'ai',
      content: `I built this ${trip.cities.length}-city trip to save you $${trip.savings} vs the most common routing. Ask me anything — why I chose this order, how to make it cheaper, or how to swap a stop.`,
    },
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const idRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const handleSend = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isTyping) return;

    const userMsg: Message = { id: idRef.current++, role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    try {
      const result = await editPlan({ message: trimmed, currentTrip: trip });
      const reply = result.message ?? result.reply ?? 'Done — I have updated your trip.';

      // If the backend returned an updated trip, apply it to the store
      if (result.trip) {
        setTrip(result.trip);
      }

      const aiMsg: Message = { id: idRef.current++, role: 'ai', content: reply };
      setMessages((prev) => [...prev, aiMsg]);
    } catch {
      // Fallback to local mock response when backend is unavailable
      const aiMsg: Message = {
        id: idRef.current++,
        role: 'ai',
        content: generateMockResponse(trimmed, trip),
      };
      setMessages((prev) => [...prev, aiMsg]);
    } finally {
      setIsTyping(false);
    }
  }, [isTyping, trip, setTrip]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSend(input);
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
      {/* Header — blue like navbar */}
      <div
        className="px-5 py-4 flex items-center gap-2.5"
        style={{ background: '#2e6bc4' }}
      >
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center"
          style={{
            background: 'rgba(255,255,255,0.2)',
            border: '1px solid rgba(255,255,255,0.3)',
          }}
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
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[88%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'text-gray-900 rounded-br-md'
                    : 'text-gray-700 rounded-bl-md'
                }`}
                style={{
                  background:
                    msg.role === 'user'
                      ? 'rgba(46,107,196,0.12)'
                      : 'rgba(0,0,0,0.03)',
                  border:
                    msg.role === 'user'
                      ? '1px solid rgba(46,107,196,0.2)'
                      : '1px solid rgba(0,0,0,0.06)',
                }}
              >
                {msg.content}
              </div>
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
                style={{
                  background: 'rgba(0,0,0,0.03)',
                  border: '1px solid rgba(0,0,0,0.06)',
                }}
              >
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-gray-400"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{
                      duration: 1.1,
                      repeat: Infinity,
                      delay: i * 0.18,
                    }}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Suggested prompts */}
      {messages.length <= 1 && (
        <div className="px-5 pb-3 flex flex-wrap gap-1.5">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              onClick={() => handleSend(prompt)}
              className="text-[11px] text-[#2e6bc4] hover:text-[#1e5ab3] px-2.5 py-1.5 rounded-full border transition-colors"
              style={{ background: 'rgba(46,107,196,0.08)', borderColor: 'rgba(46,107,196,0.25)' }}
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
