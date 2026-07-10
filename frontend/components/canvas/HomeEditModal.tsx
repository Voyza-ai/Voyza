'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Home, Plane, Plus } from 'lucide-react';
import { getOriginAirports } from '@/lib/originAirports';
import { getAirportName } from '@/lib/airportNames';

type HomeEditModalProps = {
  isOpen: boolean;
  /** Which home card is being edited — they're independent. */
  direction: 'outbound' | 'inbound';
  city: string;
  airports: string[];
  onClose: () => void;
  onApply: (updates: { city: string; airports: string[] }) => void;
};

/**
 * Popup editor for the canvas home / back-home cards. City + airports for
 * each direction are edited independently (leave from JFK, fly back into
 * a different airport or even a different city). Applying triggers a live
 * re-search of that direction's flight on the canvas page.
 */
export default function HomeEditModal({
  isOpen,
  direction,
  city,
  airports,
  onClose,
  onApply,
}: HomeEditModalProps) {
  const [cityInput, setCityInput] = useState(city);
  const [selected, setSelected] = useState<string[]>(airports);
  const [customIata, setCustomIata] = useState('');
  const [touchedChips, setTouchedChips] = useState(false);

  // Reset to current values each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setCityInput(city);
      setSelected(airports);
      setCustomIata('');
      setTouchedChips(false);
    }
  }, [isOpen, city, airports.join(',')]);

  const suggested = getOriginAirports(cityInput);

  // When the user types a new city we recognize, auto-select its airports —
  // unless they've manually toggled chips already.
  useEffect(() => {
    if (!isOpen || touchedChips) return;
    if (cityInput.trim().toLowerCase() !== city.trim().toLowerCase() && suggested.length > 0) {
      setSelected(suggested);
    }
  }, [cityInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleAirport = (code: string) => {
    setTouchedChips(true);
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const addCustom = () => {
    const code = customIata.trim().toUpperCase();
    if (code.length !== 3 || selected.includes(code)) return;
    setTouchedChips(true);
    setSelected((prev) => [...prev, code]);
    setCustomIata('');
  };

  const canApply = cityInput.trim().length > 0 && selected.length > 0;
  const label = direction === 'outbound' ? 'home' : 'back home';
  // Chips: suggestions for the typed city plus anything already selected.
  const chips = Array.from(new Set([...suggested, ...selected]));

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.25)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className="w-[380px] rounded-2xl border shadow-xl overflow-hidden"
            style={{ background: '#ffffff', borderColor: 'rgba(0,0,0,0.08)' }}
          >
            {/* Header */}
            <div className="px-5 pt-5 pb-3 flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2 text-gray-800 text-[15px] font-medium">
                  <Home size={14} style={{ color: '#7C1A1A' }} />
                  Edit {label} card
                </div>
                <div className="text-gray-400 text-[12px] mt-0.5">
                  {direction === 'outbound'
                    ? 'Where your trip starts from'
                    : 'Where you fly back to'}
                  {' — flights update automatically'}
                </div>
              </div>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600 transition-colors mt-0.5"
              >
                <X size={16} />
              </button>
            </div>

            {/* City */}
            <div className="px-5 pb-3">
              <label className="block text-[11px] uppercase tracking-wider text-gray-400 mb-1.5">
                City
              </label>
              <input
                value={cityInput}
                onChange={(e) => setCityInput(e.target.value)}
                placeholder="e.g. New York"
                className="w-full px-3 py-2.5 rounded-xl text-[13px] text-gray-900 outline-none"
                style={{ background: '#f0f4f8', border: '1px solid rgba(0,0,0,0.08)' }}
              />
            </div>

            {/* Airports */}
            <div className="px-5 pb-3">
              <label className="block text-[11px] uppercase tracking-wider text-gray-400 mb-1.5">
                Airports to search
              </label>
              {chips.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {chips.map((code) => {
                    const active = selected.includes(code);
                    return (
                      <button
                        key={code}
                        onClick={() => toggleAirport(code)}
                        title={getAirportName(code) ?? code}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-mono font-medium border transition-all"
                        style={{
                          background: active ? 'rgba(37,99,235,0.08)' : '#ffffff',
                          borderColor: active ? '#2563eb' : 'rgba(0,0,0,0.12)',
                          color: active ? '#2563eb' : '#6b7280',
                        }}
                      >
                        <Plane size={10} />
                        {code}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[12px] text-gray-400 mb-2">
                  No known airports for this city — add the IATA code below.
                </div>
              )}

              {/* Custom IATA */}
              <div className="flex gap-1.5">
                <input
                  value={customIata}
                  onChange={(e) => setCustomIata(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addCustom();
                  }}
                  placeholder="Add IATA code (e.g. EWR)"
                  maxLength={3}
                  className="flex-1 px-3 py-2 rounded-xl text-[12px] font-mono text-gray-900 outline-none uppercase"
                  style={{ background: '#f0f4f8', border: '1px solid rgba(0,0,0,0.08)' }}
                />
                <button
                  onClick={addCustom}
                  disabled={customIata.trim().length !== 3}
                  className="px-3 rounded-xl border text-gray-500 hover:text-[#2563eb] hover:border-[#2563eb] transition-colors disabled:opacity-30"
                  style={{ borderColor: 'rgba(0,0,0,0.12)' }}
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>

            {/* Actions */}
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
                onClick={() => canApply && onApply({ city: cityInput.trim(), airports: selected })}
                disabled={!canApply}
                className="px-4 py-2 rounded-lg text-[12px] font-medium text-white transition-all disabled:opacity-30 hover:brightness-110"
                style={{ background: '#2563eb' }}
              >
                Apply
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
