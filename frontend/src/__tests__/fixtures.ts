import { Trip, City, Transport, Hotel } from '@/lib/types';

export const mockHotel: Hotel = {
  name: 'Hotel Roma Centro',
  rating: 4.5,
  pricePerNight: 95,
  area: 'Trastevere',
  bookingUrl: 'https://booking.example.com/roma-centro',
  bookable: true,
  taxesPerNight: 5,
  maxGuests: 2,
};

export const mockHotel2: Hotel = {
  name: 'Budget Inn Rome',
  rating: 3.8,
  pricePerNight: 60,
  area: 'Termini',
  bookingUrl: 'https://booking.example.com/budget-inn',
  bookable: false,
  taxesPerNight: 3,
};

export const mockTransportFlight: Transport = {
  mode: 'flight',
  operator: 'Ryanair',
  duration: '2h 15m',
  price: 89,
  from: 'Rome',
  to: 'Barcelona',
  departTime: '09:15',
  arriveTime: '11:30',
  departDate: '2026-06-20',
  fromStation: 'FCO Terminal 1',
  toStation: 'BCN Terminal 2',
  layovers: 0,
  baggage: '1 carry-on + 1 personal item',
  bookingUrl: 'https://ryanair.example.com/booking',
  flightNumber: 'FR1234',
  alternatives: [],
};

export const mockTransportTrain: Transport = {
  mode: 'train',
  operator: 'Trenitalia',
  duration: '1h 32m',
  price: 35,
  from: 'Rome',
  to: 'Florence',
  departTime: '08:00',
  arriveTime: '09:32',
  departDate: '2026-06-17',
  fromStation: 'Roma Termini, Platform 12',
  toStation: 'Firenze S.M.N., Platform 5',
  layovers: 0,
  bookingUrl: 'https://trenitalia.example.com/booking',
  trainNumber: 'FR9601',
  alternatives: [
    {
      mode: 'flight',
      operator: 'ITA Airways',
      duration: '1h 5m',
      price: 120,
      from: 'Rome',
      to: 'Florence',
      departTime: '10:00',
      arriveTime: '11:05',
    },
  ],
};

export function buildCity(overrides: Partial<City> = {}): City {
  return {
    name: 'Rome',
    country: 'Italy',
    dates: { arrival: '2026-06-15', departure: '2026-06-18' },
    transportIn: { mode: 'flight', operator: 'Arrival', duration: '3h', price: 0 },
    transportOut: mockTransportTrain,
    hotel: mockHotel,
    hotels: [mockHotel, mockHotel2],
    selectedHotelIndex: 0,
    activities: ['Colosseum', 'Vatican Museums'],
    restaurants: [
      { name: 'Da Enzo', cuisine: 'Italian', priceRange: '$$' },
    ],
    vibes: ['history', 'food'],
    ...overrides,
  };
}

export function buildTrip(overrides: Partial<Trip> = {}): Trip {
  const rome = buildCity();
  const florence = buildCity({
    name: 'Florence',
    country: 'Italy',
    dates: { arrival: '2026-06-18', departure: '2026-06-20' },
    transportIn: mockTransportTrain,
    transportOut: mockTransportFlight,
    hotels: [
      { name: 'Hotel Firenze', rating: 4.2, pricePerNight: 80, area: 'Centro' },
    ],
    selectedHotelIndex: 0,
    hotel: { name: 'Hotel Firenze', rating: 4.2, pricePerNight: 80, area: 'Centro' },
    activities: ['Uffizi Gallery'],
    restaurants: [],
    vibes: ['art'],
  });

  return {
    id: 'trip-test-123',
    title: 'Rome · Florence',
    status: 'planning',
    totalCost: 1200,
    savings: 249,
    travelers: 2,
    cities: [rome, florence],
    savingsTips: [
      'Rome→Florence by train saves $85 vs flying',
      'Mid-week flights are $45 cheaper',
    ],
    ...overrides,
  };
}
