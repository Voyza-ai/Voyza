import { saveTrip, fetchHomeLegs } from './api';

// Carries an "Edit in Canvas" request across the sign-in step. Google OAuth is
// a full-page redirect that wipes in-memory trip state, so the intent (and the
// trip payload for unsaved trips) is stashed in sessionStorage before sign-in
// and resumed afterwards — by the OAuth callback page, or in-place for the
// email/password path.

const KEY = 'voyza.pending_canvas';

export type CanvasIntent = {
  // Set when the trip is already persisted — we just need to open it.
  savedId: string | null;
  // Set for unsaved trips — the exact payload to POST to saveTrip().
  payload: any | null;
  // Optional home-anchor data the canvas tab reads from localStorage.
  origin: { origin: any; returnToHome: boolean } | null;
  // The current (possibly AI-edited) cities from the results page. Handed off
  // so the canvas reflects results-page edits rather than the saved session.
  syncCities?: any[] | null;
  // Where to land after the save resolves. 'canvas' (default) opens the
  // canvas editor; 'results' opens the results page — used by Browse presets.
  destination?: 'canvas' | 'results';
};

// Per-trip handoff of the latest results-page trip state into the canvas tab.
// The canvas opens in a fresh tab where the in-memory store is empty, so edits
// made on results (e.g. via the AI chat) are passed through localStorage.
export type CanvasSync = {
  cities: any[];
  origin: any | null;
  returnToHome: boolean;
};

export function readCanvasSync(tripId: string): CanvasSync | null {
  try {
    const raw = localStorage.getItem(`voyza-canvas-sync-${tripId}`);
    return raw ? (JSON.parse(raw) as CanvasSync) : null;
  } catch {
    return null;
  }
}

export function clearCanvasSync(tripId: string): void {
  try {
    localStorage.removeItem(`voyza-canvas-sync-${tripId}`);
  } catch {
    // ignore
  }
}

export function stashCanvasIntent(intent: CanvasIntent): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // sessionStorage unavailable (SSR, privacy mode) — fall back to no handoff.
  }
}

export function readCanvasIntent(): CanvasIntent | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CanvasIntent) : null;
  } catch {
    return null;
  }
}

export function clearCanvasIntent(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// Saves the trip if it isn't persisted yet and returns the canvas tripId
// (null if there's nothing to open). Also seeds the per-trip origin data the
// canvas page reads on load.
export async function resolveCanvasTripId(intent: CanvasIntent): Promise<string | null> {
  let tripId = intent.savedId;
  if (!tripId && intent.payload) {
    const p = intent.payload;

    // Trips not built by the optimizer (Browse presets) have a home anchor
    // but no searched flights. Fetch real home legs before saving so the
    // flowchart connectors and canvas home cards show live flight data.
    // Non-fatal: on failure the trip saves without legs and the home cards
    // render as plain anchors.
    if (
      p.origin?.city &&
      Array.isArray(p.origin.airports) &&
      p.origin.airports.length > 0 &&
      !p.origin.outboundLeg &&
      Array.isArray(p.cities) &&
      p.cities.length > 0
    ) {
      try {
        const first = p.cities[0];
        const last = p.cities[p.cities.length - 1];
        const legs = await fetchHomeLegs({
          originAirports: p.origin.airports,
          originCity: p.origin.city,
          firstCity: first.name,
          lastCity: last.name,
          startDate: first.dates?.arrival,
          endDate: last.dates?.departure,
          travelers: p.travelers ?? 1,
          returnToHome: p.returnToHome ?? true,
        });
        if (legs.outboundLeg || legs.returnLeg) {
          p.origin = {
            ...p.origin,
            outboundLeg: legs.outboundLeg ?? null,
            returnLeg: legs.returnLeg ?? null,
          };
          // Keep the localStorage origin handoff in sync so the canvas
          // home cards get the flight pills too.
          if (intent.origin) intent.origin.origin = p.origin;
        }
      } catch {
        // Flight search failed — save without home legs.
      }
    }

    const result = await saveTrip(p);
    tripId = result.tripId;
  }
  if (!tripId) return null;
  if (intent.origin) {
    try {
      localStorage.setItem(`voyza-origin-${tripId}`, JSON.stringify(intent.origin));
    } catch {
      // ignore — canvas falls back to API data without it.
    }
  }

  // Hand off the current trip cities so the canvas reflects results-page edits
  // (e.g. AI-chat changes) instead of the stale saved session.
  const syncCities = intent.syncCities ?? intent.payload?.cities ?? null;
  if (syncCities && Array.isArray(syncCities) && syncCities.length > 0) {
    try {
      localStorage.setItem(
        `voyza-canvas-sync-${tripId}`,
        JSON.stringify({
          cities: syncCities,
          origin: intent.origin?.origin ?? null,
          returnToHome: intent.origin?.returnToHome ?? true,
        }),
      );
    } catch {
      // ignore — canvas falls back to the saved session without it.
    }
  }

  return tripId;
}
