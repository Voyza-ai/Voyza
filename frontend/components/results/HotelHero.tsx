'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, ExternalLink, Star, Building2, MapPin } from 'lucide-react';
import type { Hotel } from '@/lib/types';
import { fetchHotelPhotos } from '@/lib/api';

/** Galleries already fetched (or being fetched) this page load, by Booking hotel id. */
const galleries = new Map<string, Promise<string[]>>();

/** A hotel's gallery: Booking's photo list once it is in, the search's one photo until then. */
export function useHotelPhotos(hotel: Hotel | null, onGallery?: (name: string, photos: string[]) => void): string[] {
  const base = hotel?.photos ?? [];
  const id = hotel?.providerId;
  const [gallery, setGallery] = useState<{ id: string; photos: string[] } | null>(null);
  const alreadySaved = base.length > 1;
  useEffect(() => {
    if (!id || alreadySaved) return;
    let live = true;
    if (!galleries.has(id)) {
      const p = fetchHotelPhotos(id);
      galleries.set(id, p);
      // A failed lookup is asked again next time the hotel is chosen.
      p.then((list) => {
        if (list.length === 0) galleries.delete(id);
      });
    }
    galleries.get(id)!.then((photos) => {
      if (live && photos.length > 0) setGallery({ id, photos });
    });
    // Nothing to fetch when the trip already holds the gallery (it was
    // written back the first time), so `base` alone is used below.
    return () => {
      live = false;
    };
  }, [id]);
  const merged =
    !gallery || gallery.id !== id
      ? base
      : base[0]
        ? // The search's photo leads (it is the one already on screen), then the rest.
          [base[0], ...gallery.photos.filter((u) => !samePhoto(u, base[0]))]
        : gallery.photos;
  // The gallery is written back onto the trip's hotel, so it is saved with
  // the trip and a reopened trip shows it without asking Booking again.
  const mergedKey = merged.join('|');
  useEffect(() => {
    if (hotel && onGallery && merged.length > base.length) onGallery(hotel.name, merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedKey]);
  return merged;
}

/** Two Booking URLs of the same photo at different sizes. */
function samePhoto(a: string, b: string): boolean {
  const id = (u: string) => u.match(/\/(\d+)\.jpg/)?.[1];
  return !!id(a) && id(a) === id(b);
}

/** Start loading these photos now, so choosing the hotel shows its photo at once. */
export function preloadPhotos(urls: string[]): void {
  if (typeof window === 'undefined') return;
  for (const u of urls) {
    const img = new Image();
    img.decoding = 'async';
    img.src = u;
  }
}

type Accent = { bg: string; text: string; border: string };

/**
 * The top of the city guide: the chosen hotel's photos, swiped or stepped
 * through like a booking site's gallery, with its name, rating and price for
 * the stay under them.
 */
export default function HotelHero({
  hotel,
  onGallery,
  customName,
  total,
  perNight,
  nights,
  accent,
}: {
  hotel: Hotel | null;
  /** The hotel's full gallery arrived: keep it on the trip. */
  onGallery?: (name: string, photos: string[]) => void;
  /** The traveller's own stay, when they entered one — it has no photos. */
  customName?: string;
  total: number;
  perNight: number;
  nights: number;
  accent: Accent;
}) {
  const photos = useHotelPhotos(customName ? null : hotel, onGallery);
  const reviews = typeof hotel?.reviewCount === 'number' && hotel.reviewCount > 0 ? hotel.reviewCount : null;

  return (
    <div className="flex flex-col gap-2.5" data-testid="hotel-hero">
      {/* Choosing another hotel cross-fades to its photos: the new strip
          fades in over the old one, so there is never an empty frame. */}
      <div className="relative w-full h-[clamp(110px,16vh,170px)] rounded-2xl overflow-hidden" style={{ background: '#eef0f4' }}>
        <AnimatePresence initial={false}>
          <motion.div
            key={hotel?.name ?? ''}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <PhotoStrip photos={photos} name={hotel?.name ?? ''} accent={accent} />
          </motion.div>
        </AnimatePresence>
      </div>
      {customName && (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[17px] font-semibold leading-snug truncate" style={{ color: accent.text }}>
              {customName}
            </div>
            <div className="mt-1 text-[12px] text-[#5a6070]">Your own stay</div>
          </div>
          <div className="text-[18px] font-semibold tabular-nums flex-shrink-0" style={{ color: accent.text }}>
            ${total.toLocaleString()}
          </div>
        </div>
      )}
      {hotel && !customName ? (
        <motion.div
          key={hotel.name}
          initial={{ opacity: 0.35 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="flex items-start justify-between gap-4"
        >
          <div className="min-w-0">
            {/* Two lines rather than "hub Earls Court - West Brom…" */}
            <div className="text-[17px] font-semibold leading-snug line-clamp-2" style={{ color: accent.text }}>
              {hotel.name}
            </div>
            {(hotel.neighbourhood || hotel.address) && (
              <div className="mt-0.5 flex items-start gap-1 text-[12px] text-[#5a6070] min-w-0" data-testid="hotel-area">
                <MapPin size={11} className="flex-shrink-0 mt-[3px]" style={{ color: accent.text }} />
                <span className="line-clamp-2">
                  {hotel.neighbourhood && <span className="font-medium" style={{ color: accent.text }}>{hotel.neighbourhood}</span>}
                  {hotel.neighbourhood && hotel.address ? ' · ' : ''}
                  {hotel.address}
                </span>
              </div>
            )}
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-[#5a6070]">
              <span className="flex items-center gap-0.5 text-[#d97706] font-medium">
                <Star size={11} fill="currentColor" />
                {hotel.rating}
              </span>
              {reviews && (
                <>
                  <span className="text-[#c4c8d0]">·</span>
                  <span>{reviews.toLocaleString()} reviews</span>
                </>
              )}
              {hotel.bookingUrl && (
                <>
                  <span className="text-[#c4c8d0]">·</span>
                  <a
                    href={hotel.bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 font-medium hover:underline"
                    style={{ color: accent.text }}
                  >
                    Booking.com
                    <ExternalLink size={11} />
                  </a>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end flex-shrink-0">
            <div className="text-[18px] font-semibold tabular-nums" style={{ color: accent.text }}>
              ${total.toLocaleString()}
            </div>
            <div className="text-[11.5px] tabular-nums text-[#5a6070]">
              {nights} {nights === 1 ? 'night' : 'nights'} · ${perNight.toLocaleString()}/night
            </div>
          </div>
        </motion.div>
      ) : null}
    </div>
  );
}

/** Photos side by side in a scroll-snapped row: swipe, scroll, or the arrows. */
function PhotoStrip({ photos, name, accent }: { photos: string[]; name: string; accent: Accent }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const shown = photos.filter((_, i) => !failed.has(i));

  // Track the photo in view from the scroll position, so swiping updates the dots.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const onScroll = () => setIndex(Math.round(row.scrollLeft / Math.max(1, row.clientWidth)));
    row.addEventListener('scroll', onScroll, { passive: true });
    return () => row.removeEventListener('scroll', onScroll);
  }, []);

  const go = (to: number) => {
    const row = rowRef.current;
    if (!row) return;
    const i = Math.max(0, Math.min(shown.length - 1, to));
    row.scrollTo({ left: i * row.clientWidth, behavior: 'smooth' });
  };

  if (shown.length === 0) {
    return (
      <div
        className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-[12px]"
        style={{ background: '#f3f4f7', color: '#8a90a0' }}
      >
        <Building2 size={20} />
        {name ? 'No photos for this hotel yet' : 'No photos'}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full group">
      <div
        ref={rowRef}
        className="absolute inset-0 flex overflow-x-auto snap-x snap-mandatory"
        style={{ scrollbarWidth: 'none' }}
        aria-label={`Photos of ${name}`}
      >
        {photos.map((src, i) =>
          failed.has(i) ? null : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={src}
              src={src}
              alt={`${name}, photo ${i + 1}`}
              className="w-full h-full flex-shrink-0 object-cover snap-center"
              draggable={false}
              onError={() => setFailed((f) => new Set(f).add(i))}
            />
          ),
        )}
      </div>
      {shown.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(index - 1)}
            disabled={index === 0}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 flex items-center justify-center shadow-sm disabled:opacity-0 transition-opacity"
            style={{ color: accent.text }}
            aria-label="Previous photo"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={() => go(index + 1)}
            disabled={index >= shown.length - 1}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 flex items-center justify-center shadow-sm disabled:opacity-0 transition-opacity"
            style={{ color: accent.text }}
            aria-label="Next photo"
          >
            <ChevronRight size={16} />
          </button>
          <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
            {shown.map((_, i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full transition-colors"
                style={{ background: i === index ? '#fff' : 'rgba(255,255,255,0.5)' }}
              />
            ))}
          </div>
        </>
      )}
      <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-black/45 text-white tabular-nums">
        {Math.min(index + 1, shown.length)} / {shown.length}
      </div>
    </div>
  );
}
