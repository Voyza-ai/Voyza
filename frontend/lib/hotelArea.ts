/**
 * The neighbourhood a hotel is in — "Spitalfields", "Bloomsbury", "Monti",
 * "Kazimierz" — for the city guide's hotel card.
 *
 * Booking's own `district` is the borough ("Tower Hamlets", "Camden"), which a
 * visitor doesn't recognise, so the name comes from the hotel's coordinates
 * instead, from OpenStreetMap through Nominatim and Photon.
 *
 * Measured on 56 hotels in seven cities (2026-11-19):
 * - Nominatim `quarter` → `suburb` was right and recognisable for 7 of 8 in
 *   London, Rome and Kraków. Its `neighbourhood` field is skipped: it tends to
 *   be the obscurer, finer name (St Giles over Bloomsbury).
 * - Paris and Porto came back as administrative labels ("16th
 *   Arrondissement", "Historic Centre of Porto", "União de Freguesias…"),
 *   so those are refused here and Photon's `locality` (Paris's official
 *   quartiers — accurate, if not the names travellers use) is tried next.
 * - Ljubljana's clean names were in Photon's `district`.
 * - Some answers are wrong (a Lancaster Gate hotel came back as Kensal
 *   Town). Nothing here can catch that; it is why the name is shown as a
 *   quiet line, not a claim the trip is built on.
 *
 * Nothing usable from either: Booking's district, cleaned the same way, or no
 * area at all — better none than a wrong or meaningless one.
 *
 * Nominatim allows one request a second, so lookups are queued, and every
 * answer (including "no area") is kept in localStorage for 30 days.
 */

const STORAGE_KEY = 'voyza.hotelArea.v1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8_000;
const NOMINATIM_GAP_MS = 1_100;

/** Words that mark an administrative label rather than a place people call by name. */
const ADMIN_LABEL =
  /arrondissement|municipio|borough|historic (zone|centre|center)|conjunto urbano|uni[aã]o de freguesias|freguesia|\bcounty\b|\bdistrict\b|^\d+(st|nd|rd|th|e|er|ème)\b/i;

/** Prefixes that wrap a real name: "Quartier des Épinettes" → "Épinettes". */
const PREFIXES = [/^quartier (de la |de l'|du |des |de |d')/i, /^četrtna skupnost /i];

/**
 * A raw area name made fit to show, or null when it should not be shown: the
 * city's own name, an administrative label, or a list ("Cedofeita, Santo
 * Ildefonso, Sé…").
 */
export function cleanAreaName(raw: unknown, cityName: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  for (const p of PREFIXES) s = s.replace(p, '');
  s = s.trim();
  if (!s || s.length > 40 || s.includes(',')) return null;
  if (ADMIN_LABEL.test(s)) return null;
  const fold = (x: string) => x.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (fold(s) === fold(cityName)) return null;
  // Capitalise a lower-case answer ("center" → "Center").
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type AreaSources = {
  nominatim?: Record<string, unknown> | null;
  photon?: Record<string, unknown> | null;
  bookingDistrict?: string | null;
};

/** The first usable name, in the order measured best. */
export function pickArea(src: AreaSources, cityName: string): string | null {
  const candidates = [
    src.nominatim?.quarter,
    src.nominatim?.suburb,
    src.photon?.locality,
    src.photon?.district,
    src.bookingDistrict,
  ];
  for (const c of candidates) {
    const name = cleanAreaName(c, cityName);
    if (name) return name;
  }
  return null;
}

// ─── Cache ────────────────────────────────────────────────────────────

type Stored = Record<string, { at: number; area: string | null }>;

function readStore(): Stored {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Stored;
  } catch {
    return {};
  }
}

function writeStore(key: string, area: string | null) {
  try {
    const all = readStore();
    all[key] = { at: Date.now(), area };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Private window or storage full: the answer just isn't kept.
  }
}

const keyFor = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

// ─── Lookups ──────────────────────────────────────────────────────────

let nominatimQueue: Promise<unknown> = Promise.resolve();

/** Nominatim's address fields for a point, one request a second across the page. */
async function nominatimAddress(lat: number, lng: number): Promise<Record<string, unknown> | null> {
  const run = nominatimQueue.then(async () => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&accept-language=en`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return (data?.address as Record<string, unknown>) ?? null;
    } catch {
      return null;
    } finally {
      await new Promise((r) => setTimeout(r, NOMINATIM_GAP_MS));
    }
  });
  nominatimQueue = run.catch(() => null);
  return run;
}

async function photonProperties(lat: number, lng: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=en`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.features?.[0]?.properties as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

const inFlight = new Map<string, Promise<string | null>>();

/**
 * The neighbourhood at a hotel's coordinates, or null. Photon is asked only
 * when Nominatim has nothing usable. A lookup that failed outright (both
 * sources down) is not kept, so it is tried again next time.
 */
export function areaForPoint(lat: number, lng: number, cityName: string, bookingDistrict?: string | null): Promise<string | null> {
  const key = keyFor(lat, lng);
  const hit = readStore()[key];
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.area);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = (async () => {
    const nominatim = await nominatimAddress(lat, lng);
    let area = pickArea({ nominatim }, cityName);
    let photon: Record<string, unknown> | null = null;
    if (!area) {
      photon = await photonProperties(lat, lng);
      area = pickArea({ nominatim, photon, bookingDistrict }, cityName);
    }
    if (nominatim || photon) writeStore(key, area);
    return area;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
