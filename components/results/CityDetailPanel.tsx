'use client';

import { useState } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Star,
  MapPin,
  Building2,
  ExternalLink,
  Plus,
  Check,
  Award,
  Zap,
} from 'lucide-react';
import { Trip, Hotel } from '@/lib/types';
import { useTripStore } from '@/store/tripStore';
import { effectiveHotel } from '@/lib/tripTotals';
import { nightsBetween } from '@/lib/hotelScore';
import { getCityTheme, getVibeColor, VIBE_LABEL } from '@/lib/cityTheme';

type CityDetailPanelProps = {
  trip: Trip;
  cityIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
};

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
};

export default function CityDetailPanel({
  trip,
  cityIndex,
  onClose,
  onPrev,
  onNext,
}: CityDetailPanelProps) {
  const setSelectedHotel = useTripStore((s) => s.setSelectedHotel);
  const setCustomHotel = useTripStore((s) => s.setCustomHotel);
  const clearCustomHotel = useTripStore((s) => s.clearCustomHotel);

  const city = trip.cities[cityIndex];
  const theme = getCityTheme(city.country, city.vibes);
  const nights = nightsBetween(city.dates.arrival, city.dates.departure);
  const eff = effectiveHotel(city);

  const canPrev = cityIndex > 0;
  const canNext = cityIndex < trip.cities.length - 1;

  return (
    <div
      className="mx-8 mt-2 rounded-3xl border overflow-hidden"
      style={{
        background: theme.gradient,
        borderColor: theme.borderActive,
      }}
    >
      {/* Top accent bar */}
      <div
        className="h-[3px] w-full"
        style={{
          background: `linear-gradient(90deg, ${theme.countryBase} 0%, ${theme.vibeAccent} 100%)`,
        }}
      />

      {/* Header */}
      <div className="px-7 pt-6 pb-5 flex items-start justify-between gap-4 border-b border-white/8">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] mb-2"
            style={{ color: theme.numberColor }}
          >
            <span>City {String(cityIndex + 1).padStart(2, '0')} of {String(trip.cities.length).padStart(2, '0')}</span>
          </div>
          <h2 className="text-3xl font-semibold text-white leading-tight">
            {city.name}
            <span className="text-white/35 text-xl font-normal ml-3">{city.country}</span>
          </h2>
          <div className="flex items-center gap-3 mt-2 text-white/55 text-sm">
            <span>{formatDate(city.dates.arrival)}</span>
            <span className="text-white/25">→</span>
            <span>{formatDate(city.dates.departure)}</span>
            <span className="text-white/25">·</span>
            <span>{nights} {nights === 1 ? 'night' : 'nights'}</span>
          </div>
          {city.vibes && city.vibes.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {city.vibes.map((v) => {
                const c = getVibeColor(v);
                return (
                  <span
                    key={v}
                    className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border"
                    style={{ background: `${c}1a`, borderColor: `${c}40`, color: c }}
                  >
                    {VIBE_LABEL[v]}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Nav controls */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={onPrev}
            disabled={!canPrev}
            className="w-8 h-8 rounded-full border border-white/12 text-white/65 hover:text-white hover:bg-white/8 disabled:opacity-25 disabled:cursor-not-allowed flex items-center justify-center transition-all"
            aria-label="Previous city"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!canNext}
            className="w-8 h-8 rounded-full border border-white/12 text-white/65 hover:text-white hover:bg-white/8 disabled:opacity-25 disabled:cursor-not-allowed flex items-center justify-center transition-all"
            aria-label="Next city"
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-1 w-8 h-8 rounded-full border border-white/12 text-white/65 hover:text-white hover:bg-white/8 flex items-center justify-center transition-all"
            aria-label="Minimize"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Body grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-0">
        {/* LEFT: Hotel picker */}
        <div className="px-7 py-6 border-r border-white/8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-white/40 text-[11px] uppercase tracking-[0.18em]">
              <Building2 size={12} />
              <span>Where you&apos;ll stay</span>
            </div>
            <div className="text-white/55 text-[11px]">
              <span className="text-white/30">Stay total</span>{' '}
              <span className="text-white/85 font-semibold tabular-nums">
                ${Math.round(eff.total).toLocaleString()}
              </span>
              <span className="text-white/25"> · {nights} nights</span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {city.hotels.map((h, i) => (
              <HotelRow
                key={h.name}
                hotel={h}
                rank={i}
                isSelected={!city.customHotel && city.selectedHotelIndex === i}
                nights={nights}
                accent={theme.vibeAccent}
                onSelect={() => setSelectedHotel(cityIndex, i)}
              />
            ))}
          </div>

          {/* Custom hotel form */}
          <CustomHotelForm
            cityIndex={cityIndex}
            nights={nights}
            accent={theme.vibeAccent}
            current={city.customHotel}
            onSave={(c) => setCustomHotel(cityIndex, c)}
            onClear={() => clearCustomHotel(cityIndex)}
          />
        </div>

        {/* RIGHT: Activities + restaurants */}
        <div className="px-7 py-6 flex flex-col gap-6">
          <div>
            <div className="flex items-center gap-2 text-white/40 text-[11px] uppercase tracking-[0.18em] mb-3">
              <MapPin size={12} />
              <span>Top picks</span>
            </div>
            <ul className="flex flex-col gap-2">
              {city.activities.map((a, i) => (
                <li key={i} className="flex gap-2 text-white/75 text-sm">
                  <span style={{ color: `${theme.vibeAccent}aa` }}>·</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="flex items-center gap-2 text-white/40 text-[11px] uppercase tracking-[0.18em] mb-3">
              <span>Eat here</span>
            </div>
            <ul className="flex flex-col gap-2">
              {city.restaurants.map((r, i) => (
                <li key={i} className="flex items-center justify-between text-white/75 text-sm">
                  <div>
                    <span>{r.name}</span>
                    <span className="text-white/30 text-[12px] ml-2">{r.cuisine}</span>
                  </div>
                  <span className="text-white/35 text-[12px]">{r.priceRange}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Hotel row ---------------------------- */

function HotelRow({
  hotel,
  rank,
  isSelected,
  nights,
  accent,
  onSelect,
}: {
  hotel: Hotel;
  rank: number;
  isSelected: boolean;
  nights: number;
  accent: string;
  onSelect: () => void;
}) {
  const taxes = (hotel.taxesPerNight ?? 0) * nights;
  const room = hotel.pricePerNight * nights;
  const total = room + taxes;
  const isTop = rank === 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left rounded-2xl border px-4 py-3 transition-all hover:bg-white/3 group"
      style={{
        background: isSelected ? `${accent}12` : 'rgba(255,255,255,0.015)',
        borderColor: isSelected ? `${accent}80` : 'rgba(255,255,255,0.08)',
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0 border"
            style={{
              background: isSelected ? accent : 'rgba(255,255,255,0.04)',
              color: isSelected ? '#0f0f1a' : 'rgba(255,255,255,0.55)',
              borderColor: isSelected ? accent : 'rgba(255,255,255,0.1)',
            }}
          >
            {isSelected ? <Check size={13} strokeWidth={3} /> : rank + 1}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-white/90 text-sm font-medium truncate">{hotel.name}</div>
              {isTop && (
                <span
                  className="flex items-center gap-0.5 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border"
                  style={{
                    background: `${accent}1f`,
                    borderColor: `${accent}60`,
                    color: accent,
                  }}
                >
                  <Award size={9} /> Top pick
                </span>
              )}
              {hotel.bookable && (
                <span
                  className="inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border"
                  style={{
                    background: 'rgba(79,142,247,0.12)',
                    borderColor: 'rgba(79,142,247,0.35)',
                    color: '#7aa9f8',
                  }}
                  title="Bookable directly through Voyza"
                >
                  <Zap size={9} fill="currentColor" />
                  Voyza book
                </span>
              )}
            </div>
            <div className="text-white/40 text-[12px] mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{hotel.area}</span>
              <span className="text-white/15">·</span>
              <span className="flex items-center gap-0.5 text-[#fbbf24]">
                <Star size={10} fill="currentColor" />
                {hotel.rating}
              </span>
              {hotel.score != null && (
                <>
                  <span className="text-white/15">·</span>
                  <span className="text-white/35">score {hotel.score.toFixed(0)}</span>
                </>
              )}
              {taxes > 0 && (
                <>
                  <span className="text-white/15">·</span>
                  <span className="text-white/35">
                    incl. ${Math.round(taxes).toLocaleString()} taxes
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-white/90 text-sm font-semibold tabular-nums">
            ${Math.round(total).toLocaleString()}
          </div>
          <div className="text-white/35 text-[11px] tabular-nums">
            ${hotel.pricePerNight}/night
          </div>
        </div>
      </div>
    </button>
  );
}

/* -------------------------- Custom hotel form ------------------------- */

function CustomHotelForm({
  nights,
  accent,
  current,
  onSave,
  onClear,
}: {
  cityIndex: number;
  nights: number;
  accent: string;
  current?: import('@/lib/types').CustomHotel;
  onSave: (c: import('@/lib/types').CustomHotel) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(!!current);
  const [name, setName] = useState(current?.name ?? '');
  const [mode, setMode] = useState<'perNight' | 'total'>(current?.mode ?? 'perNight');
  const [amount, setAmount] = useState<string>(current ? String(current.amount) : '');
  const [url, setUrl] = useState(current?.url ?? '');

  const numericAmount = parseFloat(amount);
  const valid = name.trim().length > 0 && Number.isFinite(numericAmount) && numericAmount > 0;
  const previewTotal =
    valid && mode === 'perNight' ? numericAmount * nights : valid ? numericAmount : 0;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 w-full rounded-2xl border border-dashed border-white/15 text-white/55 hover:text-white hover:border-white/30 hover:bg-white/3 transition-all px-4 py-3 flex items-center justify-center gap-2 text-sm"
      >
        <Plus size={14} />
        <span>Use my own hotel or Airbnb</span>
      </button>
    );
  }

  return (
    <div
      className="mt-4 rounded-2xl border p-4 space-y-3"
      style={{
        background: 'rgba(255,255,255,0.02)',
        borderColor: 'rgba(255,255,255,0.12)',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="text-white/55 text-[11px] uppercase tracking-wider">
          Your own stay
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onClear();
            setName('');
            setAmount('');
            setUrl('');
          }}
          className="text-white/35 hover:text-white text-[11px]"
        >
          Cancel
        </button>
      </div>

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. Airbnb in Trastevere)"
        className="w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/30"
      />

      {/* Mode toggle */}
      <div className="flex items-center gap-1 rounded-xl border border-white/10 p-0.5 bg-black/20 w-fit text-[11px]">
        {(['perNight', 'total'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className="px-3 py-1 rounded-lg transition-all"
            style={{
              background: mode === m ? accent : 'transparent',
              color: mode === m ? '#0f0f1a' : 'rgba(255,255,255,0.55)',
              fontWeight: mode === m ? 600 : 500,
            }}
          >
            {m === 'perNight' ? 'Per night' : 'Total stay'}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/35 text-sm">$</span>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="w-full rounded-xl bg-black/30 border border-white/10 pl-7 pr-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/30 tabular-nums"
          />
        </div>
        <span className="text-white/40 text-[11px]">
          {mode === 'perNight' ? `× ${nights} nights` : `(${nights} nights)`}
        </span>
      </div>

      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Booking link (optional)"
        className="w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-[12px] text-white placeholder-white/25 focus:outline-none focus:border-white/30"
      />

      {valid && (
        <div className="flex items-center justify-between text-[11px] pt-1 border-t border-white/8">
          <span className="text-white/35">Stay total</span>
          <span className="text-white font-semibold tabular-nums">
            ${Math.round(previewTotal).toLocaleString()}
          </span>
        </div>
      )}

      <button
        type="button"
        disabled={!valid}
        onClick={() => {
          onSave({
            name: name.trim(),
            mode,
            amount: numericAmount,
            url: url.trim() || undefined,
          });
        }}
        className="w-full rounded-xl px-3 py-2 text-sm font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        style={{
          background: valid ? accent : 'rgba(255,255,255,0.06)',
          color: valid ? '#0f0f1a' : 'rgba(255,255,255,0.45)',
        }}
      >
        <Check size={14} />
        Use this stay
      </button>

      {url && valid && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1 text-white/40 hover:text-white text-[11px]"
        >
          <ExternalLink size={11} /> Open booking link
        </a>
      )}
    </div>
  );
}
