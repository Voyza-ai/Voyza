import { create } from 'zustand';
import { Trip, PlanningAnswers, City, CustomHotel, Transport, Restaurant, ScheduledEvent } from '@/lib/types';
import { firstStayArrival, tripStartDate } from '@/lib/tripSpan';
import { searchActivities, searchRestaurants, type ActivitySuggestion, type RestaurantSuggestion } from '@/lib/api';
import { buildCityScheduleFromSuggestions } from '@/lib/dayScheduleDefaults';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/** What one city's AI picks are asked with — kept so a reload can ask again. */
export type CityPicksRequest = {
  city: string;
  vibe?: string;
  travelers: number;
  nights: number;
  budget?: number;
};

/** One city's AI picks. Both empty when the requests failed. */
export type CityPicks = {
  activities: ActivitySuggestion[];
  restaurants: RestaurantSuggestion[];
};

/**
 * The AI picks of the planner search the trip on screen came out of
 * (`Trip.picksRun`). /results opens before they are in; see startTripPicks.
 */
export type TripPicks = {
  run: string;
  /** Cities whose picks have not answered yet, with what they were asked. */
  pending: CityPicksRequest[];
  /** Picks that have landed, by city — put back if an older copy of the trip is set. */
  landed: Record<string, CityPicks>;
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

  /** The trip's AI picks while any are still on their way (see startTripPicks). */
  tripPicks: TripPicks | null;

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
  tripPicks: null,

  setAnswer: (key, value) =>
    set((state) => ({ answers: { ...state.answers, [key]: value } })),

  nextStep: () => set((state) => ({ currentStep: state.currentStep + 1 })),
  prevStep: () => set((state) => ({ currentStep: Math.max(0, state.currentStep - 1) })),
  setStep: (step) => set({ currentStep: step }),
  setLoading: (loading) => set({ isLoading: loading }),

  setPriceMode: (mode) => set({ priceMode: mode }),

  // A whole-trip replacement can be an older copy of the trip on screen —
  // an AI date proposal is the trip as it was when the message was sent,
  // echoed back by the server — taken before its AI picks landed. Accepting
  // it must not take them away, so picks that landed are put back on the
  // cities that have none (and still have them on screen). Only for a copy
  // of the same planner search (`picksRun`); any other trip is set exactly
  // as given.
  setTrip: (trip) =>
    set((state) => ({ currentTrip: keepLandedPicks(trip, state.tripPicks, state.currentTrip) })),

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
      // Any picks still out belong to the trip just dropped.
      tripPicks: null,
    }),
}));

// ─── AI picks that arrive after /results opens ───────────────────────────────
//
// The planner used to hold the traveller on /plan until every city's AI picks
// (activities and restaurants, ~8-9 s a city in production and the slowest
// part of the search) were in. It now hands the trip over as soon as flights
// and hotels are priced — every city scheduled with its transport blocks only,
// exactly what a failed pick request always left — and the picks fill in here
// when they answer. Nothing on screen waits on them: a city with no picks
// shows what it always showed without any (the flowchart draws no
// "Activities & Dining" card for it), and the card appears when they land.
//
// A landing goes to the trip in the STORE at that moment, not the planner's
// copy: by then the traveller may have swapped a hotel or changed dates, and
// the planner itself has unmounted.

const NO_PICKS: CityPicks = { activities: [], restaurants: [] };

/** Ask for one city's AI picks. Never rejects: a failed call is an empty list. */
export async function requestCityPicks(req: CityPicksRequest): Promise<CityPicks> {
  const [activities, restaurants] = await Promise.all([
    searchActivities({ city: req.city, vibe: req.vibe, travelers: req.travelers, nights: req.nights }).catch(
      () => [] as ActivitySuggestion[],
    ),
    searchRestaurants({ city: req.city, vibe: req.vibe, travelers: req.travelers, budget: req.budget }).catch(
      () => [] as RestaurantSuggestion[],
    ),
  ]);
  return { activities: activities ?? [], restaurants: restaurants ?? [] };
}

let runCounter = 0;
const newRun = () => `picks-${Date.now().toString(36)}-${++runCounter}`;

/**
 * Put a freshly planned trip on screen while its AI picks are still out.
 *
 * `inFlight[i]` is the request the planner already started for
 * `requests[i]` (it starts them before the hotel searches); a missing one is
 * asked here. Replaces any earlier search's picks, so a late answer from a
 * search the traveller has since redone is dropped.
 */
export function startTripPicks(
  trip: Trip,
  requests: CityPicksRequest[],
  inFlight: Array<Promise<CityPicks> | undefined> = [],
): void {
  const run = newRun();
  useTripStore.setState({
    currentTrip: { ...trip, picksRun: run },
    tripPicks: { run, pending: requests, landed: {} },
  });
  requests.forEach((req, i) => awaitCityPicks(run, req, inFlight[i]));
}

function awaitCityPicks(run: string, req: CityPicksRequest, inFlight?: Promise<CityPicks>) {
  (inFlight ?? requestCityPicks(req))
    .catch(() => NO_PICKS)
    .then((picks) => landCityPicks(run, req.city, picks));
}

/**
 * Set once the tab starts leaving this page (a reload, or typing another
 * address). The browser then kills every request still out, AFTER `pagehide`
 * (measured in Chromium: beforeunload, pagehide, unload, then the fetches
 * reject). Those are not failed requests: counted as failures, they took the
 * cities off the snapshot's waiting list just before the reload read it, and
 * the reloaded page never asked again.
 */
let pageLeaving = false;

/** One city's picks answered (or failed): it stops waiting, and the trip on screen gets them. */
function landCityPicks(run: string, cityName: string, picks: CityPicks) {
  const got = picks.activities.length > 0 || picks.restaurants.length > 0;
  // Killed by the page going away: still waiting, so the next page asks again.
  if (!got && pageLeaving) return;
  useTripStore.setState((state) => {
    const tp = state.tripPicks;
    if (!tp || tp.run !== run) return state; // a search since replaced, or planning reset
    const tripPicks: TripPicks = {
      run,
      pending: tp.pending.filter((r) => r.city !== cityName),
      landed: got ? { ...tp.landed, [cityName]: picks } : tp.landed,
    };
    const trip = state.currentTrip;
    // A failure leaves the city as it is: no lists, its transport-only
    // schedule — what the planner always produced when the AI call failed.
    if (!got || !trip || trip.picksRun !== run) return { tripPicks };
    return { tripPicks, currentTrip: withCityPicks(trip, cityName, picks) };
  });
}

/**
 * `trip` with one city's AI picks added: its activity and restaurant lists
 * (only where still empty — never over the traveller's own) and its schedule,
 * built by the same scheduler the planner used, around the transport as it
 * stands now. A day the traveller has already put something of their own on
 * keeps their version; a day holding only transport blocks (all a stay has
 * before its picks) or nothing takes the new one.
 */
function withCityPicks(trip: Trip, cityName: string, picks: CityPicks): Trip {
  const idx = trip.cities.findIndex((c) => c.name === cityName);
  if (idx < 0) return trip;
  const old = trip.cities[idx];
  const cities = [...trip.cities];
  const city: City = {
    ...old,
    activities: old.activities.length > 0 ? old.activities : picks.activities.map((s) => s.name),
    restaurants:
      old.restaurants.length > 0
        ? old.restaurants
        : picks.restaurants.map((r): Restaurant => ({ name: r.name, cuisine: r.cuisine, priceRange: r.priceRange })),
  };
  cities[idx] = city;
  const next: Trip = { ...trip, cities };
  const built = buildCityScheduleFromSuggestions(picks.activities, picks.restaurants, city, idx, next);
  const schedule = { ...(old.schedule ?? {}) };
  for (const [day, events] of Object.entries(built.schedule)) {
    const mine = schedule[day];
    if (!mine || mine.every((e) => e.category === 'transport')) schedule[day] = events;
  }
  cities[idx] = { ...city, schedule, unscheduled: built.unscheduled };
  return next;
}

/**
 * See `setTrip`: put landed picks back on a copy of the same trip that
 * predates them. Only where the trip on screen still has picks for that
 * city: one the traveller has emptied themselves stays empty.
 */
function keepLandedPicks(trip: Trip, tp: TripPicks | null, onScreen: Trip | null): Trip {
  if (!trip || !tp || !trip.picksRun || trip.picksRun !== tp.run) return trip;
  const hasPicks = (c?: City) => !!c && (c.activities.length > 0 || c.restaurants.length > 0);
  let next = trip;
  for (const c of trip.cities) {
    const landed = tp.landed[c.name];
    if (!landed || hasPicks(c)) continue;
    if (!hasPicks(onScreen?.cities.find((s) => s.name === c.name))) continue;
    next = withCityPicks(next, c.name, landed);
  }
  return next;
}

/**
 * True while `cityName`'s AI picks are still on their way to `trip` — the
 * flowchart shows its "Activities & Dining" card loading meanwhile.
 */
export function cityPicksLoading(tp: TripPicks | null, trip: Trip | null | undefined, cityName: string): boolean {
  return !!tp && !!trip && trip.picksRun === tp.run && tp.pending.some((r) => r.city === cityName);
}

/** True while the trip on screen still has AI picks on their way. */
function picksPending(): boolean {
  const { tripPicks, currentTrip } = useTripStore.getState();
  return !!tripPicks && tripPicks.pending.length > 0 && currentTrip?.picksRun === tripPicks.run;
}

/**
 * Resolves once the trip on screen has no AI picks left on their way — at
 * once (false) when it has none; true when it had to wait. Every request
 * settles, success or failure, so this always resolves.
 */
export function tripPicksSettled(): Promise<boolean> {
  if (!picksPending()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const unsubscribe = useTripStore.subscribe(() => {
      if (picksPending()) return;
      unsubscribe();
      resolve(true);
    });
  });
}

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
  /**
   * AI picks the trip was still waiting for. A reload kills their requests,
   * so the restore asks for them again rather than leave the cities without.
   * Absent once every city has answered (and in snapshots written before
   * this existed, which then restore exactly as they always did).
   */
  picks?: { run: string; pending: CityPicksRequest[] };
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

function writeSnapshot(trip: Trip | null, priceMode: 'total' | 'perPerson', tp: TripPicks | null) {
  const storage = tabStorage();
  if (!storage) return;
  try {
    if (!trip) {
      storage.removeItem(SESSION_KEY);
      return;
    }
    const snapshot: TripSnapshot = { v: SESSION_VERSION, trip, priceMode };
    if (tp && tp.pending.length > 0 && trip.picksRun === tp.run) {
      snapshot.picks = { run: tp.run, pending: tp.pending };
    }
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

  // The AI picks the trip was still waiting for when the tab reloaded. Their
  // requests died with the old page, so they are asked again — only for the
  // cities still without any — and land like the planner's own. Every request
  // settles, so nothing stays waiting; one that fails leaves its city as a
  // failure always has.
  const picks = snapshot?.picks;
  const pending =
    picks && typeof picks.run === 'string' && picks.run === trip.picksRun && Array.isArray(picks.pending)
      ? picks.pending.filter(
          (r) =>
            !!r &&
            typeof r.city === 'string' &&
            trip.cities.some((c) => c.name === r.city && c.activities.length === 0 && c.restaurants.length === 0),
        )
      : [];

  useTripStore.setState({
    currentTrip: trip,
    priceMode: snapshot?.priceMode === 'perPerson' ? 'perPerson' : 'total',
    restoredFromSession: true,
    tripPicks: pending.length > 0 ? { run: picks!.run, pending, landed: {} } : null,
  });
  for (const req of pending) awaitCityPicks(picks!.run, req);
  return true;
}

// Browser only: on the server this module is shared by every request.
if (typeof window !== 'undefined') {
  useTripStore.subscribe((state, prev) => {
    if (
      state.currentTrip === prev.currentTrip &&
      state.priceMode === prev.priceMode &&
      state.tripPicks === prev.tripPicks
    ) {
      return;
    }
    writeSnapshot(state.currentTrip, state.priceMode, state.tripPicks);
  });

  window.addEventListener('pagehide', () => {
    pageLeaving = true;
  });
  // Back on the page after all (restored from the back/forward cache): any
  // request the leaving killed was dropped above, so ask for those again.
  window.addEventListener('pageshow', (e) => {
    pageLeaving = false;
    const tp = useTripStore.getState().tripPicks;
    if (e.persisted && tp) for (const req of tp.pending) awaitCityPicks(tp.run, req);
  });
}
