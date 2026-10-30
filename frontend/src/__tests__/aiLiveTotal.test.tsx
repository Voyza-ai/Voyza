/**
 * F5 — the AI is told the trip's LIVE total, not a stale stored one.
 *
 * Integrated run, 2026-10-30 (s5): a saved Browse preset (Paris Long Weekend,
 * 4 travellers) showed $2,693 in the header — live hotels plus the home
 * flights found at save — while its stored `totalCost` was the preset's
 * $1,344 quote. The chat and chat-suggestions requests sent `totalCost:
 * 1344`, and asked "how much is this trip?", the AI said $1,344.
 *
 * Real AIChatPanel and real lib/api; only `fetch` is stubbed, so this reads
 * the request bodies the backend actually receives.
 */
jest.mock('@/lib/supabase', () => ({
  getAuthHeader: jest.fn(async () => ({})),
  refreshAuthHeader: jest.fn(async () => null),
}));

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import { useTripStore } from '@/store/tripStore';
import { liveTripTotal } from '@/lib/tripTotals';
import type { HomeLeg, Trip } from '@/lib/types';
import { buildCity, buildTrip } from './fixtures';

const leg = (price: number): HomeLeg => ({
  originAirport: 'JFK',
  destAirport: 'PAR',
  price,
  currency: 'USD',
  durationMinutes: 645,
  operator: 'Icelandair',
  carrierCode: 'FI',
  departTime: '19:25',
  arriveTime: '12:10',
  departDate: '2026-11-29',
  arriveDate: '2026-11-30',
  stops: 1,
  bookingUrl: null,
});

/** The saved preset: one Paris stay at $303.35/night, home flights $891.60 each way. */
function savedPreset(): Trip {
  const hotel = { name: 'Mama Shelter Paris East', rating: 8.4, pricePerNight: 303.35, area: '' };
  return buildTrip({
    id: 'saved-preset-1',
    title: 'Paris Long Weekend',
    totalCost: 1344, // the preset's quote, stored at save
    savings: 0,
    travelers: 4,
    cities: [
      buildCity({
        name: 'Paris',
        country: 'France',
        dates: { arrival: '2026-11-30', departure: '2026-12-02' },
        hotel,
        hotels: [hotel],
        selectedHotelIndex: 0,
        transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
      }),
    ],
    origin: { city: 'New York', airports: ['JFK'], outboundLeg: leg(891.6), returnLeg: leg(891.6) },
  });
}

const bodies: Record<string, any[]> = {};
beforeEach(() => {
  for (const k of Object.keys(bodies)) delete bodies[k];
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    const path = new URL(url).pathname;
    (bodies[path] ??= []).push(JSON.parse(init.body));
    const json =
      path === '/api/plan/chat-suggestions'
        ? { suggestions: ['How much is this trip?'] }
        : { type: 'answer', reply: 'ok' };
    return { ok: true, status: 200, json: async () => json };
  });
  useTripStore.setState({ currentTrip: savedPreset(), restoredFromSession: false } as any);
  Element.prototype.scrollIntoView = jest.fn();
});

describe('AIChatPanel — the total the AI is told', () => {
  it('sends the live total, the header’s number, with chat-suggestions and chat', async () => {
    const trip = savedPreset();
    const live = liveTripTotal(trip);
    expect(live).toBe(2390); // 2 × 303.35 + 2 × 891.60, as the header shows it

    render(<AIChatPanel trip={trip} />);
    await waitFor(() => expect(bodies['/api/plan/chat-suggestions']?.length).toBeGreaterThan(0));
    // Before: 1344.
    expect(bodies['/api/plan/chat-suggestions'][0].currentTrip.totalCost).toBe(live);

    const box = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(box, { target: { value: 'how much is this trip in total?' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(bodies['/api/plan/chat']?.length).toBe(1));
    expect(bodies['/api/plan/chat'][0].currentTrip.totalCost).toBe(live);
    // Only the total changes; the rest of the trip goes as it was.
    expect(bodies['/api/plan/chat'][0].currentTrip.cities[0].dates).toEqual(trip.cities[0].dates);
  });

  it('a fresh planner trip, whose stored total is already live, sends the same number', async () => {
    const fresh = { ...savedPreset(), totalCost: 2390 };
    render(<AIChatPanel trip={fresh} />);
    await waitFor(() => expect(bodies['/api/plan/chat-suggestions']?.length).toBeGreaterThan(0));
    expect(bodies['/api/plan/chat-suggestions'][0].currentTrip.totalCost).toBe(2390);
  });
});
