import { create } from 'zustand';
import { Trip, PlanningAnswers, City, CustomHotel, Transport } from '@/lib/types';

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

  // Actions
  setAnswer: (key: keyof PlanningAnswers, value: unknown) => void;
  nextStep: () => void;
  prevStep: () => void;
  setStep: (step: number) => void;
  setLoading: (loading: boolean) => void;
  setTrip: (trip: Trip) => void;
  updateCity: (index: number, city: Partial<City>) => void;
  setSelectedHotel: (cityIndex: number, hotelIndex: number) => void;
  cycleHotel: (cityIndex: number, direction: 1 | -1) => void;
  setCustomHotel: (cityIndex: number, custom: CustomHotel) => void;
  clearCustomHotel: (cityIndex: number) => void;
  setTransportOut: (cityIndex: number, alternativeIndex: number) => void;
  addChatMessage: (role: 'user' | 'assistant', content: string) => void;
  resetPlanning: () => void;
};

export const useTripStore = create<TripStore>((set) => ({
  answers: {},
  currentStep: 0,
  isLoading: false,
  currentTrip: null,
  chatHistory: [],

  setAnswer: (key, value) =>
    set((state) => ({ answers: { ...state.answers, [key]: value } })),

  nextStep: () => set((state) => ({ currentStep: state.currentStep + 1 })),
  prevStep: () => set((state) => ({ currentStep: Math.max(0, state.currentStep - 1) })),
  setStep: (step) => set({ currentStep: step }),
  setLoading: (loading) => set({ isLoading: loading }),

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
