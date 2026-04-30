'use client';

import { useState, useRef, useEffect } from 'react';
import { Home, Plane, Pencil, Check, X } from 'lucide-react';
import { getAirportName } from '@/lib/airportNames';

type CanvasHomeCardProps = {
  origin: {
    city: string;
    airports: string[];
    outboundLeg?: any;
    returnLeg?: any;
  };
  direction: 'outbound' | 'inbound';
  onUpdateOrigin?: (updates: { city?: string; airports?: string[] }) => void;
};

const HOME_COLOR = {
  bg: '#FDE2E2',
  text: '#7C1A1A',
  border: '#F0B8B8',
};

export default function CanvasHomeCard({ origin, direction, onUpdateOrigin }: CanvasHomeCardProps) {
  const leg = direction === 'outbound' ? origin.outboundLeg : origin.returnLeg;
  const airport = direction === 'outbound'
    ? leg?.originAirport ?? origin.airports?.[0] ?? ''
    : leg?.destAirport ?? origin.airports?.[0] ?? '';
  const airportName = airport ? getAirportName(airport) : null;
  const label = direction === 'outbound' ? 'Home' : 'Back home';
  const time = direction === 'outbound' ? leg?.departTime : leg?.arriveTime;
  const date = leg?.departDate ?? '';

  // Editing state
  const [editingCity, setEditingCity] = useState(false);
  const [editingAirport, setEditingAirport] = useState(false);
  const [cityInput, setCityInput] = useState(origin.city);
  const [airportInput, setAirportInput] = useState(airport);
  const cityRef = useRef<HTMLInputElement>(null);
  const airportRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingCity) cityRef.current?.focus();
  }, [editingCity]);

  useEffect(() => {
    if (editingAirport) airportRef.current?.focus();
  }, [editingAirport]);

  const handleCitySave = () => {
    const trimmed = cityInput.trim();
    if (trimmed && trimmed !== origin.city) {
      onUpdateOrigin?.({ city: trimmed });
    }
    setEditingCity(false);
  };

  const handleAirportSave = () => {
    const trimmed = airportInput.trim().toUpperCase();
    if (trimmed && trimmed !== airport) {
      onUpdateOrigin?.({ airports: [trimmed] });
    }
    setEditingAirport(false);
  };

  const formatDate = (iso: string) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    if (isNaN(y)) return '';
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const canEdit = !!onUpdateOrigin;

  return (
    <div
      className="flex-shrink-0 w-[200px] rounded-2xl border-2 overflow-hidden"
      style={{
        background: HOME_COLOR.bg,
        borderColor: HOME_COLOR.border,
      }}
    >
      {/* Header bar */}
      <div
        className="px-4 py-2 flex items-center gap-2"
        style={{ background: `${HOME_COLOR.text}18` }}
      >
        <Home size={12} style={{ color: HOME_COLOR.text }} />
        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: HOME_COLOR.text }}>
          {label}
        </span>
      </div>

      {/* City name — editable */}
      <div className="px-4 pt-3 pb-1">
        {editingCity ? (
          <div className="flex items-center gap-1">
            <input
              ref={cityRef}
              value={cityInput}
              onChange={(e) => setCityInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCitySave();
                if (e.key === 'Escape') { setCityInput(origin.city); setEditingCity(false); }
              }}
              className="flex-1 min-w-0 text-[15px] font-semibold bg-white/60 rounded-lg px-2 py-0.5 outline-none"
              style={{ color: HOME_COLOR.text, border: `1px solid ${HOME_COLOR.border}` }}
            />
            <button onClick={handleCitySave} className="p-0.5">
              <Check size={12} style={{ color: HOME_COLOR.text }} />
            </button>
            <button onClick={() => { setCityInput(origin.city); setEditingCity(false); }} className="p-0.5">
              <X size={12} style={{ color: `${HOME_COLOR.text}88` }} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 group">
            <div className="text-[16px] font-semibold" style={{ color: HOME_COLOR.text }}>
              {origin.city}
            </div>
            {canEdit && (
              <button
                onClick={() => { setCityInput(origin.city); setEditingCity(true); }}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
              >
                <Pencil size={10} style={{ color: `${HOME_COLOR.text}88` }} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Airport — editable */}
      <div className="px-4 pb-1">
        {editingAirport ? (
          <div className="flex items-center gap-1">
            <input
              ref={airportRef}
              value={airportInput}
              onChange={(e) => setAirportInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAirportSave();
                if (e.key === 'Escape') { setAirportInput(airport); setEditingAirport(false); }
              }}
              placeholder="IATA code (e.g. JFK)"
              className="flex-1 min-w-0 text-[11px] font-mono bg-white/60 rounded-lg px-2 py-0.5 outline-none uppercase"
              style={{ color: HOME_COLOR.text, border: `1px solid ${HOME_COLOR.border}` }}
              maxLength={4}
            />
            <button onClick={handleAirportSave} className="p-0.5">
              <Check size={10} style={{ color: HOME_COLOR.text }} />
            </button>
            <button onClick={() => { setAirportInput(airport); setEditingAirport(false); }} className="p-0.5">
              <X size={10} style={{ color: `${HOME_COLOR.text}88` }} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 group">
            <div>
              <div className="text-[11px]" style={{ color: `${HOME_COLOR.text}aa` }}>
                {airportName ?? (airport || 'No airport')}
              </div>
              {airport && (
                <div className="text-[10px] font-mono" style={{ color: `${HOME_COLOR.text}77` }}>
                  {airport}
                </div>
              )}
            </div>
            {canEdit && (
              <button
                onClick={() => { setAirportInput(airport); setEditingAirport(true); }}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
              >
                <Pencil size={9} style={{ color: `${HOME_COLOR.text}88` }} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Date + Time */}
      <div className="px-4 pb-3 flex items-center gap-2">
        {date && (
          <span className="text-[11px]" style={{ color: `${HOME_COLOR.text}99` }}>
            {formatDate(date)}
          </span>
        )}
        {time && (
          <span className="text-[12px] font-mono font-medium" style={{ color: HOME_COLOR.text }}>
            {time}
          </span>
        )}
      </div>

      {/* Flight price if available */}
      {leg?.price > 0 && (
        <div
          className="mx-3 mb-3 px-3 py-1.5 rounded-lg flex items-center gap-2"
          style={{ background: `${HOME_COLOR.text}12` }}
        >
          <Plane size={10} style={{ color: HOME_COLOR.text }} />
          <span className="text-[11px] font-semibold" style={{ color: HOME_COLOR.text }}>
            ${leg.price}
          </span>
          {leg.durationMinutes > 0 && (
            <span className="text-[10px] ml-auto" style={{ color: `${HOME_COLOR.text}88` }}>
              {Math.floor(leg.durationMinutes / 60)}h {leg.durationMinutes % 60}m
            </span>
          )}
        </div>
      )}
    </div>
  );
}
