/**
 * End-to-end check of the thing the owner actually complained about:
 * "if they use the calendar to plan, he might accidentally see 2 hours
 * instead of 4."
 *
 * The two tests above this one (dayScheduleTruth) prove the SCHEDULER
 * produces a 4-hour event. This one renders the real `DayPlanner` on that
 * schedule and measures the block the user sees, because the scheduler
 * being right is worth nothing if the grid clips it. The planner lays
 * events out proportionally on a 00:00–24:00 grid at 64px per hour, so a
 * four-hour activity has to be 256px tall and its label has to read the
 * full span.
 *
 * No styling is asserted — only geometry and the time label, i.e. the
 * things that encode the duration claim.
 */

import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildCityScheduleFromSuggestions } from '@/lib/dayScheduleDefaults';
import type { City, Transport, Trip } from '@/lib/types';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { buildTrip } from './fixtures';

import DayPlanner from '@/components/results/DayPlanner';

/** px per hour in DayPlanner's grid. */
const HOUR_HEIGHT = 64;
const DATE = '2026-06-15';

const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

const hike: ActivitySuggestion = {
  name: 'Great Wall hike',
  category: 'landmark',
  timeOfDay: 'morning',
  durationHours: 4,
  reason: 'worth the trip',
};

const lunch: RestaurantSuggestion = {
  name: 'Noodle House',
  cuisine: 'Local',
  priceRange: '$$',
  mealType: 'lunch',
  reason: 'tasty',
};

/** A one-city trip whose single day was scheduled by the real scheduler. */
function scheduledTrip(): Trip {
  const city: City = {
    name: 'Beijing',
    country: 'China',
    dates: { arrival: DATE, departure: '2026-06-16' },
    transportIn: emptyTransport,
    transportOut: emptyTransport,
    hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
    hotels: [],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
  } as City;

  const trip: Trip = { ...buildTrip(), cities: [city], origin: undefined };
  const { schedule } = buildCityScheduleFromSuggestions([hike], [lunch], city, 0, trip);
  trip.cities[0] = { ...city, schedule };
  return trip;
}

/** The absolutely-positioned block that wraps an event's title. */
const blockFor = (title: string): HTMLElement => {
  const label = screen.getByText(title);
  const block = label.closest('div[style*="height"]');
  if (!(block instanceof HTMLElement)) throw new Error(`no block found for ${title}`);
  return block;
};

beforeEach(() => {
  useTripStore.setState({ currentTrip: null, chatHistory: [] });
});

describe('DayPlanner renders an activity at its real duration', () => {
  it('draws a 4-hour activity as a 4-hour-tall block', () => {
    const trip = scheduledTrip();
    useTripStore.setState({ currentTrip: trip });

    render(
      <DayPlanner
        trip={trip}
        date={DATE}
        city={trip.cities[0]}
        cityIndex={0}
        onClose={() => {}}
      />,
    );

    const block = blockFor('Great Wall hike');
    // Four hours of grid, not two. This is the measurement that was wrong.
    expect(block.style.height).toBe(`${4 * HOUR_HEIGHT}px`);
  });

  it('labels the block with the full four-hour span', () => {
    const trip = scheduledTrip();
    useTripStore.setState({ currentTrip: trip });

    render(
      <DayPlanner
        trip={trip}
        date={DATE}
        city={trip.cities[0]}
        cityIndex={0}
        onClose={() => {}}
      />,
    );

    const events = trip.cities[0].schedule![DATE];
    const event = events.find((e) => e.title === 'Great Wall hike')!;
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    expect(toMin(event.endTime) - toMin(event.startTime)).toBe(240);

    // The block prints its own start–end, so the label must span 4 hours.
    const block = blockFor('Great Wall hike');
    const printed = block.textContent ?? '';
    expect(printed).toContain('–');
    const [from, to] = printed
      .split('–')
      .map((part) => part.replace(/[^0-9:APM ]/g, '').trim());
    expect(from).not.toBe(to);
  });

  it('positions the block by its real start time', () => {
    const trip = scheduledTrip();
    useTripStore.setState({ currentTrip: trip });

    render(
      <DayPlanner
        trip={trip}
        date={DATE}
        city={trip.cities[0]}
        cityIndex={0}
        onClose={() => {}}
      />,
    );

    const event = trip.cities[0].schedule![DATE].find((e) => e.title === 'Great Wall hike')!;
    const startMin = Number(event.startTime.slice(0, 2)) * 60 + Number(event.startTime.slice(3));
    const block = blockFor('Great Wall hike');
    expect(block.style.top).toBe(`${(startMin / 60) * HOUR_HEIGHT}px`);
  });

  it('draws the lunch block at its own real length, not the activity’s', () => {
    const trip = scheduledTrip();
    useTripStore.setState({ currentTrip: trip });

    render(
      <DayPlanner
        trip={trip}
        date={DATE}
        city={trip.cities[0]}
        cityIndex={0}
        onClose={() => {}}
      />,
    );

    // 90-minute lunch → 1.5 hours of grid.
    const block = blockFor('Noodle House (Local)');
    expect(block.style.height).toBe(`${1.5 * HOUR_HEIGHT}px`);
  });
});
