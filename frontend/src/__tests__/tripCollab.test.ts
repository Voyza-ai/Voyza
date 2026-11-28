import { applyCollabState, collabSignature, rechainDates, tripToCollabState } from '@/lib/tripCollab';
import { buildCity, buildTrip } from './fixtures';

describe('rechainDates — stays re-dated after a reorder, add or remove', () => {
  const c = (name: string, arrival: string, departure: string) => ({ name, dates: { arrival, departure } });

  it('keeps the trip start and each stay\'s nights, whatever the order', () => {
    const out = rechainDates([c('Venice', '2026-06-20', '2026-06-22'), c('Rome', '2026-06-15', '2026-06-18')]);
    expect(out.map((x) => [x.name, x.dates.arrival, x.dates.departure])).toEqual([
      ['Venice', '2026-06-15', '2026-06-17'],
      ['Rome', '2026-06-17', '2026-06-20'],
    ]);
  });

  it('dates a just-added stay from its 2000-01-01 placeholder nights, never the year 2000', () => {
    const out = rechainDates([c('Rome', '2026-06-15', '2026-06-18'), c('Bologna', '2000-01-01', '2000-01-04')]);
    expect(out[1].dates).toEqual({ arrival: '2026-06-18', departure: '2026-06-21' });
  });

  it('crosses a month end', () => {
    const out = rechainDates([c('A', '2026-01-30', '2026-02-02'), c('B', '2000-01-01', '2000-01-03')]);
    expect(out[1].dates).toEqual({ arrival: '2026-02-02', departure: '2026-02-04' });
  });
});

describe('collaborators exchange the trip as { trip, cities }', () => {
  it('a received state changes the cities and the shared trip facts, nothing derived', () => {
    const cur = buildTrip({ id: 't1', title: 'Old', totalCost: 999, constraints: { pins: [] } as any });
    const next = applyCollabState(cur, {
      trip: { title: 'New', travelers: 4 },
      cities: [buildCity({ name: 'Berlin' })],
    });
    expect(next.cities.map((x) => x.name)).toEqual(['Berlin']);
    expect(next.title).toBe('New');
    expect(next.travelers).toBe(4);
    // Derived on this page, not sent: kept.
    expect(next.totalCost).toBe(999);
    // Not in the state: kept.
    expect(next.constraints).toEqual({ pins: [] });
  });

  it('constraints travel with the trip', () => {
    const t = buildTrip({ constraints: { pins: [{ city: 'Rome' }] } as any });
    const back = applyCollabState(buildTrip(), tripToCollabState(t));
    expect(back.constraints).toEqual({ pins: [{ city: 'Rome' }] });
  });

  it('normalises cities saved before hotels[] existed', () => {
    const legacy: any = { ...buildCity({ name: 'Rome' }), hotels: undefined, selectedHotelIndex: undefined };
    const next = applyCollabState(buildTrip(), { trip: {}, cities: [legacy] });
    expect(next.cities[0].hotels).toEqual([legacy.hotel]);
    expect(next.cities[0].selectedHotelIndex).toBe(0);
    expect(next.cities[0].colorIndex).toBe(0);
  });

  it('an empty state changes nothing', () => {
    const cur = buildTrip();
    expect(applyCollabState(cur, { trip: {}, cities: [] })).toBe(cur);
    expect(applyCollabState(cur, null)).toBe(cur);
  });

  it('the signature sees a city change and ignores derived totals', () => {
    const t = buildTrip();
    expect(collabSignature({ ...t, totalCost: 1 })).toBe(collabSignature(t));
    expect(collabSignature({ ...t, cities: t.cities.slice(1) })).not.toBe(collabSignature(t));
  });
});

describe('the saving box and date tip travel with the trip', () => {
  it('a rearrangement that dropped the saving clears it for everyone else', () => {
    const { tripToCollabState, applyCollabState } = require('@/lib/tripCollab');
    const { buildTrip } = require('./fixtures');
    const sender = { ...buildTrip(), savings: 0, dateShiftSuggestion: undefined };
    const receiver = { ...buildTrip(), savings: 485, dateShiftSuggestion: { savings: 40 } as any };
    const next = applyCollabState(receiver, tripToCollabState(sender));
    expect(next.savings).toBe(0);
    expect(next.dateShiftSuggestion).toBeUndefined();
  });
  it('a state without them (an old canvas session) leaves them alone', () => {
    const { applyCollabState } = require('@/lib/tripCollab');
    const { buildTrip } = require('./fixtures');
    const receiver = { ...buildTrip(), savings: 485 };
    const next = applyCollabState(receiver, { trip: {}, cities: receiver.cities });
    expect(next.savings).toBe(485);
  });
});

describe('what counts as an edit', () => {
  it('a re-derived stored total is not one, but it is carried', () => {
    const { tripToCollabState, collabSignature, applyCollabState } = require('@/lib/tripCollab');
    const { buildTrip } = require('./fixtures');
    const t = buildTrip();
    expect(collabSignature({ ...t, totalCost: 1234 })).toBe(collabSignature({ ...t, totalCost: 999 }));
    const next = applyCollabState({ ...t, totalCost: 5000 }, tripToCollabState({ ...t, totalCost: 3100 }));
    expect(next.totalCost).toBe(3100);
  });
});

describe('merging edits made at the same time', () => {
  const { computeCollabDelta, applyCollabDelta, staleLegIndices } = require('@/lib/tripCollab');
  const { buildTrip } = require('./fixtures');
  const six = () => {
    const t = buildTrip();
    const base = t.cities[0];
    const names = ['Bologna', 'Pisa', 'Milan', 'Venice', 'Florence', 'Rome'];
    const cities = names.map((name: string, i: number) => ({
      ...base,
      name,
      dates: { arrival: `2027-03-${String(10 + i * 2).padStart(2, '0')}`, departure: `2027-03-${String(12 + i * 2).padStart(2, '0')}` },
      transportOut: { ...base.transportOut, from: name, to: names[i + 1] ?? '', operator: 'X' },
    }));
    return { ...t, cities, title: names.join(' → ') };
  };
  // As the page's restructure leaves it: the auto title follows the stops.
  const without = (t: any, name: string) => {
    const cities = t.cities.filter((c: any) => c.name !== name);
    return { ...t, cities, title: cities.map((c: any) => c.name).join(' → ') };
  };
  const names = (t: any) => t.cities.map((c: any) => c.name);

  it('two removals at once both stick, on both screens (found live: Rome came back)', () => {
    const base = six();
    const owner = without(base, 'Rome'); // owner's screen after its edit
    const editor = without(base, 'Pisa'); // editor's screen after its edit
    const fromOwner = computeCollabDelta(base, owner);
    const fromEditor = computeCollabDelta(base, editor);
    const ownerSees = applyCollabDelta(owner, fromEditor);
    const editorSees = applyCollabDelta(editor, fromOwner);
    expect(names(ownerSees)).toEqual(['Bologna', 'Milan', 'Venice', 'Florence']);
    expect(names(editorSees)).toEqual(names(ownerSees));
    // Dates re-chain, the auto title follows.
    expect(ownerSees.cities[1].dates.arrival).toBe(ownerSees.cities[0].dates.departure);
    expect(ownerSees.title).toBe('Bologna → Milan → Venice → Florence');
  });

  it('an add and a remove at once both stick', () => {
    const base = six();
    const added = { ...base.cities[0], name: 'Verona' };
    const a = { ...base, cities: [...base.cities.slice(0, 3), added, ...base.cities.slice(3)] };
    const b = without(base, 'Bologna');
    const aSees = applyCollabDelta(a, computeCollabDelta(base, b));
    const bSees = applyCollabDelta(b, computeCollabDelta(base, a));
    expect(names(aSees)).toEqual(['Pisa', 'Milan', 'Verona', 'Venice', 'Florence', 'Rome']);
    expect(names(bSees)).toEqual(names(aSees));
  });

  it('a reorder and a removal at once both stick', () => {
    const base = six();
    const moved = { ...base, cities: [base.cities[5], ...base.cities.slice(0, 5)] }; // Rome to the front
    const removed = without(base, 'Venice');
    const x = applyCollabDelta(moved, computeCollabDelta(base, removed));
    const y = applyCollabDelta(removed, computeCollabDelta(base, moved));
    expect(names(x)).toEqual(['Rome', 'Bologna', 'Pisa', 'Milan', 'Florence']);
    expect(names(y)).toEqual(names(x));
  });

  it('a changed city comes through, and nothing else moves', () => {
    const base = six();
    const edited = { ...base, cities: base.cities.map((c: any) => (c.name === 'Milan' ? { ...c, activities: ['Duomo'] } : c)) };
    const d = computeCollabDelta(base, edited);
    expect(d.removed).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.order).toBeNull();
    expect(d.changed.map((c: any) => c.name)).toEqual(['Milan']);
    expect(applyCollabDelta(base, d).cities.find((c: any) => c.name === 'Milan').activities).toEqual(['Duomo']);
  });

  it('finds legs a merge left joining the wrong stops', () => {
    const t = without(six(), 'Pisa'); // Bologna's leg still goes to Pisa
    expect(staleLegIndices(t)).toEqual([0]);
  });
});
