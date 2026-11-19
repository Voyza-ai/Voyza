'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { X, Star, ExternalLink, Check, Map as MapIcon, Loader2 } from 'lucide-react';
import type { City } from '@/lib/types';
import { useTripStore } from '@/store/tripStore';
import { displayAmount } from '@/lib/tripTotals';
import { locateHotels, type HotelEntry, type HotelPin } from '@/lib/hotelMap';
import { fetchLandmarks, type Landmark } from '@/lib/landmarks';
import type { GeoPoint } from '@/lib/geocode';
import { loadMapStyle, readStoredStyle, SPOT_STYLE, SPOT_LABEL_MAX, BLUE } from './MapView';

/**
 * "Open map" in the city guide: the hotels the guide is listing, pinned where
 * they are, on the same basemap and with the same hotel pin as the Map tab.
 * Clicking a pin opens that hotel's card, where it can be chosen for the stay.
 *
 * Loaded with next/dynamic({ ssr: false }) — MapLibre needs `window`.
 */

type Props = {
  city: City;
  travelers: number;
  nights: number;
  entries: HotelEntry[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onClose: () => void;
};

/**
 * The popup's frame in the map's own colours — the land colour, with a border
 * a shade darker — so the map reads as the whole window rather than a picture
 * set in a coloured mount. Follows the map theme the traveller picked on the
 * Map tab ("light" is the stock basemap's grey).
 */
const FRAMES = {
  voyza: { bg: BLUE.land, border: BLUE.road, text: BLUE.textStrong, muted: BLUE.text },
  light: { bg: 'rgb(242,243,240)', border: '#dcddd8', text: '#2b2f36', muted: '#5f6670' },
} as const;

/**
 * Place names this map leaves out: neighbourhoods and districts ("3rd
 * Arrondissement", "Pigalle"), villages and towns. At city scale they were a
 * label every few centimetres, and they buried the hotels and landmarks the
 * map is for. City names, water and street names stay.
 */
/** Left padding that keeps pins out from under the hotel card (320px wide, 16px in). */
const CARD_CLEARANCE = 370;

const HIDDEN_PLACE_LABELS = /^label_(other|village|town)$/;

/**
 * Main roads from city zoom. The Map tab brings them in at 11-12 because it
 * starts from the whole trip; this map starts framed on one city's hotels,
 * often just under 12 once the card's room is taken, and without the arteries
 * the city was a blank wash with water in it. Side streets keep the Map
 * tab's zoom.
 */
const ROAD_MINZOOM: Array<[RegExp, number]> = [
  [/motorway/, 9],
  [/major/, 10.5],
];

/** The shared basemap, adjusted for this map — on a copy, so the Map tab keeps its own. */
function hotelMapStyle(style: maplibregl.StyleSpecification | string): maplibregl.StyleSpecification | string {
  if (typeof style === 'string') return style;
  const copy = JSON.parse(JSON.stringify(style)) as maplibregl.StyleSpecification;
  for (const layer of copy.layers as any[]) {
    if (HIDDEN_PLACE_LABELS.test(layer.id)) {
      layer.layout = { ...(layer.layout ?? {}), visibility: 'none' };
    } else if (layer['source-layer'] === 'transportation') {
      const tier = ROAD_MINZOOM.find(([re]) => re.test(layer.id));
      if (tier) layer.minzoom = tier[1];
    }
  }
  return copy;
}

const HOTEL = SPOT_STYLE.hotel;

const hotelGlyph = (stroke: string, size = 13) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${HOTEL.paths
    .map((d) => `<path d="${d}"/>`)
    .join('')}</svg>`;

/**
 * The Map tab's spot pin (white disc, purple ring, bed glyph, name plate above)
 * with the list number in front of the name. The trip's pick is the filled
 * disc; the open card's hotel gets a purple name plate.
 */
function makeHotelPinEl(pin: HotelPin, picked: boolean, active: boolean, onClick: () => void): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = `width:24px;height:24px;cursor:pointer;z-index:${active ? 30 : picked ? 20 : 10};`;
  el.title = pin.hotel.name;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${pin.hotel.name} — show details`);
  el.dataset.hotelPin = String(pin.index);

  const label = document.createElement('div');
  label.textContent = `${pin.index + 1} · ${pin.hotel.name}`;
  label.style.cssText = `
    position:absolute;bottom:28px;left:50%;transform:translateX(-50%);
    max-width:${active ? 280 : SPOT_LABEL_MAX}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    font:600 10.5px/1.3 system-ui,sans-serif;
    color:${active ? '#fff' : '#26324b'};
    background:${active ? HOTEL.color : 'rgba(255,255,255,0.94)'};
    border:1px solid ${active ? HOTEL.color : 'rgba(0,0,0,0.07)'};
    border-radius:5px;padding:1.5px 5px;box-shadow:0 1px 3px rgba(0,0,0,0.11);
    transition:max-width .12s ease;pointer-events:none;
  `;
  el.appendChild(label);

  const disc = document.createElement('div');
  disc.style.cssText = `
    width:24px;height:24px;border-radius:9999px;
    background:${picked ? HOTEL.color : '#fff'};
    border:2px solid ${HOTEL.color};
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 1px 5px rgba(0,0,0,0.2);
    ${active ? 'transform:scale(1.18);' : ''}
  `;
  disc.innerHTML = hotelGlyph(picked ? '#fff' : HOTEL.color);
  el.appendChild(disc);

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  el.addEventListener('mouseenter', () => {
    label.style.maxWidth = '280px';
    if (!active) label.style.background = '#ffffff';
    el.style.zIndex = '40';
  });
  el.addEventListener('mouseleave', () => {
    label.style.maxWidth = `${active ? 280 : SPOT_LABEL_MAX}px`;
    if (!active) label.style.background = 'rgba(255,255,255,0.94)';
    el.style.zIndex = active ? '30' : picked ? '20' : '10';
  });
  return el;
}

const LANDMARK = SPOT_STYLE.sightseeing.color;

/**
 * A landmark: a small amber dot (the Map tab's colour for sights) with its
 * name beside it, no plate and no ring. Present enough to read the city by,
 * quiet enough that the hotels stay the thing on the map. Not clickable, so it
 * never takes a click meant for a hotel pin under it.
 */
function makeLandmarkEl(l: Landmark): HTMLDivElement {
  const el = document.createElement('div');
  // Below every hotel pin, whatever order the markers were added in.
  el.style.cssText = 'width:10px;height:10px;pointer-events:none;z-index:1;';
  el.dataset.landmark = l.name;
  const dot = document.createElement('div');
  dot.style.cssText = `width:10px;height:10px;border-radius:9999px;background:${LANDMARK};border:2px solid #fff;box-shadow:0 0 0 1px rgba(217,119,6,0.4);`;
  el.appendChild(dot);
  const label = document.createElement('div');
  label.textContent = l.name;
  label.style.cssText = `
    position:absolute;left:14px;top:50%;transform:translateY(-50%);
    white-space:nowrap;font:600 12px/1.2 system-ui,sans-serif;color:#7a3c04;letter-spacing:0.01em;
    text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff,0 0 3px #fff,0 0 5px #fff;
  `;
  el.appendChild(label);
  return el;
}

type Box = { left: number; top: number; right: number; bottom: number };
const boxOf = (els: Element[]): Box => {
  const rs = els.map((e) => e.getBoundingClientRect());
  return {
    left: Math.min(...rs.map((r) => r.left)),
    top: Math.min(...rs.map((r) => r.top)),
    right: Math.max(...rs.map((r) => r.right)),
    bottom: Math.max(...rs.map((r) => r.bottom)),
  };
};
const overlaps = (a: Box, b: Box, gap = 3) =>
  a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;

/**
 * Hide any landmark whose dot or name would sit on a hotel pin or on a
 * better-known landmark ("Westminster Abbey" printed over "Palace of
 * Westminster"). Landmarks arrive best-known first, so the famous one stays.
 * Hotels always win. Run again whenever the camera settles.
 */
function declutterLandmarks(
  hotels: maplibregl.Marker[],
  landmarks: maplibregl.Marker[],
  frame: Element | null,
  card: Element | null,
) {
  const taken: Box[] = hotels.map((m) => boxOf([m.getElement(), ...Array.from(m.getElement().children)]));
  // Under the open card counts as taken too: a name half under it reads as cut off.
  if (card) taken.push(boxOf([card]));
  const view = frame ? boxOf([frame]) : null;
  for (const m of landmarks) {
    const el = m.getElement();
    el.style.visibility = 'visible';
    const box = boxOf([el, ...Array.from(el.children)]);
    // A name running off the edge of the map ("Père Lach…") is left out.
    const clipped = !!view && (box.left < view.left || box.right > view.right || box.top < view.top || box.bottom > view.bottom);
    if (clipped || taken.some((t) => overlaps(t, box))) {
      el.style.visibility = 'hidden';
    } else {
      taken.push(box);
    }
  }
}

export default function HotelMapModal({
  city,
  travelers,
  nights,
  entries,
  selectedIndex,
  onSelect,
  onClose,
}: Props) {
  const frame = FRAMES[readStoredStyle()] ?? FRAMES.voyza;
  // Read when the hotels have been placed, to open the pick's card.
  const selectedRef = useRef(selectedIndex);
  selectedRef.current = selectedIndex;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const landmarkMarkersRef = useRef<maplibregl.Marker[]>([]);
  const [located, setLocated] = useState<{ centre: GeoPoint | null; pins: HotelPin[]; unplaced: HotelEntry[] } | null>(null);
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  const [failed, setFailed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Which hotels to place — by slot and name, so a pick made from the card
  // (which re-orders nothing) does not look them up again.
  const entryKey = entries.map((e) => `${e.index}:${e.hotel.name}`).join('|');

  // Escape closes the map, not the guide underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Locate the hotels, then build the map framed on them.
  useEffect(() => {
    let cancelled = false;
    let map: maplibregl.Map | null = null;
    setLocated(null);
    setFailed(false);
    setMapReady(false);
    Promise.all([locateHotels(city, travelers, entries), loadMapStyle(readStoredStyle())])
      .then(([found, style]) => {
        if (cancelled || !containerRef.current) return;
        setLocated({ centre: found.centre, pins: found.pins, unplaced: found.unplaced });
        // Open on a hotel's card — the pick's when it is on the map — so the
        // card is there the moment the map is.
        setActiveIndex(found.pins.find((p) => p.index === selectedRef.current)?.index ?? found.pins[0]?.index ?? null);
        if (!found.centre) {
          setFailed(true);
          return;
        }
        const pts = found.pins.map((p) => p.point);
        // Framed on the hotels, clear of the card (bottom left, open from the
        // start) and with room above each pin for its name plate.
        const narrow = containerRef.current.clientWidth < 760;
        const camera: Partial<maplibregl.MapOptions> =
          pts.length >= 1
            ? {
                bounds: pts.reduce(
                  (b, p) => b.extend([p.lon, p.lat]),
                  new maplibregl.LngLatBounds([pts[0].lon, pts[0].lat], [pts[0].lon, pts[0].lat]),
                ),
                fitBoundsOptions: {
                  // Bottom: clear of the map credits line.
                  padding: { top: 70, bottom: 75, left: narrow ? 50 : CARD_CLEARANCE, right: 60 },
                  // One hotel alone: out far enough to see the landmarks
                  // around it (at 14 London's one pin had none in view).
                  maxZoom: pts.length >= 2 ? 15 : 13,
                },
              }
            : { center: [found.centre.lon, found.centre.lat], zoom: 12 };
        map = new maplibregl.Map({
          container: containerRef.current,
          style: hotelMapStyle(style),
          attributionControl: { compact: true },
          ...camera,
        });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
        map.on('click', () => setActiveIndex(null));
        let readied = false;
        const ready = () => {
          if (readied) return;
          readied = true;
          setMapReady(true);
        };
        map.on('load', ready);
        map.on('idle', ready);
        mapRef.current = map;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      landmarkMarkersRef.current.forEach((m) => m.remove());
      landmarkMarkersRef.current = [];
      map?.remove();
      mapRef.current = null;
    };
    // `entries` is captured through `entryKey`; the city only by what is searched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey, city.name, city.country, city.dates.arrival, city.dates.departure, travelers]);

  // Landmarks around the city centre — after the hotels, never holding them up.
  const centreKey = located?.centre ? `${located.centre.lat},${located.centre.lon}` : '';
  useEffect(() => {
    if (!located?.centre) return;
    let cancelled = false;
    fetchLandmarks(located.centre).then((items) => {
      if (!cancelled) setLandmarks(items);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    landmarkMarkersRef.current.forEach((m) => m.remove());
    landmarkMarkersRef.current = landmarks.map((l) =>
      new maplibregl.Marker({ element: makeLandmarkEl(l), anchor: 'center' })
        .setLngLat([l.point.lon, l.point.lat])
        .addTo(map),
    );
  }, [mapReady, landmarks]);

  // Keep landmark names off the hotels and off each other.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const run = () =>
      declutterLandmarks(
        markersRef.current,
        landmarkMarkersRef.current,
        containerRef.current,
        containerRef.current?.parentElement?.querySelector('[data-testid=hotel-map-card]') ?? null,
      );
    const raf = requestAnimationFrame(run);
    map.on('moveend', run);
    return () => {
      cancelAnimationFrame(raf);
      map.off('moveend', run);
    };
  }, [mapReady, landmarks, located, selectedIndex, activeIndex]);

  // Pins: rebuilt when the pick or the open card changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !located) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = located.pins.map((pin) =>
      new maplibregl.Marker({
        element: makeHotelPinEl(pin, pin.index === selectedIndex, pin.index === activeIndex, () =>
          setActiveIndex(pin.index),
        ),
        anchor: 'center',
      })
        .setLngLat([pin.point.lon, pin.point.lat])
        .addTo(map),
    );
  }, [mapReady, located, selectedIndex, activeIndex]);

  const active = useMemo(
    () => located?.pins.find((p) => p.index === activeIndex) ?? null,
    [located, activeIndex],
  );

  const placedCount = located?.pins.length ?? 0;
  const subline = !located
    ? 'Finding where they are…'
    : placedCount === entries.length
      ? `${entries.length} ${entries.length === 1 ? 'hotel' : 'hotels'} · click a pin for details`
      : `${placedCount} of ${entries.length} hotels on the map · click a pin for details`;

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,15,26,0.55)' }}
      onClick={onClose}
      data-testid="hotel-map-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Hotels in ${city.name} on a map`}
        className="relative w-full max-w-[1040px] h-[min(80vh,760px)] rounded-3xl overflow-hidden flex flex-col"
        style={{ background: frame.bg, border: `1.5px solid ${frame.border}`, boxShadow: '0 12px 40px rgba(15,15,26,0.28)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-6 py-4 flex items-center justify-between gap-4 flex-shrink-0"
          style={{ borderBottom: `1px solid ${frame.border}` }}
        >
          <div className="min-w-0">
            <div
              className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold"
              style={{ color: frame.text }}
            >
              <MapIcon size={12} />
              <span>Hotels in {city.name}</span>
            </div>
            <div className="text-[12px] mt-1" style={{ color: frame.muted }}>
              {subline}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full border flex items-center justify-center transition-all flex-shrink-0"
            style={{ borderColor: frame.border, color: frame.text, background: '#ffffff' }}
            aria-label="Close map"
          >
            <X size={16} />
          </button>
        </div>

        <div className="relative flex-1 min-h-0">
          {/* Inline, not a class: MapLibre's stylesheet sets `.maplibregl-map
              { position: relative }`, which beat `absolute inset-0` and left
              the map 0px tall. */}
          <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

          {!located && !failed && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="flex items-center gap-2 px-3.5 py-2 rounded-full border text-[12px] bg-white"
                style={{ borderColor: frame.border, color: frame.text }}
              >
                <Loader2 size={13} className="animate-spin" />
                Placing hotels on the map…
              </div>
            </div>
          )}
          {failed && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              <div className="text-[13px]" style={{ color: frame.muted }}>
                We couldn&apos;t load a map of {city.name} right now. Try again in a moment.
              </div>
            </div>
          )}

          {active && (
            <HotelCard
              pin={active}
              picked={active.index === selectedIndex}
              nights={nights}
              travelers={travelers}
              onChoose={() => onSelect(active.index)}
              onClose={() => setActiveIndex(null)}
            />
          )}
        </div>

        {located && located.unplaced.length > 0 && (
          <div
            className="px-6 py-2.5 text-[11.5px] flex-shrink-0"
            style={{ color: frame.muted, borderTop: `1px solid ${frame.border}` }}
          >
            Not on the map: {located.unplaced.map((e) => e.hotel.name).join(', ')} — we couldn&apos;t find{' '}
            {located.unplaced.length === 1 ? 'its' : 'their'} address.
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A hotel's card over the map — its price for this stay, and the way to pick or book it. */
function HotelCard({
  pin,
  picked,
  nights,
  travelers,
  onChoose,
  onClose,
}: {
  pin: HotelPin;
  picked: boolean;
  nights: number;
  travelers: number;
  onChoose: () => void;
  onClose: () => void;
}) {
  const priceMode = useTripStore((s) => s.priceMode);
  const h = pin.hotel;
  // Same figures as the guide's hotel row: room plus listed taxes, for the stay.
  const totalGroup = (h.pricePerNight + (h.taxesPerNight ?? 0)) * nights;
  const total = displayAmount(totalGroup, priceMode, travelers);
  const perNight = displayAmount(h.pricePerNight, priceMode, travelers);
  const reviews = typeof h.reviewCount === 'number' && h.reviewCount > 0 ? h.reviewCount : null;

  return (
    <div
      className="absolute left-4 bottom-4 w-[320px] max-w-[calc(100%-32px)] rounded-2xl border bg-white p-4 z-10"
      style={{ borderColor: '#d3ddec', boxShadow: '0 6px 24px rgba(23,43,77,0.18)' }}
      data-testid="hotel-map-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] font-semibold" style={{ color: HOTEL.color }}>
          <span
            className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] tracking-normal"
            style={{ background: picked ? HOTEL.color : '#fff', color: picked ? '#fff' : HOTEL.color, border: `1.5px solid ${HOTEL.color}` }}
          >
            {pin.index + 1}
          </span>
          {picked ? 'Your pick' : 'Hotel'}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mt-1 -mr-1 w-6 h-6 rounded-full flex items-center justify-center text-[#5a6b8a] hover:bg-[#eef3fb]"
          aria-label="Close hotel card"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mt-1.5 text-[15px] font-semibold leading-snug text-[#26324b]">{h.name}</div>
      <div className="mt-1 flex items-center gap-1.5 text-[12px] text-[#5a6b8a]">
        <span className="flex items-center gap-0.5 text-[#d97706] font-medium">
          <Star size={11} fill="currentColor" />
          {h.rating}
        </span>
        {reviews && (
          <>
            <span className="text-[#9fb8dc]">·</span>
            <span>{reviews.toLocaleString()} reviews</span>
          </>
        )}
        {h.area && (
          <>
            <span className="text-[#9fb8dc]">·</span>
            <span className="truncate">{h.area}</span>
          </>
        )}
      </div>
      <div className="mt-3 flex items-baseline gap-2 tabular-nums">
        <span className="text-[18px] font-semibold text-[#26324b]">${total.toLocaleString()}</span>
        <span className="text-[12px] text-[#5a6b8a]">
          for {nights} {nights === 1 ? 'night' : 'nights'} · ${perNight.toLocaleString()}/night
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {picked ? (
          <div className="flex-1 flex items-center justify-center gap-1.5 h-9 rounded-full text-[12.5px] font-medium bg-[#eef3fb] text-[#26324b]">
            <Check size={13} strokeWidth={3} />
            Your hotel for this stay
          </div>
        ) : (
          <button
            type="button"
            onClick={onChoose}
            className="flex-1 h-9 rounded-full text-[12.5px] font-medium text-white transition-colors"
            style={{ background: HOTEL.color }}
          >
            Choose this hotel
          </button>
        )}
        {h.bookingUrl && (
          <a
            href={h.bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="h-9 px-3.5 rounded-full border text-[12.5px] font-medium flex items-center gap-1 text-[#26324b] hover:bg-[#f4f7fc]"
            style={{ borderColor: '#d3ddec' }}
          >
            Booking.com
            <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}
