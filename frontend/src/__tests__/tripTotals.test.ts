import { transportTotal, hotelsTotal, liveTripTotal } from '@/lib/tripTotals';
import { buildTrip } from './fixtures';
import type { Trip } from '@/lib/types';

describe('tripTotals', () => {
  describe('transportTotal', () => {
    it('sums transportOut across cities (legacy 2-city, no origin)', () => {
      const trip = buildTrip({
        cities: [
          { name: 'Rome', transportOut: { mode: 'flight', operator: 'Trenitalia', duration: '1h', price: 23 } } as any,
          { name: 'Florence', transportOut: { mode: 'flight', operator: '', duration: '', price: 0 } } as any,
        ] as any,
      });
      expect(transportTotal(trip)).toBe(23);
    });

    it('includes outbound + return home legs from trip.origin', () => {
      // This is the fix — home legs live on trip.origin, not on the
      // cities' transport fields. Without summing them in, single-city
      // vibe trips with origin reported $0 transport in the header.
      const trip: Trip = buildTrip({
        cities: [
          { name: 'Reykjavik', transportOut: { mode: 'flight', operator: '', duration: '', price: 0 } } as any,
        ] as any,
      });
      trip.origin = {
        city: 'New York',
        airports: ['JFK', 'LGA', 'EWR'],
        outboundLeg: {
          originAirport: 'JFK', destAirport: 'KEF', price: 340.94, currency: 'USD',
          durationMinutes: 360, operator: 'Icelandair', carrierCode: 'FI',
          departTime: '21:00', arriveTime: '06:30', departDate: '2026-05-24',
          stops: 0, bookingUrl: null,
        },
        returnLeg: {
          originAirport: 'KEF', destAirport: 'JFK', price: 337.42, currency: 'USD',
          durationMinutes: 380, operator: 'Icelandair', carrierCode: 'FI',
          departTime: '17:00', arriveTime: '20:00', departDate: '2026-05-31',
          stops: 0, bookingUrl: null,
        },
      };

      expect(transportTotal(trip)).toBeCloseTo(678.36, 2);
    });

    it('handles outbound-only (one-way) without crashing', () => {
      const trip: Trip = buildTrip({
        cities: [
          { name: 'Tokyo', transportOut: { mode: 'flight', operator: '', duration: '', price: 0 } } as any,
        ] as any,
      });
      trip.origin = {
        city: 'San Francisco',
        airports: ['SFO'],
        outboundLeg: {
          originAirport: 'SFO', destAirport: 'NRT', price: 626, currency: 'USD',
          durationMinutes: 660, operator: 'JAL', carrierCode: 'JL',
          departTime: '11:00', arriveTime: '15:00', departDate: '2026-06-15',
          stops: 0, bookingUrl: null,
        },
        returnLeg: null,
      };

      expect(transportTotal(trip)).toBe(626);
    });

    it('combines inter-city + home legs for multi-city + origin', () => {
      const trip: Trip = buildTrip({
        cities: [
          { name: 'Rome', transportOut: { mode: 'train', operator: 'Trenitalia', duration: '1h', price: 23 } } as any,
          { name: 'Florence', transportOut: { mode: 'flight', operator: '', duration: '', price: 0 } } as any,
        ] as any,
      });
      trip.origin = {
        city: 'New York',
        airports: ['JFK'],
        outboundLeg: {
          originAirport: 'JFK', destAirport: 'FCO', price: 480, currency: 'USD',
          durationMinutes: 540, operator: 'Delta', carrierCode: 'DL',
          departTime: '22:00', arriveTime: '13:00', departDate: '2026-06-01',
          stops: 0, bookingUrl: null,
        },
        returnLeg: {
          originAirport: 'FLR', destAirport: 'JFK', price: 520, currency: 'USD',
          durationMinutes: 600, operator: 'Delta', carrierCode: 'DL',
          departTime: '11:00', arriveTime: '16:00', departDate: '2026-06-08',
          stops: 0, bookingUrl: null,
        },
      };

      // 23 (Rome→Florence) + 480 (outbound) + 520 (return) = 1023
      expect(transportTotal(trip)).toBe(1023);
    });

    it('returns city-only total when origin is absent (pre-home-anchor trips)', () => {
      const trip = buildTrip({
        cities: [
          { name: 'Rome', transportOut: { mode: 'train', operator: 'Trenitalia', duration: '1h', price: 23 } } as any,
          { name: 'Florence', transportOut: { mode: 'flight', operator: '', duration: '', price: 0 } } as any,
        ] as any,
      });
      // origin intentionally not set — graceful degradation for old trips
      expect(transportTotal(trip)).toBe(23);
    });
  });

  describe('liveTripTotal', () => {
    it('combines hotels + transport (including home legs)', () => {
      const trip: Trip = buildTrip({
        cities: [
          {
            name: 'Reykjavik',
            dates: { arrival: '2026-05-24', departure: '2026-05-31' }, // 7 nights
            hotel: { name: 'X', rating: 4, pricePerNight: 100, area: '' },
            hotels: [{ name: 'X', rating: 4, pricePerNight: 100, area: '', maxGuests: 2 }],
            selectedHotelIndex: 0,
            transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
          } as any,
        ] as any,
        travelers: 2,
      });
      trip.origin = {
        city: 'New York',
        airports: ['JFK'],
        outboundLeg: {
          originAirport: 'JFK', destAirport: 'KEF', price: 340, currency: 'USD',
          durationMinutes: 360, operator: 'Icelandair', carrierCode: 'FI',
          departTime: '21:00', arriveTime: '06:30', departDate: '2026-05-24',
          stops: 0, bookingUrl: null,
        },
        returnLeg: {
          originAirport: 'KEF', destAirport: 'JFK', price: 337, currency: 'USD',
          durationMinutes: 380, operator: 'Icelandair', carrierCode: 'FI',
          departTime: '17:00', arriveTime: '20:00', departDate: '2026-05-31',
          stops: 0, bookingUrl: null,
        },
      };

      // hotel: 100/night × 7 nights × 1 room (2 guests, maxGuests 2) = 700
      // transport: 340 + 337 = 677
      // total: 1377
      expect(liveTripTotal(trip)).toBe(1377);
    });
  });
});
