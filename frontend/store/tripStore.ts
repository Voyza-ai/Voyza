import { create } from 'zustand';
import { Trip, PlanningAnswers, City, CustomHotel, Transport, Restaurant, ScheduledEvent } from '@/lib/types';
import { firstStayArrival, tripStartDate } from '@/lib/tripSpan';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type TripStore = {
  // Planning state
  answers: Partial<PlanningAnswers>;
  currentStep: number;
  isLoading: boolean;

  // Trip state
  currentTrip: Trip | null;
  chatHistory: ChatMessage[];

  /**
   * Display-time toggle for every dollar amount on the results page.
   * 'total' shows group totals (the actual booking commitment).
   * 'perPerson' divides by trip.travelers — the framing people use to
   * gauge affordability. Single-traveler trips never need to flip.
   */
  priceMode: 'total' | 'perPerson';

  /**
   * True once this page load has put the trip back from sessionStorage after
   * a reload (restoreTripSession). Lets a mount that would otherwise re-buy
   * something the trip already showed — the chat's suggestion chips — tell a
   * reload apart from an ordinary visit. Never persisted.
   */
  restoredFromSession: boolean;

  // Actions
  setAnswer: (key: keyof PlanningAnswers, value: unknown) => void;
  nextStep: () => void;
  prevStep: () => void;
  setStep: (step: number) => void;
  setLoading: (loading: boolean) => void;
  setPriceMode: (mode: 'total' | 'perPerson') => void;
  setTrip: (trip: Trip) => void;
  updateCity: (index: number, city: Partial<City>) => void;
  setSelectedHotel: (cityIndex: number, hotelIndex: number) => void;
  cycleHotel: (cityIndex: number, direction: 1 | -1) => void;
  setCustomHotel: (cityIndex: number, custom: CustomHotel) => void;
  clearCustomHotel: (cityIndex: number) => void;
  setTransportOut: (cityIndex: number, alternativeIndex: number) => void;
  /**
   * Swap the home-anchor leg's main flight with one of its alternatives.
   * `direction: 'outbound'` updates trip.origin.outboundLeg, 'return'
   * updates trip.origin.returnLeg. The currently-selected leg is moved
   * back into alternatives so the user can re-pick later.
   */
  setHomeLegAlternative: (direction: 'outbound' | 'return', alternativeIndex: number) => void;
  setCityColor: (cityIndex: number, colorIndex: number) => void;
  addActivity: (cityIndex: number, activity: string) => void;
  removeActivity: (cityIndex: number, activityIndex: number) => void;
  updateActivity: (cityIndex: number, activityIndex: number, value: string) => void;
  addRestaurant: (cityIndex: number, restaurant: Restaurant) => void;
  removeRestaurant: (cityIndex: number, restaurantIndex: number) => void;
  updateRestaurant: (cityIndex: number, restaurantIndex: number, updates: Partial<Restaurant>) => void;
  setDaySchedule: (cityIndex: number, date: string, events: ScheduledEvent[]) => void;
  addScheduledEvent: (cityIndex: number, date: string, event: ScheduledEvent) => void;
  updateScheduledEvent: (cityIndex: number, date: string, eventId: string, updates: Partial<ScheduledEvent>) => void;
  removeScheduledEvent: (cityIndex: number, date: string, eventId: string) => void;
  addChatMessage: (role: 'user' | 'assistant', content: string) => void;
  setChatHistory: (history: ChatMessage[]) => void;
  resetPlanning: () => void;
};

export const useTripStore = create<TripStore>((set) => ({
  answers: {},
  currentStep: 0,
  isLoading: false,
  currentTrip: null,
  chatHistory: [],
  priceMode: 'total',
  restoredFromSession: false,

  setAnswer: (key, value) =>
    set((state) => ({ answers: { ...state.answers, [key]: value } })),

  nextStep: () => set((state) => ({ currentStep: state.currentStep + 1 })),
  prevStep: () => set((state) => ({ currentStep: Math.max(0, state.currentStep - 1) })),
  setStep: (step) => set({ currentStep: step }),
  setLoading: (loading) => set({ isLoading: loading }),

  setPriceMode: (mode) => set({ priceMode: mode }),

  setTrip: (trip) => set({ currentTrip: trip }),

  updateCity: (index, cityUpdate) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      cities[index] = { ...cities[index], ...cityUpdate };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  setSelectedHotel: (cityIndex, hotelIndex) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c || !c.hotels[hotelIndex]) return state;
      cities[cityIndex] = {
        ...c,
        selectedHotelIndex: hotelIndex,
        // Picking from the ranked list clears any custom hotel.
        customHotel: undefined,
        hotel: c.hotels[hotelIndex],
      };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  cycleHotel: (cityIndex, direction) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c || c.hotels.length === 0) return state;
      const len = c.hotels.length;

      // Step OVER rows whose price the backend does not trust.
      //
      // This used to be a plain modulo walk, which made the price guards
      // protect the auto-selection and nothing else. Measured on the real
      // store with the production Florence set: one backward click from a
      // $600 trip landed on the flagged $5383.47/night row and the total
      // became $16,150. "Flagged rows can never reach the trip total" was
      // simply false under manual selection.
      //
      // Cycling means "show me another option", and a price we cannot stand
      // behind is not an option to offer. The row stays in the list and stays
      // reachable through setSelectedHotel, so nothing is hidden and nothing
      // is unbookable — it just is not what a next/previous click hands you.
      //
      // If every row is flagged there is nothing better to land on, so the
      // walk falls back to plain cycling rather than refusing to move.
      let next = (c.selectedHotelIndex + direction + len) % len;
      for (let step = 0; step < len && c.hotels[next]?.priceSuspect; step++) {
        next = (next + direction + len) % len;
      }

      cities[cityIndex] = {
        ...c,
        selectedHotelIndex: next,
        customHotel: undefined,
        hotel: c.hotels[next],
      };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  setCustomHotel: (cityIndex, custom) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      cities[cityIndex] = { ...c, customHotel: custom };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  clearCustomHotel: (cityIndex) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      cities[cityIndex] = { ...c, customHotel: undefined };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  setTransportOut: (cityIndex, alternativeIndex) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      const currentOut = c.transportOut;
      const alts = currentOut.alternatives ?? [];
      const chosen = alts[alternativeIndex];
      if (!chosen) return state;
      // Move the currently picked option into alternatives (without its own
      // nested alternatives) and pull the chosen one out.
      const { alternatives: _chosenAlts, ...chosenFlat } = chosen;
      const { alternatives: _curAlts, ...currentFlat } = currentOut;
      const newAlts: Transport[] = alts.filter((_, i) => i !== alternativeIndex);
      newAlts.unshift(currentFlat);
      const newOut: Transport = { ...chosenFlat, alternatives: newAlts };
      cities[cityIndex] = { ...c, transportOut: newOut };
      // Keep the next city's transportIn in sync (strip alternatives).
      if (cityIndex + 1 < cities.length) {
        cities[cityIndex + 1] = {
          ...cities[cityIndex + 1],
          transportIn: chosenFlat,
        };
      }
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  setHomeLegAlternative: (direction, alternativeIndex) =>
    set((state) => {
      if (!state.currentTrip?.origin) return state;
      const slot = direction === 'outbound' ? 'outboundLeg' : 'returnLeg';
      const current = state.currentTrip.origin[slot];
      if (!current) return state;
      const alts = current.alternatives ?? [];
      const chosen = alts[alternativeIndex];
      if (!chosen) return state;
      // Move current pick into alternatives, pull the chosen one to main.
      // alternatives entries are Omit<HomeLeg, 'alternatives'> by design.
      const { alternatives: _curAlts, ...currentFlat } = current;
      const newAlts = alts.filter((_, i) => i !== alternativeIndex);
      newAlts.unshift(currentFlat);
      const newLeg = { ...chosen, alternatives: newAlts };
      // The first stay starts the day the outbound LANDS. Swapping an
      // overnight flight for a same-day one (or back) moves that day, and the
      // stay with it — a night gained or lost in the first city. The search
      // date every alternative shares is the trip's start. The results page
      // re-searches the city's hotels when its dates change.
      let cities = state.currentTrip.cities;
      const first = cities[0];
      if (direction === 'outbound' && first?.dates?.departure) {
        const startDate = chosen.departDate || tripStartDate(state.currentTrip);
        const arrival = startDate
          ? firstStayArrival({
              startDate,
              firstDeparture: first.dates.departure,
              landed: chosen.arriveDate ?? chosen.departDate,
            })
          : undefined;
        if (arrival && arrival !== first.dates.arrival) {
          cities = [{ ...first, dates: { ...first.dates, arrival } }, ...cities.slice(1)];
        }
      }
      return {
        currentTrip: {
          ...state.currentTrip,
          cities,
          origin: { ...state.currentTrip.origin, [slot]: newLeg },
        },
      };
    }),

  setCityColor: (cityIndex, colorIndex) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      cities[cityIndex] = { ...cities[cityIndex], colorIndex };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  addActivity: (cityIndex, activity) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      cities[cityIndex] = { ...c, activities: [...c.activities, activity] };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  removeActivity: (cityIndex, activityIndex) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      const activities = c.activities.filter((_, i) => i !== activityIndex);
      cities[cityIndex] = { ...c, activities };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  updateActivity: (cityIndex, activityIndex, value) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      const activities = [...c.activities];
      activities[activityIndex] = value;
      cities[cityIndex] = { ...c, activities };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  addRestaurant: (cityIndex, restaurant) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      cities[cityIndex] = { ...c, restaurants: [...c.restaurants, restaurant] };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  removeRestaurant: (cityIndex, restaurantIndex) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      const restaurants = c.restaurants.filter((_, i) => i !== restaurantIndex);
      cities[cityIndex] = { ...c, restaurants };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  updateRestaurant: (cityIndex, restaurantIndex, updates) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      const restaurants = [...c.restaurants];
      restaurants[restaurantIndex] = { ...restaurants[restaurantIndex], ...updates };
      cities[cityIndex] = { ...c, restaurants };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  setDaySchedule: (cityIndex, date, events) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      const schedule = { ...(c.schedule ?? {}), [date]: events };
      cities[cityIndex] = { ...c, schedule };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  addScheduledEvent: (cityIndex, date, event) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      const dayEvents = [...(c.schedule?.[date] ?? []), event];
      const schedule = { ...(c.schedule ?? {}), [date]: dayEvents };
      cities[cityIndex] = { ...c, schedule };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  updateScheduledEvent: (cityIndex, date, eventId, updates) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      const dayEvents = (c.schedule?.[date] ?? []).map((e) =>
        e.id === eventId ? { ...e, ...updates } : e
      );
      const schedule = { ...(c.schedule ?? {}), [date]: dayEvents };
      cities[cityIndex] = { ...c, schedule };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  removeScheduledEvent: (cityIndex, date, eventId) =>
    set((state) => {
      if (!state.currentTrip) return state;
      const cities = [...state.currentTrip.cities];
      const c = cities[cityIndex];
      if (!c) return state;
      const dayEvents = (c.schedule?.[date] ?? []).filter((e) => e.id !== eventId);
      const schedule = { ...(c.schedule ?? {}), [date]: dayEvents };
      cities[cityIndex] = { ...c, schedule };
      return { currentTrip: { ...state.currentTrip, cities } };
    }),

  setChatHistory: (history) => set({ chatHistory: history }),

  addChatMessage: (role, content) =>
    set((state) => ({
      chatHistory: [...state.chatHistory, { role, content }],
    })),

  resetPlanning: () =>
    set({
      answers: {},
      currentStep: 0,
      currentTrip: null,
      chatHistory: [],
      isLoading: false,
    }),
}));

// ─── The current trip survives a reload of this tab ──────────────────────────
//
// An unsaved trip lives nowhere but this store: the planner hands it over and
// routes to a bare `/results`. So a reload found an empty store and the
// results page sent a signed-out traveller to an empty `/plan` — a presenter
// pressing refresh mid-demo lost the whole trip.
//
// sessionStorage rather than localStorage: it is per TAB and ends with the
// tab, so two tabs planning two trips never overwrite each other and nothing
// outlives the session on a shared machine. Written here on every change;
// read back only by the results page, and only for a bare `/results` — a
// `?tripId=` reload still reads the database, which is how it picks up a
// canvas save made in another tab.
//
// The trip goes in whole. Measured in the browser, planning from captured
// production responses: 21 KB for a 3-city trip and 34 KB for a 5-city one,
// hotel lists (17-20 rows a city) about half of each, against a quota of
// megabytes. Trimming it would only add ways for a restored trip to differ
// from the one on screen before the reload.

const SESSION_KEY = 'bluemurr-current-trip';
/** Bump when the stored shape changes, so an old snapshot is ignored, not misread. */
const SESSION_VERSION = 1;

type TripSnapshot = {
  v: number;
  trip: Trip;
  priceMode: 'total' | 'perPerson';
};

/** sessionStorage, or null on the server and wherever reading it throws. */
function tabStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null; // storage disabled — touching the property throws
  }
}

function writeSnapshot(trip: Trip | null, priceMode: 'total' | 'perPerson') {
  const storage = tabStorage();
  if (!storage) return;
  try {
    if (!trip) {
      storage.removeItem(SESSION_KEY);
      return;
    }
    const snapshot: TripSnapshot = { v: SESSION_VERSION, trip, priceMode };
    storage.setItem(SESSION_KEY, JSON.stringify(snapshot));
  } catch {
    // Over quota, or storage blocked. Drop the entry rather than leave the
    // previous one: a reload that brings back an OLDER trip is worse than
    // one that brings back nothing.
    try {
      storage.removeItem(SESSION_KEY);
    } catch {
      // blocked outright — nothing was stored, nothing to clear
    }
  }
}

/**
 * Put this tab's last trip back in the store. True when it did.
 *
 * Only a snapshot this build wrote is accepted, and only one shaped well
 * enough for the results page's first render, which reads `city.hotels` and
 * `city.dates` straight away. Anything else is ignored, leaving the store
 * empty — exactly the state a reload produced before this existed.
 */
export function restoreTripSession(): boolean {
  const storage = tabStorage();
  if (!storage) return false;
  let snapshot: Partial<TripSnapshot> | null;
  try {
    const raw = storage.getItem(SESSION_KEY);
    snapshot = raw ? JSON.parse(raw) : null;
  } catch {
    return false;
  }
  const trip = snapshot?.trip;
  const usable =
    snapshot?.v === SESSION_VERSION &&
    !!trip &&
    Array.isArray(trip.cities) &&
    trip.cities.every((c) => !!c && Array.isArray(c.hotels) && !!c.dates);
  if (!usable) return false;
  useTripStore.setState({
    currentTrip: trip,
    priceMode: snapshot?.priceMode === 'perPerson' ? 'perPerson' : 'total',
    restoredFromSession: true,
  });
  return true;
}

// Browser only: on the server this module is shared by every request.
if (typeof window !== 'undefined') {
  useTripStore.subscribe((state, prev) => {
    if (state.currentTrip === prev.currentTrip && state.priceMode === prev.priceMode) return;
    writeSnapshot(state.currentTrip, state.priceMode);
  });
}
