'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, MapPin, Loader2 } from 'lucide-react';
import { suggestDestinations, Destination } from '@/lib/api';

type AddCityModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (city: { name: string; country?: string }) => void;
  currentCities: string[];
};

export default function AddCityModal({ isOpen, onClose, onAdd, currentCities }: AddCityModalProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSuggestions([]);
      setHasSearched(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

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
    onAdd({ name: query.trim() });
    setQuery('');
  };

  const handleSelectSuggestion = (dest: Destination) => {
    onAdd({ name: dest.name });
    setQuery('');
  };

  if (!isOpen) return null;

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
            className="w-[380px] rounded-2xl border shadow-xl overflow-hidden"
            style={{
              background: '#ffffff',
              borderColor: 'rgba(0,0,0,0.08)',
            }}
          >
            {/* Header */}
            <div className="px-5 pt-5 pb-3">
              <div className="text-gray-800 text-[15px] font-medium mb-1">Add a city</div>
              <div className="text-gray-400 text-[12px]">
                Search or type a city name to add it to your trip
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

            {/* Suggestions dropdown */}
            {suggestions.length > 0 && (
              <div className="px-3 pb-2 max-h-[240px] overflow-y-auto">
                {suggestions.map((dest) => (
                  <button
                    key={dest.name}
                    onClick={() => handleSelectSuggestion(dest)}
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

            {/* No results */}
            {hasSearched && suggestions.length === 0 && query.length >= 2 && !loading && (
              <div className="px-5 pb-3 text-gray-400 text-[12px] text-center py-4">
                No suggestions found — press Enter to add "{query}" directly
              </div>
            )}

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
