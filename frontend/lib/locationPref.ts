/**
 * App-level "use my location" preference.
 *
 * The browser owns the actual geolocation permission and a site can never
 * revoke its own grant — so users who picked "always allow" but change
 * their mind need an app-side switch. When this pref is off the app never
 * calls geolocation at all, regardless of what the browser would permit.
 *
 * Stored in localStorage; only the off state is written so the default
 * stays "on" for users who never touch the toggle.
 */

const KEY = 'bluemurr-use-location';

export function getUseLocationPref(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    // SSR or storage blocked — behave like the default.
    return true;
  }
}

export function setUseLocationPref(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    // Storage unavailable — the in-memory toggle still works for the session.
  }
}
