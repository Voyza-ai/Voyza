'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X, RefreshCw, Plus, MessageSquare } from 'lucide-react';
import { suggestDestinations, Destination } from '@/lib/api';

type SuggestedCitiesPanelProps = {
  tripId: string;
  currentCities: string[];
  budget?: number;
  role: string;
  onAddCity: (city: Destination) => void;
  onSuggestCity: (city: Destination) => void;
};

export default function SuggestedCitiesPanel({
  currentCities,
  budget,
  role,
  onAddCity,
  onSuggestCity,
}: SuggestedCitiesPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(false);
  const canEdit = role === 'owner' || role === 'editor';

  const fetchSuggestions = async () => {
    setLoading(true);
    try {
      const results = await suggestDestinations({
        currentCities,
        budget,
      });
      setDestinations(results);
    } catch {
      // fail silently
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && destinations.length === 0) {
      fetchSuggestions();
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* Pull-out tab — docked to the right edge while the panel is closed.
          Labeled (icon + vertical text) so it reads as "there's a Suggested
          Cities drawer here", not an anonymous 8px chevron strip. */}
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ x: 48 }}
            animate={{ x: 0 }}
            exit={{ x: 48 }}
            transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            onClick={() => setIsOpen(true)}
            aria-label="Open suggested cities"
            className="fixed right-0 top-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-1.5 rounded-l-xl py-3.5 px-1.5 shadow-md hover:shadow-lg transition-shadow"
            style={{
              background: '#ffffff',
              border: '1px solid rgba(0,0,0,0.08)',
              borderRight: 'none',
            }}
          >
            <Sparkles size={13} style={{ color: '#2563eb' }} />
            <span
              className="text-[10px] font-medium text-gray-600 tracking-wide"
              style={{ writingMode: 'vertical-rl' }}
            >
              Suggested Cities
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: 320 }}
            animate={{ x: 0 }}
            exit={{ x: 320 }}
            transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            className="fixed right-0 top-0 bottom-0 w-[300px] z-20 flex flex-col shadow-xl"
            style={{
              background: '#ffffff',
              borderLeft: '1px solid rgba(0,0,0,0.08)',
            }}
          >
            {/* Header — refresh + explicit close */}
            <div className="px-4 pt-16 pb-3 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-gray-700 text-[13px] font-medium">
                <Sparkles size={13} style={{ color: '#2563eb' }} />
                Suggested Cities
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={fetchSuggestions}
                  disabled={loading}
                  aria-label="Refresh suggestions"
                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-30"
                >
                  <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  aria-label="Close suggested cities"
                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* City cards */}
            <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-3">
              {destinations.slice(0, 8).map((dest) => (
                <div
                  key={dest.name}
                  className="rounded-xl border p-3"
                  style={{
                    background: '#f8fafc',
                    borderColor: 'rgba(0,0,0,0.06)',
                  }}
                >
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-gray-900 text-[13px] font-medium">
                      {dest.name}
                    </span>
                    <span className="text-gray-400 text-[11px]">
                      ~${dest.estimatedCost}
                    </span>
                  </div>
                  <div className="text-gray-500 text-[11px] mb-2.5 leading-relaxed">
                    {dest.reason}
                  </div>
                  {canEdit ? (
                    <button
                      onClick={() => onAddCity(dest)}
                      className="flex items-center gap-1.5 text-[11px] text-[#2563eb] hover:text-[#1d4ed8] transition-colors"
                    >
                      <Plus size={11} />
                      Add to canvas
                    </button>
                  ) : role === 'suggester' ? (
                    <button
                      onClick={() => onSuggestCity(dest)}
                      className="flex items-center gap-1.5 text-[11px] text-amber-500 hover:text-amber-600 transition-colors"
                    >
                      <MessageSquare size={11} />
                      Suggest
                    </button>
                  ) : null}
                </div>
              ))}

              {destinations.length === 0 && !loading && (
                <div className="text-gray-400 text-[12px] text-center py-8">
                  No suggestions yet
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
