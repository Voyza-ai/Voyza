'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, MapPin, Loader2, Moon, Minus, Plus, Sparkles } from 'lucide-react';
import { suggestDestinations, Destination } from '@/lib/api';

type AddCityModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (city: { name: string; country?: string; nights: number }) => void;
  currentCities: string[];
};

export default function AddCityModal({ isOpen, onClose, onAdd, currentCities }: AddCityModalProps) {
  const [query, setQuery] = useState('');
  const [nights, setNights] = useState(2);
  const [suggestions, setSuggestions] = useState<Destination[]>([]);
  const [recommendations, setRecommendations] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingRecs, setLoadingRecs] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Reset and fetch recommendations when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setNights(2);
      setSuggestions([]);
      setHasSearched(false);
      setTimeout(() => inputRef.current?.focus(), 100);

      // Fetch recommendations based on current cities
      if (currentCities.length > 0) {
        setLoadingRecs(true);
        suggestDestinations({ currentCities })
          .then((results) => setRecommendations(results))
          .catch(() => setRecommendations([]))
          .finally(() => setLoadingRecs(false));
      }
    } else {
      setRecommendations([]);
    }
  }, [isOpen, currentCities.join(',')]);

  // Debounced search
  const searchCities = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (q.length < 2) {
        setSuggestions([]);
        setHasSearched(false);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        setLoading(true);
        try {
          const results = await suggestDestinations({
            currentCities,
            vibe: q,
          });
          setSuggestions(results);
          setHasSearched(true);
        } catch {
          setSuggestions([]);
          setHasSearched(true);
        } finally {
          setLoading(false);
        }
      }, 400);
    },
    [currentCities],
  );

  const handleQueryChange = (value: string) => {
    setQuery(value);
    searchCities(value);
  };

  const handleSubmit = () => {
    if (!query.trim()) return;
    onAdd({ name: query.trim(), nights });
    setQuery('');
  };

  const handleSelectCity = (name: string) => {
    onAdd({ name, nights });
    setQuery('');
  };

  if (!isOpen) return null;

  // Show search results when typing, otherwise show recommendations
  const showSearchResults = query.length >= 2;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-40 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.2)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            onClick={(e) => e.stopPropagation()}
            className="w-[400px] rounded-2xl border shadow-xl overflow-hidden"
            style={{
              background: '#ffffff',
              borderColor: 'rgba(0,0,0,0.08)',
            }}
          >
            {/* Header */}
            <div className="px-5 pt-5 pb-3">
              <div className="text-gray-800 text-[15px] font-medium mb-1">Add a city</div>
              <div className="text-gray-400 text-[12px]">
                Search for a city or pick from recommendations
              </div>
            </div>

            {/* Search input */}
            <div className="px-5 pb-3">
              <div
                className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl"
                style={{
                  background: '#f0f4f8',
                  border: '1px solid rgba(0,0,0,0.08)',
                }}
              >
                <Search size={14} className="text-gray-400 flex-shrink-0" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSubmit();
                    if (e.key === 'Escape') onClose();
                  }}
                  placeholder="City name or vibe..."
                  className="flex-1 bg-transparent text-[13px] text-gray-900 placeholder-gray-400 outline-none"
                />
                {loading && <Loader2 size={14} className="text-gray-400 animate-spin flex-shrink-0" />}
              </div>
            </div>

            {/* Nights selector */}
            <div className="px-5 pb-3">
              <div
                className="flex items-center justify-between px-3.5 py-2.5 rounded-xl"
                style={{
                  background: '#f0f4f8',
                  border: '1px solid rgba(0,0,0,0.08)',
                }}
              >
                <div className="flex items-center gap-2">
                  <Moon size={13} className="text-gray-400" />
                  <span className="text-[13px] text-gray-600">Nights</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setNights(Math.max(1, nights - 1))}
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:bg-white hover:text-gray-800 transition-colors"
                  >
                    <Minus size={13} />
                  </button>
                  <span className="text-[14px] font-semibold text-gray-900 w-6 text-center tabular-nums">
                    {nights}
                  </span>
                  <button
                    onClick={() => setNights(Math.min(14, nights + 1))}
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:bg-white hover:text-gray-800 transition-colors"
                  >
                    <Plus size={13} />
                  </button>
                </div>
              </div>
            </div>

            {/* Search results OR Recommendations */}
            <div className="max-h-[260px] overflow-y-auto">
              {showSearchResults ? (
                // Search results
                <>
                  {suggestions.length > 0 && (
                    <div className="px-3 pb-2">
                      {suggestions.map((dest) => (
                        <button
                          key={dest.name}
                          onClick={() => handleSelectCity(dest.name)}
                          className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-gray-50 transition-colors"
                        >
                          <div
                            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                            style={{ background: 'rgba(37,99,235,0.08)' }}
                          >
                            <MapPin size={12} className="text-[#2563eb]" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-gray-900 text-[13px] font-medium">{dest.name}</div>
                            <div className="text-gray-400 text-[11px] leading-snug mt-0.5 line-clamp-2">
                              {dest.reason}
                            </div>
                          </div>
                          <div className="text-gray-400 text-[11px] flex-shrink-0 mt-1">
                            ~${dest.estimatedCost}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {hasSearched && suggestions.length === 0 && !loading && (
                    <div className="px-5 pb-3 text-gray-400 text-[12px] text-center py-4">
                      No suggestions found — press Enter to add &ldquo;{query}&rdquo; directly
                    </div>
                  )}
                </>
              ) : (
                // Recommendations based on current cities
                <div className="px-3 pb-2">
                  {loadingRecs ? (
                    <div className="flex items-center justify-center gap-2 py-6">
                      <Loader2 size={14} className="text-gray-400 animate-spin" />
                      <span className="text-gray-400 text-[12px]">Finding nearby cities...</span>
                    </div>
                  ) : recommendations.length > 0 ? (
                    <>
                      <div className="flex items-center gap-1.5 px-3 pt-1 pb-2">
                        <Sparkles size={11} className="text-[#2563eb]" />
                        <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">
                          Recommended near your cities
                        </span>
                      </div>
                      {recommendations.map((dest) => (
                        <button
                          key={dest.name}
                          onClick={() => handleSelectCity(dest.name)}
                          className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-gray-50 transition-colors"
                        >
                          <div
                            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                            style={{ background: 'rgba(37,99,235,0.08)' }}
                          >
                            <MapPin size={12} className="text-[#2563eb]" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-gray-900 text-[13px] font-medium">{dest.name}</div>
                            <div className="text-gray-400 text-[11px] leading-snug mt-0.5 line-clamp-2">
                              {dest.reason}
                            </div>
                          </div>
                          <div className="text-gray-400 text-[11px] flex-shrink-0 mt-1">
                            ~${dest.estimatedCost}
                          </div>
                        </button>
                      ))}
                    </>
                  ) : currentCities.length > 0 ? (
                    <div className="text-gray-400 text-[12px] text-center py-6">
                      Type a city name to search
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div
              className="px-5 py-3.5 flex items-center justify-end gap-2 border-t"
              style={{ borderColor: 'rgba(0,0,0,0.06)' }}
            >
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-[12px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!query.trim()}
                className="px-4 py-2 rounded-lg text-[12px] font-medium text-white transition-all disabled:opacity-30 hover:brightness-110"
                style={{ background: '#2563eb' }}
              >
                Add City
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
