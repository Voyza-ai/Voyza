'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, ChevronLeft, RefreshCw, Plus, MessageSquare } from 'lucide-react';
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
      {/* Toggle button on right edge */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed right-0 top-1/2 -translate-y-1/2 z-30 w-8 h-20 rounded-l-lg flex items-center justify-center transition-colors"
        style={{
          background: 'rgba(255,255,255,0.08)',
          borderLeft: '1px solid rgba(255,255,255,0.12)',
        }}
      >
        {isOpen ? (
          <ChevronRight size={14} className="text-white/60" />
        ) : (
          <ChevronLeft size={14} className="text-white/60" />
        )}
      </button>

      {/* Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: 320 }}
            animate={{ x: 0 }}
            exit={{ x: 320 }}
            transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            className="fixed right-0 top-0 bottom-0 w-[300px] z-20 flex flex-col"
            style={{
              background: 'rgba(18,18,18,0.95)',
              borderLeft: '1px solid rgba(255,255,255,0.1)',
              backdropFilter: 'blur(20px)',
            }}
          >
            {/* Header */}
            <div className="px-4 pt-16 pb-3 flex items-center justify-between">
              <div className="text-white/80 text-[13px] font-medium">
                Suggested Cities
              </div>
              <button
                onClick={fetchSuggestions}
                disabled={loading}
                className="text-white/40 hover:text-white/70 transition-colors disabled:opacity-30"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>

            {/* City cards */}
            <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-3">
              {destinations.slice(0, 8).map((dest) => (
                <div
                  key={dest.name}
                  className="rounded-xl border p-3"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    borderColor: 'rgba(255,255,255,0.08)',
                  }}
                >
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-white text-[13px] font-medium">
                      {dest.name}
                    </span>
                    <span className="text-white/50 text-[11px]">
                      ~${dest.estimatedCost}
                    </span>
                  </div>
                  <div className="text-white/40 text-[11px] mb-2.5 leading-relaxed">
                    {dest.reason}
                  </div>
                  {canEdit ? (
                    <button
                      onClick={() => onAddCity(dest)}
                      className="flex items-center gap-1.5 text-[11px] text-[#4f8ef7] hover:text-[#6fa3ff] transition-colors"
                    >
                      <Plus size={11} />
                      Add to canvas
                    </button>
                  ) : role === 'suggester' ? (
                    <button
                      onClick={() => onSuggestCity(dest)}
                      className="flex items-center gap-1.5 text-[11px] text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      <MessageSquare size={11} />
                      Suggest
                    </button>
                  ) : null}
                </div>
              ))}

              {destinations.length === 0 && !loading && (
                <div className="text-white/30 text-[12px] text-center py-8">
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
