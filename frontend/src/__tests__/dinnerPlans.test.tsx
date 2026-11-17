import './mocks';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import CityActivitiesCard from '@/components/results/CityActivitiesCard';
import { buildTrip } from './fixtures';
import { planChat } from '@/lib/api';
import type { CityEditProposal, DinnerProposal } from '@/lib/api';
import type { ScheduledEvent, Trip } from '@/lib/types';
import { applyDinnerProposal } from '@/lib/dinners';
import { syncCitySchedule, syncTripSchedules } from '@/lib/scheduleSync';
import { applyCityEdit } from '@/lib/cityEdit';
import { withCityGeo } from '@/store/tripStore';

/**
 * BlueMurr AI dinner plans (backend services/dinner.ts proposes them): the
 * card says "Not booked yet", Accept puts the dinner on its night's schedule
 * — where the Schedule, the Calendar and the city guide read it — and edits
 * elsewhere keep it on a night of its own city's stay.
 */

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;

const dinnerEvent = (over: Partial<ScheduledEvent> = {}): ScheduledEvent => ({
  id: 'dinner-1',
  title: 'Da Enzo',
  startTime: '19:30',
  endTime: '21:30',
  category: 'restaurant',
  notes: 'Italian · $$',
  dinner: {
    restaurant: 'Da Enzo',
    city: 'Rome',
    partySize: 2,
    cuisine: 'Italian',
    priceRange: '$$',
    status: 'not_booked',
    reserveUrl: 'https://www.google.com/maps/search/?api=1&query=Da%20Enzo%2C%20Rome',
    reserveVia: 'Google Maps',
  },
  ...over,
});

const add = (date = '2026-06-16', event = dinnerEvent()): DinnerProposal => ({
  kind: 'dinner', action: 'add', city: 'Rome', before: null, after: { date, event },
});

/** Rome Jun 15–18 → Florence Jun 18–20, with a planned day on Jun 16 (an evening walk and a planned dinner). */
function trip(): Trip {
  const t = buildTrip();
  t.cities[0].schedule = {
    '2026-06-15': [],
    '2026-06-16': [
      { id: 'a1', title: 'Colosseum', startTime: '10:00', endTime: '12:00', category: 'activity', plannedDurationMin: 120 },
      { id: 'a2', title: 'Trastevere walk', startTime: '19:00', endTime: '20:30', category: 'activity', plannedDurationMin: 90 },
      { id: 'r1', title: 'Roscioli (Roman)', startTime: '20:45', endTime: '22:15', category: 'restaurant', notes: '$$ · carbonara', plannedDurationMin: 90 },
    ],
    '2026-06-17': [],
  };
  return t;
}

const day = (t: Trip, city: number, d: string) => t.cities[city].schedule?.[d] ?? [];
const dinnersOf = (t: Trip) =>
  t.cities.flatMap((c) => Object.entries(c.schedule ?? {}).flatMap(([d, es]) => es.filter((e) => e.dinner).map((e) => ({ city: c.name, d, e }))));

describe('applyDinnerProposal', () => {
  it('puts the dinner on its night, in place of the planned dinner, and moves the activity it overlaps', () => {
    const next = applyDinnerProposal(trip(), add())!;
    const d16 = day(next, 0, '2026-06-16');
    expect(d16.find((e) => e.dinner)).toMatchObject({ id: 'dinner-1', startTime: '19:30', endTime: '21:30' });
    // The planned dinner is replaced; the evening walk moves, keeping its length, not lost.
    expect(d16.some((e) => e.title === 'Roscioli (Roman)')).toBe(false);
    const walk = d16.find((e) => e.title === 'Trastevere walk')!;
    expect(walk).toBeDefined();
    expect(walk.startTime >= '21:30' || walk.endTime <= '19:30').toBe(true);
    expect(d16.find((e) => e.title === 'Colosseum')).toMatchObject({ startTime: '10:00' });
  });

  it('lays out a stay nobody opened yet before adding the dinner to it', () => {
    const t = trip();
    delete t.cities[0].schedule;
    const next = applyDinnerProposal(t, add())!;
    expect(Object.keys(next.cities[0].schedule!).sort()).toEqual(['2026-06-15', '2026-06-16', '2026-06-17']);
    expect(dinnersOf(next)).toHaveLength(1);
  });

  it('change moves it (same id, one dinner); remove takes it off', () => {
    const added = applyDinnerProposal(trip(), add())!;
    const moved = applyDinnerProposal(added, {
      kind: 'dinner', action: 'change', city: 'Rome',
      before: { date: '2026-06-16', event: dinnerEvent() },
      after: { date: '2026-06-17', event: dinnerEvent({ startTime: '20:00', endTime: '22:00' }) },
    })!;
    expect(dinnersOf(moved).map((x) => [x.d, x.e.startTime])).toEqual([['2026-06-17', '20:00']]);
    const removed = applyDinnerProposal(moved, { kind: 'dinner', action: 'remove', city: 'Rome', before: { date: '2026-06-17', event: dinnerEvent() }, after: null })!;
    expect(dinnersOf(removed)).toEqual([]);
  });

  it('does not apply when the night is no longer in the stay, or the dinner is gone', () => {
    expect(applyDinnerProposal(trip(), add('2026-06-18'))).toBeNull();
    expect(applyDinnerProposal(trip(), { kind: 'dinner', action: 'remove', city: 'Rome', before: { date: '2026-06-16', event: dinnerEvent() }, after: null })).toBeNull();
  });
});

describe('edits elsewhere keep the dinner on a night of its own stay', () => {
  it('a stay shortened so its night is gone: the dinner moves to the nearest night, keeps its time, and says it moved', () => {
    const before = applyDinnerProposal(trip(), add('2026-06-17'))!;
    const after: Trip = { ...before, cities: before.cities.map((c, i) => (i === 0 ? { ...c, dates: { arrival: '2026-06-15', departure: '2026-06-17' } } : i === 1 ? { ...c, dates: { arrival: '2026-06-17', departure: '2026-06-20' } } : c)) };
    const synced = syncTripSchedules(before, after);
    const ds = dinnersOf(synced);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ city: 'Rome', d: '2026-06-16' });
    expect(ds[0].e.startTime).toBe('19:30');
    expect(ds[0].e.dinner!.movedFrom).toBe('2026-06-17');
    // Settles: a second pass changes nothing.
    expect(syncCitySchedule(synced, 0)).toBeNull();
  });

  it('a dinner on a night still in the stay does not move, and a plain sync leaves it alone', () => {
    const t = applyDinnerProposal(trip(), add())!;
    const out = syncCitySchedule(t, 0);
    const sched = out?.schedule ?? t.cities[0].schedule!;
    expect(sched['2026-06-16'].filter((e) => e.dinner)).toHaveLength(1);
    expect(sched['2026-06-16'].find((e) => e.dinner)!.dinner!.movedFrom).toBeUndefined();
  });

  it('removing its city drops the dinner — it is not carried into another city', () => {
    const t = applyDinnerProposal(trip(), add())!;
    const p: CityEditProposal = {
      kind: 'city_edit', toolName: 'remove_city', op: { kind: 'remove', city: 'Rome' },
      before: [{ name: 'Rome', arrival: '2026-06-15', departure: '2026-06-18' }, { name: 'Florence', arrival: '2026-06-18', departure: '2026-06-20' }],
      after: [{ name: 'Florence', arrival: '2026-06-15', departure: '2026-06-20', status: 'moved' }],
      removed: ['Rome'], legs: [], note: 'x',
    } as any;
    expect(dinnersOf(applyCityEdit(t, p))).toEqual([]);
  });

  it('picks gaining coordinates re-plan the day and keep the dinner on it', () => {
    const t = applyDinnerProposal(trip(), add('2026-06-15'))!;
    const picks = { activities: [{ name: 'Pantheon', category: 'landmark', timeOfDay: 'morning', durationHours: 1, reason: '' }], restaurants: [] } as any;
    const located = { activities: [{ ...picks.activities[0], lat: 41.9, lng: 12.47 }], restaurants: [] } as any;
    const next = withCityGeo(t, 'Rome', picks, located);
    expect(dinnersOf(next).map((x) => x.d)).toEqual(['2026-06-15']);
  });
});

describe('the chat card and the guide', () => {
  it('the card says "Not booked yet"; Accept applies it and offers Reserve; nothing changes before Accept', async () => {
    mockedPlanChat.mockResolvedValueOnce({ type: 'proposal', reply: "Here's dinner for 2 people at Da Enzo.", proposal: add() });
    const onTripUpdate = jest.fn();
    const t = trip();
    render(<AIChatPanel trip={t} onTripUpdate={onTripUpdate} getLatestTrip={() => t} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'Can you add a dinner reservation for one night in Rome' } });
    fireEvent.submit(input.closest('form')!);
    const card = await screen.findByTestId('dinner-card');
    expect(within(card).getByText('Add dinner')).toBeInTheDocument();
    expect(within(card).getByTestId('dinner-not-booked')).toHaveTextContent('Not booked yet');
    expect(within(card).getByTestId('dinner-when')).toHaveTextContent('Tue, Jun 16 · 7:30 PM · 2 people · Rome');
    expect(within(card).queryByTestId('dinner-reserve')).toBeNull();
    expect(onTripUpdate).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByText('Accept'));
    expect(onTripUpdate).toHaveBeenCalledTimes(1);
    expect(dinnersOf(onTripUpdate.mock.calls[0][0])).toHaveLength(1);
    expect(within(card).getByText('✓ On your schedule — not booked yet')).toBeInTheDocument();
    expect(within(card).getByTestId('dinner-reserve')).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=Da%20Enzo%2C%20Rome');
  });

  it('the city guide lists the dinner with its night, time, party, "Not booked yet" and Reserve', () => {
    const t = applyDinnerProposal(trip(), add())!;
    render(
      <CityActivitiesCard city={t.cities[0]} cityIndex={0} isActive={false} isDimmed={false} expanded={false} onHover={() => {}} onLeave={() => {}} onToggleExpand={() => {}} />,
    );
    const g = screen.getByTestId('guide-dinners');
    expect(g).toHaveTextContent('Da Enzo');
    expect(g).toHaveTextContent('Dinner · Tue, Jun 16 · 7:30 PM · 2 people');
    expect(g).toHaveTextContent('Not booked yet');
    expect(within(g).getByTestId('dinner-badge-reserve')).toHaveAttribute('href', expect.stringContaining('google.com/maps/search'));
  });
});
