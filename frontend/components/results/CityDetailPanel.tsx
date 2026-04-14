'use client';

import { useState, useId } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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
  Info,
  Shuffle,
  Map as MapIcon,
  PlaneLanding,
  PlaneTakeoff,
  TrainFront,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Trip, Hotel, Transport } from '@/lib/types';
import { useTripStore } from '@/store/tripStore';
import { effectiveHotel } from '@/lib/tripTotals';
import { nightsBetween } from '@/lib/hotelScore';
import { getCityColor, CITY_COLORS } from '@/lib/cityColors';
import { VIBE_LABEL } from '@/lib/cityTheme';

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

const formatDateShort = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-US', {
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
  const setCityColor = useTripStore((s) => s.setCityColor);

  const city = trip.cities[cityIndex];
  const color = getCityColor(city.colorIndex ?? cityIndex);
  const nights = nightsBetween(city.dates.arrival, city.dates.departure);
  const eff = effectiveHotel(city);
  const [showFees, setShowFees] = useState(false);

  const selectedHotel = city.customHotel
    ? null
    : city.hotels[city.selectedHotelIndex] ?? city.hotels[0];

  // Room calculation: prefer 1 room for the whole group unless maxGuests is set
  const guestsPerRoom = selectedHotel?.maxGuests;
  const roomsNeeded = guestsPerRoom ? Math.ceil(trip.travelers / guestsPerRoom) : 1;
  const stayRoom = Math.round(eff.roomSubtotal * roomsNeeded);
  const stayTaxes = Math.round(eff.taxesSubtotal * roomsNeeded);
  const stayTotal = Math.round(eff.total * roomsNeeded);
  const hasTaxes = stayTaxes > 0;

  const canPrev = cityIndex > 0;
  const canNext = cityIndex < trip.cities.length - 1;

  /* Unique class for scoped scrollbar styling */
  const uid = useId().replace(/:/g, '');
  const scrollCls = `cdp-scroll-${uid}`;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
      className="h-full flex flex-col rounded-3xl border-2 overflow-hidden relative"
      style={{
        background: color.bg,
        borderColor: color.border,
      }}
    >
      {/* Scoped scrollbar styles */}
      <style>{`
        .${scrollCls}::-webkit-scrollbar { width: 5px; }
        .${scrollCls}::-webkit-scrollbar-track { background: transparent; }
        .${scrollCls}::-webkit-scrollbar-thumb { background: ${color.border}; border-radius: 3px; }
        .${scrollCls}::-webkit-scrollbar-thumb:hover { background: ${color.text}60; }
      `}</style>

      {/* Top accent bar */}
      <div
        className="h-[5px] w-full flex-shrink-0"
        style={{ background: color.text }}
      />

      {/* Header — pinned */}
      <div
        className="px-7 pt-6 pb-5 flex items-start justify-between gap-4 flex-shrink-0"
        style={{ borderBottom: `4px solid ${color.border}` }}
      >
        <div className="min-w-0">
          <div
            className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] mb-2"
            style={{ color: `${color.text}aa` }}
          >
            <span>City {String(cityIndex + 1).padStart(2, '0')} of {String(trip.cities.length).padStart(2, '0')}</span>
          </div>
          <h2 className="text-3xl font-semibold leading-tight" style={{ color: color.text }}>
            {city.name}
            <span className="text-xl font-normal ml-3" style={{ color: `${color.text}88` }}>{city.country}</span>
          </h2>
          <div className="flex items-center gap-3 mt-2 text-sm" style={{ color: `${color.text}99` }}>
            <span>{formatDate(city.dates.arrival)}</span>
            <span style={{ color: `${color.text}50` }}>→</span>
            <span>{formatDate(city.dates.departure)}</span>
            <span style={{ color: `${color.text}50` }}>·</span>
            <span>{nights} {nights === 1 ? 'night' : 'nights'}</span>
          </div>

          {/* Vibe chips — solid dark bg, light text */}
          {city.vibes && city.vibes.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {city.vibes.map((v) => (
                <span
                  key={v}
                  className="text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full font-semibold"
                  style={{
                    background: color.text,
                    color: color.bg,
                  }}
                >
                  {VIBE_LABEL[v]}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Right column: nav controls + travel in/out summary */}
        <div className="flex flex-col items-end gap-3 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onPrev}
              disabled={!canPrev}
              className="w-8 h-8 rounded-full border flex items-center justify-center transition-all disabled:opacity-25 disabled:cursor-not-allowed"
              style={{
                borderColor: color.border,
                color: color.text,
                background: `${color.text}0c`,
              }}
              aria-label="Previous city"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!canNext}
              className="w-8 h-8 rounded-full border flex items-center justify-center transition-all disabled:opacity-25 disabled:cursor-not-allowed"
              style={{
                borderColor: color.border,
                color: color.text,
                background: `${color.text}0c`,
              }}
              aria-label="Next city"
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="ml-1 w-8 h-8 rounded-full border flex items-center justify-center transition-all"
              style={{
                borderColor: color.border,
                color: color.text,
                background: `${color.text}0c`,
              }}
              aria-label="Minimize"
            >
              <X size={16} />
            </button>
          </div>

          {/* Travel summary — dark city-color block */}
          <TravelSummary
            arrive={city.transportIn}
            depart={city.transportOut}
            arriveDate={city.dates.arrival}
            departDate={city.dates.departure}
            color={color}
          />
        </div>
      </div>

      {/* Body grid — fills remaining height; each column scrolls internally */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-0">

        {/* LEFT: Hotel picker */}
        <div
          className={`px-7 py-6 overflow-y-auto min-h-0 ${scrollCls}`}
          style={{ borderRight: `4px solid ${color.border}` }}
        >
          <div className="flex items-start justify-between mb-4 gap-4">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold pt-1" style={{ color: color.text }}>
              <Building2 size={12} />
              <span>Where you&apos;ll stay</span>
            </div>
            <div className="flex flex-col items-end">
              <button
                type="button"
                onClick={() => hasTaxes && setShowFees((v) => !v)}
                className={`group flex items-center gap-1.5 text-[11px] px-2.5 py-1 -mr-2 rounded-full border transition-all duration-200 ${
                  hasTaxes ? 'cursor-pointer' : 'cursor-default'
                }`}
                style={{
                  borderColor: hasTaxes ? color.border : 'transparent',
                  background: hasTaxes ? `${color.text}0c` : 'transparent',
                }}
                aria-label={hasTaxes ? 'Toggle fee breakdown' : undefined}
              >
                <span style={{ color: `${color.text}88` }}>Stay total</span>
                <span className="font-semibold tabular-nums" style={{ color: color.text }}>
                  ${stayTotal.toLocaleString()}
                </span>
                <span className="tabular-nums" style={{ color: `${color.text}60` }}>
                  · {nights} {nights === 1 ? 'night' : 'nights'}{roomsNeeded > 1 && ` · ${roomsNeeded} rooms`}
                </span>
                {hasTaxes && (
                  <Info size={11} className="ml-0.5" style={{ color: `${color.text}70` }} />
                )}
              </button>
              <AnimatePresence initial={false}>
                {hasTaxes && showFees && (
                  <motion.div
                    initial={{ opacity: 0, height: 0, marginTop: 0 }}
                    animate={{ opacity: 1, height: 'auto', marginTop: 6 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
                    className="overflow-hidden flex flex-col items-end gap-0.5 text-[10.5px] tabular-nums min-w-[180px]"
                    style={{ color: `${color.text}88` }}
                  >
                    <div className="flex justify-between w-full">
                      <span>Room · ${Math.round(eff.pricePerNight)} × {nights} {nights === 1 ? 'night' : 'nights'}{roomsNeeded > 1 && ` × ${roomsNeeded} rooms`}</span>
                      <span>${stayRoom.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between w-full">
                      <span>Taxes &amp; fees{roomsNeeded > 1 && ` (${roomsNeeded} rooms)`}</span>
                      <span>${stayTaxes.toLocaleString()}</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Coming-soon actions */}
          <div className="flex items-center gap-2 mb-3">
            <button
              type="button"
              disabled
              title="Coming soon"
              className="group relative flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] cursor-not-allowed"
              style={{ borderColor: color.border, background: `${color.text}12`, color: `${color.text}80` }}
            >
              <Shuffle size={12} />
              <span>Randomize nearby</span>
              <span
                className="ml-1 px-1.5 py-[1px] rounded-full text-[9px] uppercase tracking-wider font-medium"
                style={{ background: `${color.text}20`, color: `${color.text}aa` }}
              >
                Coming soon
              </span>
            </button>
            <button
              type="button"
              disabled
              title="Coming soon"
              className="group relative flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] cursor-not-allowed"
              style={{ borderColor: color.border, background: `${color.text}12`, color: `${color.text}80` }}
            >
              <MapIcon size={12} />
              <span>Open map</span>
              <span
                className="ml-1 px-1.5 py-[1px] rounded-full text-[9px] uppercase tracking-wider font-medium"
                style={{ background: `${color.text}20`, color: `${color.text}aa` }}
              >
                Coming soon
              </span>
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {city.hotels.slice(0, 4).map((h, i) => (
              <HotelRow
                key={h.name}
                hotel={h}
                rank={i}
                isSelected={!city.customHotel && city.selectedHotelIndex === i}
                nights={nights}
                color={color}
                onSelect={() => setSelectedHotel(cityIndex, i)}
              />
            ))}
          </div>

          {/* Custom hotel form */}
          <CustomHotelForm
            cityIndex={cityIndex}
            nights={nights}
            color={color}
            current={city.customHotel}
            onSave={(c) => setCustomHotel(cityIndex, c)}
            onClear={() => clearCustomHotel(cityIndex)}
          />
        </div>

        {/* RIGHT: Selected hotel details — slightly different tinted bg */}
        <div
          className={`px-6 py-5 flex flex-col gap-3 overflow-y-auto min-h-0 ${scrollCls}`}
          style={{ background: `${color.text}06` }}
        >
          <HotelDetail hotel={selectedHotel} nights={nights} travelers={trip.travelers} color={color} />
        </div>
      </div>

      {/* Color picker — top center */}
      <div
        className="absolute top-[6px] left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full border backdrop-blur-sm z-10"
        style={{ background: `${color.text}20`, borderColor: `${color.text}35` }}
      >
        {CITY_COLORS.map((c, ci) => (
          <button
            key={ci}
            onClick={() => setCityColor(cityIndex, ci)}
            className="w-4 h-4 rounded-full border-2 transition-transform hover:scale-125"
            style={{
              background: c.bg,
              borderColor: (city.colorIndex ?? cityIndex % CITY_COLORS.length) === ci ? c.text : c.border,
              boxShadow: (city.colorIndex ?? cityIndex % CITY_COLORS.length) === ci ? `0 0 0 2px ${c.border}` : 'none',
            }}
            aria-label={`Set color to ${c.name}`}
          />
        ))}
      </div>
    </motion.div>
  );
}

/* --------------------------- Travel summary -------------------------- */

function TravelSummary({
  arrive,
  depart,
  arriveDate,
  departDate,
  color,
}: {
  arrive: Transport;
  depart: Transport;
  arriveDate: string;
  departDate: string;
  color: { bg: string; text: string; border: string; name: string };
}) {
  return (
    <div
      className="flex items-stretch gap-3 rounded-2xl px-5 py-3.5"
      style={{ background: color.text, color: color.bg }}
    >
      <TravelBlock
        label="Arrive"
        Icon={arrive.mode === 'flight' ? PlaneLanding : TrainFront}
        location={arrive.toStation || arrive.to}
        time={arrive.arriveTime}
        date={arriveDate}
        color={color}
        inverted
      />
      <div className="w-[3px] self-stretch rounded-full" style={{ background: `${color.bg}30` }} />
      <TravelBlock
        label="Depart"
        Icon={depart.mode === 'flight' ? PlaneTakeoff : TrainFront}
        location={depart.fromStation || depart.from}
        time={depart.departTime}
        date={departDate}
        color={color}
        inverted
      />
    </div>
  );
}

function TravelBlock({
  label,
  Icon,
  location,
  time,
  date,
  color,
  inverted,
}: {
  label: string;
  Icon: LucideIcon;
  location?: string;
  time?: string;
  date: string;
  color: { bg: string; text: string; border: string; name: string };
  inverted?: boolean;
}) {
  const fg = inverted ? color.bg : color.text;
  return (
    <div className="flex flex-col gap-1 min-w-[170px]">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] font-medium" style={{ color: `${fg}bb` }}>
        <Icon size={12} style={{ color: fg }} />
        <span>{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[17px] font-bold tabular-nums leading-none" style={{ color: fg }}>
          {time ?? '—'}
        </span>
        <span className="text-[11px]" style={{ color: `${fg}60` }}>·</span>
        <span className="text-[12px] tabular-nums" style={{ color: `${fg}cc` }}>
          {formatDateShort(date)}
        </span>
      </div>
      <div className="text-[12px] truncate max-w-[200px]" style={{ color: `${fg}aa` }}>
        {location ?? '—'}
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
  color,
  onSelect,
}: {
  hotel: Hotel;
  rank: number;
  isSelected: boolean;
  nights: number;
  color: { bg: string; text: string; border: string; name: string };
  onSelect: () => void;
}) {
  const taxes = (hotel.taxesPerNight ?? 0) * nights;
  const room = hotel.pricePerNight * nights;
  const total = room + taxes;
  const isTop = rank === 0;

  const accent = color.text;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left rounded-2xl border px-4 py-3 transition-all group"
      style={{
        background: isSelected ? `${accent}22` : `${color.bg}`,
        borderColor: isSelected ? accent : color.border,
        boxShadow: isSelected ? `0 0 0 1px ${accent}40` : 'none',
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0 border"
            style={{
              background: isSelected ? accent : `${accent}18`,
              color: isSelected ? color.bg : `${accent}99`,
              borderColor: isSelected ? accent : color.border,
            }}
          >
            {isSelected ? <Check size={13} strokeWidth={3} /> : rank + 1}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-sm font-medium truncate" style={{ color: color.text }}>{hotel.name}</div>
              {isTop && (
                <span
                  className="flex items-center gap-0.5 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-semibold"
                  style={{
                    background: accent,
                    color: color.bg,
                  }}
                >
                  <Award size={9} /> Top pick
                </span>
              )}
              {hotel.bookable && (
                <span
                  className="inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border"
                  style={{
                    background: `${accent}18`,
                    borderColor: `${accent}50`,
                    color: accent,
                  }}
                  title="Bookable directly through Voyza"
                >
                  <Zap size={9} fill="currentColor" />
                  Voyza book
                </span>
              )}
            </div>
            <div className="text-[12px] mt-0.5 flex items-center gap-2 flex-wrap" style={{ color: `${accent}88` }}>
              <span>{hotel.area}</span>
              <span style={{ color: `${accent}50` }}>·</span>
              <span className="flex items-center gap-0.5 text-[#fbbf24]">
                <Star size={10} fill="currentColor" />
                {hotel.rating}
              </span>
              {hotel.score != null && (
                <>
                  <span style={{ color: `${accent}50` }}>·</span>
                  <span style={{ color: `${accent}70` }}>score {hotel.score.toFixed(0)}</span>
                </>
              )}
              {taxes > 0 && (
                <>
                  <span style={{ color: `${accent}50` }}>·</span>
                  <span style={{ color: `${accent}70` }}>
                    incl. ${Math.round(taxes).toLocaleString()} taxes
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-semibold tabular-nums" style={{ color: color.text }}>
            ${Math.round(total).toLocaleString()}
          </div>
          <div className="text-[11px] tabular-nums" style={{ color: `${accent}70` }}>
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
  color,
  current,
  onSave,
  onClear,
}: {
  cityIndex: number;
  nights: number;
  color: { bg: string; text: string; border: string; name: string };
  current?: import('@/lib/types').CustomHotel;
  onSave: (c: import('@/lib/types').CustomHotel) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(!!current);
  const [name, setName] = useState(current?.name ?? '');
  const [mode, setMode] = useState<'perNight' | 'total'>(current?.mode ?? 'perNight');
  const [amount, setAmount] = useState<string>(current ? String(current.amount) : '');
  const [url, setUrl] = useState(current?.url ?? '');

  const accent = color.text;

  const numericAmount = parseFloat(amount);
  const valid = name.trim().length > 0 && Number.isFinite(numericAmount) && numericAmount > 0;
  const previewTotal =
    valid && mode === 'perNight' ? numericAmount * nights : valid ? numericAmount : 0;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 w-full rounded-2xl border border-dashed transition-all px-4 py-3 flex items-center justify-center gap-2 text-sm"
        style={{
          borderColor: color.border,
          color: `${accent}88`,
          background: 'transparent',
        }}
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
        borderColor: color.border,
        background: `${accent}0c`,
      }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider font-medium" style={{ color: `${accent}99` }}>
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
          className="text-[11px]"
          style={{ color: `${accent}70` }}
        >
          Cancel
        </button>
      </div>

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. Airbnb in Trastevere)"
        className="w-full rounded-xl border px-3 py-2 text-sm focus:outline-none"
        style={{
          background: color.bg,
          borderColor: color.border,
          color: color.text,
        }}
      />

      {/* Mode toggle */}
      <div
        className="flex items-center gap-1 rounded-xl border p-0.5 w-fit text-[11px]"
        style={{ borderColor: color.border, background: color.bg }}
      >
        {(['perNight', 'total'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className="px-3 py-1 rounded-lg transition-all"
            style={{
              background: mode === m ? accent : 'transparent',
              color: mode === m ? color.bg : `${accent}70`,
              fontWeight: mode === m ? 600 : 500,
            }}
          >
            {m === 'perNight' ? 'Per night' : 'Total stay'}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: `${accent}70` }}>$</span>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="w-full rounded-xl border pl-7 pr-3 py-2 text-sm focus:outline-none tabular-nums"
            style={{
              background: color.bg,
              borderColor: color.border,
              color: color.text,
            }}
          />
        </div>
        <span className="text-[11px]" style={{ color: `${accent}88` }}>
          {mode === 'perNight' ? `× ${nights} nights` : `(${nights} nights)`}
        </span>
      </div>

      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Booking link (optional)"
        className="w-full rounded-xl border px-3 py-2 text-[12px] focus:outline-none"
        style={{
          background: color.bg,
          borderColor: color.border,
          color: color.text,
        }}
      />

      {valid && (
        <div className="flex items-center justify-between text-[11px] pt-1 border-t" style={{ borderColor: color.border }}>
          <span style={{ color: `${accent}88` }}>Stay total</span>
          <span className="font-semibold tabular-nums" style={{ color: color.text }}>
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
          background: valid ? accent : `${accent}15`,
          color: valid ? color.bg : `${accent}70`,
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
          className="flex items-center justify-center gap-1 text-[11px]"
          style={{ color: `${accent}88` }}
        >
          <ExternalLink size={11} /> Open booking link
        </a>
      )}
    </div>
  );
}

/* -------------------------- Hotel detail panel (right column) ------------------------- */

function HotelDetail({
  hotel,
  nights,
  travelers,
  color,
}: {
  hotel: Hotel | null;
  nights: number;
  travelers: number;
  color: { bg: string; text: string; border: string; name: string };
}) {
  if (!hotel) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: `${color.text}70` }}>
        <span className="text-sm">Using custom hotel</span>
      </div>
    );
  }

  const accent = color.text;
  // Prefer 1 room for the whole group unless maxGuests is explicitly set
  const guestsPerRoom = hotel.maxGuests;
  const roomsNeeded = guestsPerRoom ? Math.ceil(travelers / guestsPerRoom) : 1;
  const guestsPerRoomActual = roomsNeeded > 1 ? Math.ceil(travelers / roomsNeeded) : travelers;
  const taxes = (hotel.taxesPerNight ?? 0) * nights * roomsNeeded;
  const room = hotel.pricePerNight * nights * roomsNeeded;
  const total = room + taxes;
  const perPerson = travelers > 1 ? Math.round(total / travelers) : null;

  return (
    <div className="flex flex-col justify-between h-full gap-4">
      {/* Top row: name+badges LEFT, rating/score/area RIGHT */}
      <div className="flex items-start justify-between gap-3">
        {/* Left: name + badges */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold mb-1" style={{ color: accent }}>
            <Building2 size={11} />
            <span>Selected stay</span>
          </div>
          <h3 className="text-base font-semibold leading-tight" style={{ color: accent }}>{hotel.name}</h3>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {hotel.bookable && (
              <span
                className="inline-flex items-center gap-0.5 text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border font-medium"
                style={{ background: `${accent}18`, borderColor: `${accent}50`, color: accent }}
              >
                <Zap size={8} fill="currentColor" /> Voyza book
              </span>
            )}
            {hotel.score != null && hotel.score >= 60 && (
              <span
                className="inline-flex items-center gap-0.5 text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-semibold"
                style={{ background: accent, color: color.bg }}
              >
                <Award size={8} /> Top pick
              </span>
            )}
          </div>
        </div>

        {/* Right: rating + score + area */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="text-right">
              <div className="flex items-center gap-1 justify-end">
                <Star size={13} className="text-[#fbbf24]" fill="#fbbf24" />
                <span className="text-sm font-bold tabular-nums" style={{ color: accent }}>{hotel.rating}</span>
              </div>
              <div className="text-[9px]" style={{ color: `${accent}70` }}>Rating</div>
            </div>
            {hotel.score != null && (
              <>
                <div className="w-[2px] h-7 rounded-full" style={{ background: color.border }} />
                <div className="text-right">
                  <div className="text-sm font-bold tabular-nums" style={{ color: accent }}>{hotel.score.toFixed(0)}</div>
                  <div className="text-[9px]" style={{ color: `${accent}70` }}>Score</div>
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            <MapPin size={10} style={{ color: `${accent}88` }} />
            <span className="text-[11px] font-medium" style={{ color: `${accent}aa` }}>{hotel.area}</span>
          </div>
        </div>
      </div>

      <div className="w-full h-[3px] rounded-full" style={{ background: color.border }} />

      {/* Travelers + room configuration */}
      <div className="flex items-center gap-2.5">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: `${accent}18` }}
        >
          <Users size={15} style={{ color: accent }} />
        </div>
        <div>
          <div className="text-sm font-semibold" style={{ color: accent }}>
            {travelers} {travelers === 1 ? 'traveler' : 'travelers'}
          </div>
          <div className="text-[11px]" style={{ color: `${accent}80` }}>
            {nights} {nights === 1 ? 'night' : 'nights'} ·{' '}
            {roomsNeeded === 1
              ? '1 room'
              : `${roomsNeeded} rooms (${guestsPerRoomActual} per room)`}
          </div>
        </div>
      </div>

      <div className="w-full h-[3px] rounded-full" style={{ background: color.border }} />

      {/* Price breakdown */}
      <div className="flex-1 flex flex-col">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold mb-2" style={{ color: accent }}>
          <span>Price breakdown</span>
        </div>
        <div
          className="rounded-xl px-4 py-3.5 flex flex-col gap-2 flex-1"
          style={{ background: color.bg, border: `1px solid ${color.border}` }}
        >
          <div className="flex justify-between text-[13px]" style={{ color: `${accent}cc` }}>
            <span>
              ${hotel.pricePerNight}/night × {nights} {nights === 1 ? 'night' : 'nights'}{roomsNeeded > 1 && ` × ${roomsNeeded} rooms`}
            </span>
            <span className="font-medium tabular-nums" style={{ color: accent }}>${room.toLocaleString()}</span>
          </div>
          {taxes > 0 && (
            <div className="flex justify-between text-[13px]" style={{ color: `${accent}cc` }}>
              <span>Taxes &amp; fees{roomsNeeded > 1 && ` (${roomsNeeded} rooms)`}</span>
              <span className="font-medium tabular-nums" style={{ color: accent }}>${Math.round(taxes).toLocaleString()}</span>
            </div>
          )}
          <div className="h-[2px] rounded-full my-1" style={{ background: color.border }} />
          <div className="flex justify-between items-baseline">
            <span className="text-[13px] font-semibold" style={{ color: accent }}>Total</span>
            <span className="text-lg font-bold tabular-nums" style={{ color: accent }}>${Math.round(total).toLocaleString()}</span>
          </div>
          {perPerson && (
            <div className="flex justify-between text-[12px] mt-0.5" style={{ color: `${accent}88` }}>
              <span>Per person ({travelers})</span>
              <span className="font-medium tabular-nums">${perPerson.toLocaleString()}/person</span>
            </div>
          )}
        </div>
      </div>

      {/* Booking link */}
      {hotel.bookingUrl && (
        <a
          href={hotel.bookingUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all"
          style={{ background: accent, color: color.bg }}
        >
          <ExternalLink size={13} /> View on booking site
        </a>
      )}
    </div>
  );
}
