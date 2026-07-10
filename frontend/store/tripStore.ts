import { create } from 'zustand';
import { Trip, PlanningAnswers, City, CustomHotel, Transport, Restaurant, ScheduledEvent } from '@/lib/types';

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
      const next = (c.selectedHotelIndex + direction + len) % len;
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
      return {
        currentTrip: {
          ...state.currentTrip,
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
