'use client';

import { useState, useId, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence, useAnimationControls, useReducedMotion } from 'framer-motion';
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
  RefreshCw,
  Loader2,
  PlaneLanding,
  PlaneTakeoff,
  TrainFront,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Trip, Hotel, Transport } from '@/lib/types';
import { useTripStore } from '@/store/tripStore';
import { effectiveHotel, displayAmount } from '@/lib/tripTotals';
import { nightsBetween } from '@/lib/hotelScore';
import { getCityColor, CITY_COLORS } from '@/lib/cityColors';
import { hasStay } from './CityCard';
import { effectiveTransportIn, effectiveTransportOut, legArrivalDate } from '@/lib/cityLegs';
import { searchHotels } from '@/lib/api';
import { hotelFromResult } from '@/lib/hotelShape';
import { hotelWindow, newHotelsOnly, HOTELS_PER_SET, type HotelEntry } from '@/lib/hotelMap';
import { prefetchLandmarks } from '@/lib/landmarks';
import HotelHero, { preloadPhotos } from './HotelHero';
import { areaForPoint } from '@/lib/hotelArea';

// MapLibre needs `window`.
const HotelMapPanel = dynamic(() => import('./HotelMapPanel'), { ssr: false });

/** The guide's motion: one gentle ease-out for growing, sliding and shrinking. */
const EASE = [0.22, 0.61, 0.36, 1] as const;
const GROW_S = 0.45;
const SHRINK_S = 0.38;

type CityDetailPanelProps = {
  trip: Trip;
  cityIndex: number;
  /**
   * Where city `i`'s card is on screen, or null when it is not in view. The
   * guide grows out of it on opening and shrinks back into it on closing;
   * without one it fades.
   */
  originOf?: (cityIndex: number) => DOMRect | null;
  /** Closing has begun: the guide is about to shrink back into its card. */
  onCloseStart?: () => void;
  /** Closing has finished. */
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
};

/**
 * Rooms the stay is priced for — the backend's rule (services/hotels.ts
 * `roomsFor`): two adults to a room, one room for a party of 1–2. The app
 * sends no room count, so the backend always applies it, and the hotel's
 * price covers every one of these rooms.
 */
export function roomsFor(adults: number): number {
  return Number.isFinite(adults) && adults > 2 ? Math.ceil(adults / 2) : 1;
}

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
  originOf,
  onCloseStart,
  onClose,
  onPrev,
  onNext,
}: CityDetailPanelProps) {
  const setSelectedHotel = useTripStore((s) => s.setSelectedHotel);
  const setCustomHotel = useTripStore((s) => s.setCustomHotel);
  const clearCustomHotel = useTripStore((s) => s.clearCustomHotel);
  const setCityColor = useTripStore((s) => s.setCityColor);
  const updateCity = useTripStore((s) => s.updateCity);
  const priceMode = useTripStore((s) => s.priceMode);

  const city = trip.cities[cityIndex];
  // The city's own pastel is the card the guide grows out of; once open, the
  // guide is white with the city's colour kept for its accents (top strip,
  // name, chosen hotel), so it sits quietly beside the map and BlueMurr AI.
  const cityColor = getCityColor(city.colorIndex ?? cityIndex);
  const color = { ...cityColor, bg: '#ffffff', border: '#e8eaef' };
  const nights = nightsBetween(city.dates.arrival, city.dates.departure);
  const eff = effectiveHotel(city);
  const [showFees, setShowFees] = useState(false);

  // "Find more hotels": which four of the city's hotels are listed, the next
  // page of the search to ask for once the trip's own list is used up, and a
  // note when there was nothing new to bring in.
  const [hotelOffset, setHotelOffset] = useState(0);
  const [findingHotels, setFindingHotels] = useState(false);
  const [hotelNote, setHotelNote] = useState<string | null>(null);
  const nextPageRef = useRef(1);
  const stayKey = `${city.name}|${city.dates.arrival}|${city.dates.departure}`;
  useEffect(() => {
    setHotelOffset(0);
    setHotelNote(null);
    setFindingHotels(false);
    nextPageRef.current = 1;
    // Look up the city's landmarks now, so the map usually has them ready.
    prefetchLandmarks({ name: city.name, country: city.country });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stayKey]);
  const listed = hotelWindow(city, hotelOffset);
  // The hotels on the map: the set listed, taken afresh for a new set or a
  // new city but not when the pick changes — picking a hotel can move the
  // pinned row, and that should not rebuild the map under the traveller.
  /**
   * Write facts looked up about a hotel (its neighbourhood, its photo
   * gallery) onto the trip, so they are saved with it and not asked for
   * again. Found by stay and name, not slot: the trip can be re-ordered or the
   * list extended while a lookup runs.
   */
  const patchHotel = (name: string, patch: Partial<Hotel>) => {
    const cities = useTripStore.getState().currentTrip?.cities ?? [];
    const idx = cities.findIndex(
      (c) => c.name === city.name && c.dates.arrival === city.dates.arrival && c.dates.departure === city.dates.departure,
    );
    if (idx < 0) return;
    const cur = cities[idx];
    if (!cur.hotels.some((h) => h.name === name)) return;
    updateCity(idx, {
      hotels: cur.hotels.map((h) => (h.name === name ? { ...h, ...patch } : h)),
      ...(cur.hotel?.name === name ? { hotel: { ...cur.hotel, ...patch } } : {}),
    });
  };

  // The listed hotels' neighbourhoods, looked up from where each one is and
  // kept on the trip. Only hotels with coordinates and no name yet are asked
  // about, one at a time (the lookup allows one request a second).
  const areaKey = listed
    .map((e) => (typeof e.hotel.lat === 'number' && e.hotel.neighbourhood === undefined ? e.hotel.name : ''))
    .join('|');
  useEffect(() => {
    let live = true;
    (async () => {
      for (const { hotel: h } of listed) {
        if (!live) return;
        if (typeof h.lat !== 'number' || typeof h.lng !== 'number' || h.neighbourhood !== undefined) continue;
        const area = await areaForPoint(h.lat, h.lng, city.name, h.district ?? null);
        // '' marks "looked up, nothing trustworthy", so it is not asked again.
        if (live) patchHotel(h.name, { neighbourhood: area ?? '' });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaKey]);

  // The listed hotels' photos start loading now, so choosing one shows its
  // photo straight away instead of an empty frame.
  const listedPhotoKey = listed.map((e) => e.hotel.photos?.[0] ?? '').join('|');
  useEffect(() => {
    preloadPhotos(listed.map((e) => e.hotel.photos?.[0]).filter((u): u is string => !!u));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listedPhotoKey]);
  const mapEntries: HotelEntry[] = useMemo(
    () => listed,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stayKey, hotelOffset, city.hotels.length],
  );

  const findMoreHotels = async () => {
    if (findingHotels) return;
    setHotelNote(null);
    const next = hotelOffset + HOTELS_PER_SET;
    // A full set of hotels the guide hasn't listed yet: show it.
    if (next + HOTELS_PER_SET <= city.hotels.length) {
      setHotelOffset(next);
      return;
    }
    // Fewer than four left: ask the search for its next page first, so the
    // new set is a full one.
    setFindingHotels(true);
    let added = 0;
    try {
      const page = nextPageRef.current;
      const results = await searchHotels({
        city: city.name,
        checkin: city.dates.arrival,
        checkout: city.dates.departure,
        adults: trip.travelers,
        page,
      });
      nextPageRef.current = page + 1;
      // Identify the stay, not its slot: the trip can be re-ordered while the
      // search runs.
      const cities = useTripStore.getState().currentTrip?.cities ?? [];
      const idx = cities.findIndex(
        (c) => c.name === city.name && c.dates.arrival === city.dates.arrival && c.dates.departure === city.dates.departure,
      );
      if (idx >= 0) {
        const current = cities[idx];
        const fresh = newHotelsOnly(current.hotels, results.map(hotelFromResult));
        if (fresh.length > 0) {
          updateCity(idx, { hotels: [...current.hotels, ...fresh] });
          added = fresh.length;
        }
      }
    } catch {
      // Treated as nothing new; the note below says so.
    } finally {
      setFindingHotels(false);
    }
    if (added > 0 || next < city.hotels.length) {
      setHotelOffset(next);
    } else {
      setHotelOffset(0);
      setHotelNote(`That's every hotel we found in ${city.name} — back to the top picks.`);
    }
  };

  const selectedHotel = city.customHotel
    ? null
    : city.hotels[city.selectedHotelIndex] ?? city.hotels[0];

  // The hotel's price already covers every room the party needs (see
  // `hotelsTotal` in lib/tripTotals.ts), so the stay is shown as priced.
  const stayRoom = displayAmount(eff.roomSubtotal, priceMode, trip.travelers);
  const stayTotal = displayAmount(eff.total, priceMode, trip.travelers);
  // Taxes as the difference of the two shown amounts, so the breakdown adds
  // up after rounding: 810.36 + 40.38 = 850.74 read "$810 + $40 = $851".
  const stayTaxes = eff.taxesSubtotal > 0 ? stayTotal - stayRoom : 0;
  const stayPerNight = displayAmount(eff.pricePerNight, priceMode, trip.travelers);
  const hasTaxes = stayTaxes > 0;

  const canPrev = cityIndex > 0;
  const canNext = cityIndex < trip.cities.length - 1;

  // ── Opening and closing ──────────────────────────────────────────────
  // Opening: the guide grows out of the city's card into the left column
  // (its contents fading in once it is nearly there), then the map slides in
  // beside it. Closing runs it backwards: the map slides out, the contents
  // fade, and the guide shrinks back into the card as the flowchart returns.
  const reduceMotion = useReducedMotion();
  const guideRef = useRef<HTMLDivElement>(null);
  const guideAnim = useAnimationControls();
  const contentAnim = useAnimationControls();
  const [mapShown, setMapShown] = useState(true);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** The transform that puts the guide over `r`, scaled from its top-left corner. */
  const overRect = (r: DOMRect) => {
    const g = guideRef.current!.getBoundingClientRect();
    return { x: r.left - g.left, y: r.top - g.top, scaleX: r.width / g.width, scaleY: r.height / g.height };
  };

  // Before the first paint, so the guide is never seen full size first.
  useLayoutEffect(() => {
    const from = reduceMotion ? null : originOf?.(cityIndex);
    if (guideRef.current && from) {
      guideAnim.set({ ...overRect(from), opacity: 1 });
      contentAnim.set({ opacity: 0 });
      guideAnim.start({
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        backgroundColor: color.bg,
        borderColor: color.border,
        transition: { duration: GROW_S, ease: EASE },
      });
      contentAnim.start({ opacity: 1, transition: { duration: 0.22, delay: GROW_S * 0.55 } });
    } else {
      guideAnim.set({ opacity: 0, scale: 0.97, backgroundColor: color.bg, borderColor: color.border });
      guideAnim.start({ opacity: 1, scale: 1, transition: { duration: 0.28, ease: EASE } });
      contentAnim.set({ opacity: 1 });
    }
    // Once, on opening; the prev/next arrows change the city in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestClose = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reduceMotion) {
      onClose();
      return;
    }
    setMapShown(false);
    await new Promise((r) => setTimeout(r, 160));
    if (!mountedRef.current) return;
    await contentAnim.start({ opacity: 0, transition: { duration: 0.12 } });
    if (!mountedRef.current) return;
    onCloseStart?.();
    const to = originOf?.(cityIndex);
    if (to && guideRef.current) {
      // Fading over the last stretch hands over to the real card underneath
      // without a seam, even when the card has since moved a pixel or two.
      await guideAnim.start({
        ...overRect(to),
        backgroundColor: cityColor.bg,
        borderColor: cityColor.border,
        opacity: [1, 1, 0],
        transition: { duration: SHRINK_S, ease: EASE, opacity: { duration: SHRINK_S, times: [0, 0.7, 1] } },
      });
    } else {
      await guideAnim.start({ opacity: 0, scale: 0.97, transition: { duration: 0.22, ease: EASE } });
    }
    if (mountedRef.current) onClose();
  };

  /* Unique class for scoped scrollbar styling */
  const uid = useId().replace(/:/g, '');
  const scrollCls = `cdp-scroll-${uid}`;

  return (
    <div className="h-full flex gap-3" data-testid="city-guide-split">
    <motion.div
      ref={guideRef}
      animate={guideAnim}
      className="h-full flex-shrink-0 w-[clamp(420px,44%,580px)] rounded-3xl border-2 overflow-hidden relative"
      style={{ transformOrigin: '0 0' }}
      initial={{ backgroundColor: cityColor.bg, borderColor: cityColor.border }}
    >
    <motion.div animate={contentAnim} className="h-full flex flex-col">
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
        className="px-7 pt-12 pb-4 flex-shrink-0 relative"
        style={{ borderBottom: `1px solid ${color.border}` }}
      >
        {/* Room on the right for the arrows and the stacked dates under them. */}
        <div className="min-w-0 pr-[170px]">
          <div
            className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] mb-2"
            style={{ color: `${color.text}aa` }}
          >
            <span>City {String(cityIndex + 1).padStart(2, '0')} of {String(trip.cities.length).padStart(2, '0')}</span>
          </div>
          <h2 className="text-3xl font-semibold leading-tight truncate" style={{ color: color.text }}>
            {city.name}
          </h2>
          {/* Country and nights under the name; the dates are on the right. */}
          <div className="mt-1 text-sm truncate" style={{ color: `${color.text}99` }}>
            {city.country}
            {city.country ? ' · ' : ''}
            {nights} {nights === 1 ? 'night' : 'nights'}
          </div>

        </div>

        {/* Nav controls, top right, with the arrive and depart dates under them */}
        <div>
          <div className="absolute top-[42px] right-5 flex items-center gap-1.5">
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
              onClick={requestClose}
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

          {/* Arrive and depart dates, stacked in the free corner under the
              arrows. The flights themselves are on the flowchart. */}
          <TravelDates
            arrive={effectiveTransportIn(trip, cityIndex)}
            depart={effectiveTransportOut(trip, cityIndex)}
            // The first city's way in is the home flight, which lands on
            // the stay's first date by construction (firstStayArrival). An
            // inter-city leg past midnight lands the day after its city's
            // first date.
            arriveDate={cityIndex === 0 ? city.dates.arrival : legArrivalDate(effectiveTransportIn(trip, cityIndex), city.dates.arrival)}
            departDate={city.dates.departure}
            color={color}
          />
        </div>
      </div>

      {/* The chosen hotel — photos, price, booking — held in place above the list */}
      <div className="px-7 pt-4 pb-3.5 flex-shrink-0" style={{ borderBottom: `1px solid ${color.border}` }}>
        <HotelHero
          hotel={selectedHotel ?? null}
          onGallery={(name, photos) => patchHotel(name, { photos })}
          customName={city.customHotel?.name}
          total={stayTotal}
          perNight={stayPerNight}
          nights={nights}
          accent={color}
        />
      </div>

      {/* The list of hotels — scrolls on its own under the chosen one */}
      <div className={`flex-1 min-h-0 overflow-y-auto ${scrollCls}`}>

        {/* Hotel picker */}
        <div className="px-7 pt-4 pb-5">
          <div className="flex items-start justify-between mb-4 gap-4">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold pt-1" style={{ color: color.text }}>
              <Building2 size={12} />
              <span>Where you&apos;ll stay</span>
            </div>
            {/* No stay found: no "$0" stay total. */}
            {hasStay(city) && (
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
                    · {nights} {nights === 1 ? 'night' : 'nights'}
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
                        <span>Room · ${stayPerNight.toLocaleString()} × {nights} {nights === 1 ? 'night' : 'nights'}</span>
                        <span>${stayRoom.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between w-full">
                        <span>Taxes &amp; fees</span>
                        <span>${stayTaxes.toLocaleString()}</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>

          {hotelNote && (
            <div className="text-[11.5px] mb-2" style={{ color: `${color.text}99` }}>
              {hotelNote}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {listed.map(({ hotel: h, index: i, pinned }, k) => (
              <HotelRow
                key={`${i}:${h.name}`}
                hotel={h}
                rank={i}
                isSelected={!city.customHotel && city.selectedHotelIndex === i}
                nights={nights}
                color={color}
                onSelect={() => setSelectedHotel(cityIndex, i)}
                caption={pinned ? 'Your pick' : k === 1 && listed[0].pinned ? 'More hotels' : undefined}
              />
            ))}
          </div>

          {/* After the list: the next set is what you reach for once you've
              looked through this one — and up top it cost the list a row. */}
          {city.hotels.length > 0 && (
            <div className="flex items-center gap-2 mt-3">
              <button
                type="button"
                onClick={findMoreHotels}
                disabled={findingHotels}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-medium transition-colors disabled:cursor-wait"
                style={{ borderColor: color.border, background: `${color.text}0c`, color: color.text }}
              >
                {findingHotels ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                <span>{findingHotels ? 'Finding hotels…' : 'Find more hotels'}</span>
              </button>
            </div>
          )}

          {/* Custom hotel form — `key` is load-bearing. The form seeds its five
              fields from `current` in useState initialisers, which only run on
              mount; without a remount per city it keeps the previous city's
              name/amount while Cancel and "Use this stay" write to the city on
              screen. */}
          <CustomHotelForm
            key={cityIndex}
            nights={nights}
            color={color}
            current={city.customHotel}
            onSave={(c) => setCustomHotel(cityIndex, c)}
            onClear={() => clearCustomHotel(cityIndex)}
          />
        </div>

        {/* The stay's breakdown — party, rooms, room and taxes, per person —
            at the foot of the list, for whoever wants the arithmetic. */}
        <div className="px-7 pt-2 pb-6 flex flex-col gap-3">
          <HotelDetail
            hotel={selectedHotel}
            isCustom={!!city.customHotel}
            nights={nights}
            travelers={trip.travelers}
            color={color}
          />
        </div>

      </div>

      {/* Color picker — top center */}
      <div
        className="absolute top-[11px] left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full border backdrop-blur-sm z-10"
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
    </motion.div>

    {/* The map, between the guide and BlueMurr AI. */}
    <AnimatePresence>
      {mapShown && (
        <motion.div
          key="hotel-map"
          className="h-full flex-1 min-w-0"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 56 }}
          animate={{ opacity: 1, x: 0, transition: { duration: 0.4, ease: EASE, delay: reduceMotion ? 0 : GROW_S * 0.6 } }}
          exit={{ opacity: 0, x: reduceMotion ? 0 : 56, transition: { duration: 0.22, ease: EASE } }}
        >
          <HotelMapPanel
            city={city}
            travelers={trip.travelers}
            nights={nights}
            entries={mapEntries}
            selectedIndex={city.customHotel ? null : city.selectedHotelIndex}
            onSelect={(i) => setSelectedHotel(cityIndex, i)}
          />
        </motion.div>
      )}
    </AnimatePresence>
    </div>
  );
}

/* --------------------------- Travel summary -------------------------- */

function TravelDates({
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
  const row = (label: string, Icon: LucideIcon, date: string, time: string | undefined) => (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      <Icon size={12} style={{ color: `${color.text}88` }} />
      <span className="text-[11px] uppercase tracking-[0.12em]" style={{ color: `${color.text}88` }}>
        {label}
      </span>
      <span className="text-[13px] font-semibold tabular-nums" style={{ color: color.text }}>
        {formatDateShort(date)}
      </span>
      {time && (
        <>
          <span style={{ color: `${color.text}50` }}>·</span>
          <span className="text-[13px] tabular-nums" style={{ color: color.text }}>{time}</span>
        </>
      )}
    </div>
  );
  return (
    <div className="absolute top-[84px] right-5 flex flex-col gap-1" data-testid="travel-dates">
      {row('Arr', arrive.mode === 'flight' ? PlaneLanding : TrainFront, arriveDate, arrive.arriveTime)}
      {row('Dep', depart.mode === 'flight' ? PlaneTakeoff : TrainFront, departDate, depart.departTime)}
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
  caption,
}: {
  hotel: Hotel;
  rank: number;
  isSelected: boolean;
  nights: number;
  color: { bg: string; text: string; border: string; name: string };
  onSelect: () => void;
  /** A small label above the row — "Your pick" when the pick is shown ahead of a new set. */
  caption?: string;
}) {
  const priceMode = useTripStore((s) => s.priceMode);
  const travelers = useTripStore((s) => s.currentTrip?.travelers ?? 1);
  const taxesGroup = (hotel.taxesPerNight ?? 0) * nights;
  const roomGroup = hotel.pricePerNight * nights;
  const totalGroup = roomGroup + taxesGroup;
  const total = displayAmount(totalGroup, priceMode, travelers);
  // Same rounding rule as the breakdown: the part of the shown total that
  // isn't the shown room price.
  const taxes = taxesGroup > 0 ? total - displayAmount(roomGroup, priceMode, travelers) : 0;
  const perNight = displayAmount(hotel.pricePerNight, priceMode, travelers);
  const isTop = rank === 0;

  const accent = color.text;

  return (
    <>
    {caption && (
      <div className="text-[10px] uppercase tracking-[0.16em] font-semibold mt-1 -mb-0.5" style={{ color: `${accent}99` }}>
        {caption}
      </div>
    )}
    <button
      type="button"
      onClick={onSelect}
      className="text-left rounded-2xl border px-3.5 py-2 transition-all group"
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
            {/* One line for the name, one for the rest: the badges used to
                wrap onto a line of their own and made every row three tall. */}
            <div className="text-sm font-medium line-clamp-2" style={{ color: color.text }}>{hotel.name}</div>
            <div className="text-[12px] mt-0.5 flex items-center gap-2 flex-wrap" style={{ color: `${accent}88` }}>
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
                  title="Bookable directly through BlueMurr"
                >
                  <Zap size={9} fill="currentColor" />
                  BlueMurr book
                </span>
              )}
              <span className="flex items-center gap-0.5 text-[#fbbf24]">
                <Star size={10} fill="currentColor" />
                {hotel.rating}
              </span>
              {hotel.neighbourhood && (
                <>
                  <span style={{ color: `${accent}50` }}>·</span>
                  <span>{hotel.neighbourhood}</span>
                </>
              )}
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
                    incl. ${taxes.toLocaleString()} taxes
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-semibold tabular-nums" style={{ color: color.text }}>
            ${total.toLocaleString()}
          </div>
          <div className="text-[11px] tabular-nums" style={{ color: `${accent}70` }}>
            ${perNight.toLocaleString()}/night
          </div>
        </div>
      </div>
    </button>
    </>
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
  isCustom,
  nights,
  travelers,
  color,
}: {
  hotel: Hotel | null;
  /** A custom stay replaces the ranked list; otherwise no hotel = none found. */
  isCustom: boolean;
  nights: number;
  travelers: number;
  color: { bg: string; text: string; border: string; name: string };
}) {
  const priceMode = useTripStore((s) => s.priceMode);
  if (!hotel) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: `${color.text}70` }}>
        <span className="text-sm">{isCustom ? 'Using custom hotel' : 'No options found'}</span>
      </div>
    );
  }

  const accent = color.text;
  // The price already covers every room the party needs (see `hotelsTotal`
  // in lib/tripTotals.ts), so nothing here multiplies it by a room count.
  const taxesGroup = (hotel.taxesPerNight ?? 0) * nights;
  const roomGroup = hotel.pricePerNight * nights;
  const totalGroup = roomGroup + taxesGroup;
  const room = displayAmount(roomGroup, priceMode, travelers);
  const total = displayAmount(totalGroup, priceMode, travelers);
  // The difference of the two shown amounts, so the lines add up after
  // rounding (810.36 + 40.38 = 850.74 read "$810 + $40 = $851").
  const taxes = taxesGroup > 0 ? total - room : 0;
  const perNight = displayAmount(hotel.pricePerNight, priceMode, travelers);
  const rooms = roomsFor(travelers);
  // The explanatory "per person" footer is only useful when the main figures
  // are group totals — when the toggle is already in per-person mode, hide it.
  const perPerson =
    priceMode === 'total' && travelers > 1 ? Math.round(totalGroup / travelers) : null;

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
                <Zap size={8} fill="currentColor" /> BlueMurr book
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
            {rooms} {rooms === 1 ? 'room' : 'rooms'}
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
              ${perNight.toLocaleString()}/night × {nights} {nights === 1 ? 'night' : 'nights'}
            </span>
            <span className="font-medium tabular-nums" style={{ color: accent }}>${room.toLocaleString()}</span>
          </div>
          {taxes > 0 && (
            <div className="flex justify-between text-[13px]" style={{ color: `${accent}cc` }}>
              <span>Taxes &amp; fees</span>
              <span className="font-medium tabular-nums" style={{ color: accent }}>${taxes.toLocaleString()}</span>
            </div>
          )}
          <div className="h-[2px] rounded-full my-1" style={{ background: color.border }} />
          <div className="flex justify-between items-baseline">
            <span className="text-[13px] font-semibold" style={{ color: accent }}>{priceMode === 'perPerson' ? 'Per person' : 'Total'}</span>
            <span className="text-lg font-bold tabular-nums" style={{ color: accent }}>${total.toLocaleString()}</span>
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
