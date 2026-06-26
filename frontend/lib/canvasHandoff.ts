import { saveTrip } from './api';

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
};

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
    const result = await saveTrip(intent.payload);
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
  return tripId;
}
