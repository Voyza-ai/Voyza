export type TransportMode = 'flight' | 'train';

export type Transport = {
  mode: TransportMode;
  operator: string;
  duration: string;
  price: number;
  from?: string;
  to?: string;
  departTime?: string; // "09:15"
  arriveTime?: string; // "10:47"
  departDate?: string; // "2026-06-17"
  fromStation?: string; // "Roma Termini, Platform 12"
  toStation?: string; // "Firenze S.M.N., Platform 5"
  layovers?: number;
  baggage?: string; // "1 carry-on + 1 personal item"
  bookingUrl?: string;
  flightNumber?: string;
  trainNumber?: string;
};

export type Hotel = {
  name: string;
  rating: number;
  pricePerNight: number;
  area: string;
  /** 0..1 — how central / walkable the neighborhood is */
  locationScore?: number;
  /** computed score from hotelScore() — higher is better */
  score?: number;
  bookingUrl?: string;
  /** Taxes & fees per night (city tax, service, resort fee, etc.) */
  taxesPerNight?: number;
  /** True if Voyza can book this hotel directly as part of the upfront payment */
  bookable?: boolean;
};

/** A user-supplied hotel/Airbnb that overrides the ranked list selection. */
export type CustomHotel = {
  name: string;
  /** Either entered as per-night or as total — track which mode */
  mode: 'perNight' | 'total';
  /** Whichever mode is active, this field holds the entered number */
  amount: number;
  url?: string;
  area?: string;
};

export type Restaurant = {
  name: string;
  cuisine: string;
  priceRange: string;
  link?: string;
};

export type Activity = {
  name: string;
  description?: string;
  link?: string;
};

export type Vibe =
  | 'history'
  | 'art'
  | 'food'
  | 'beach'
  | 'nightlife'
  | 'nature'
  | 'city'
  | 'romance';

export type City = {
  name: string;
  country: string;
  dates: { arrival: string; departure: string };
  transportIn: Transport;
  transportOut: Transport;
  /**
   * @deprecated kept for backward compat — read from `hotels[selectedHotelIndex]`
   * (or `customHotel` if set) instead.
   */
  hotel: Hotel;
  /** 5 ranked hotel candidates, sorted descending by score */
  hotels: Hotel[];
  /** Index into `hotels` of the currently chosen hotel */
  selectedHotelIndex: number;
  /** When set, overrides `hotels[selectedHotelIndex]` — user typed in their own */
  customHotel?: CustomHotel;
  activities: string[];
  restaurants: Restaurant[];
  vibes?: Vibe[]; // primary vibes for this city — drives the accent gradient
};

export type Trip = {
  id?: string;
  title: string;
  status: 'planning' | 'confirmed' | 'completed';
  totalCost: number;
  savings: number;
  travelers: number;
  cities: City[];
  savingsTips: string[];
  createdAt?: string;
  ownerId?: string;
};

export type PlanningAnswers = {
  destinations?: string[];
  vibe?: string;
  dateRange?: { start: string; end: string };
  flexible?: boolean;
  travelers?: number;
  budget?: number;
  budgetPerPerson?: boolean;
  extraNotes?: string;
  rawInput?: string;
};

export type GroupMember = {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'member' | 'viewer';
  avatarUrl?: string;
};
