import { railDemandFromLegs, MIN_TRIPS } from '../services/railDemand';

jest.mock('../services/supabase', () => ({ getSupabase: () => ({}) }));

const legs = (trips: Array<string[]>) =>
  trips.flatMap((modes, i) => modes.map((mode) => ({ trip_id: `t${i}`, mode })));

describe('railDemandFromLegs', () => {
  it('counts a trip once, as "with train" if ANY of its legs is a train', () => {
    const rows = legs([
      ['flight', 'train'],
      ['train', 'train'],
      ['flight', 'flight'],
      ...Array.from({ length: 7 }, () => ['flight']),
    ]);
    const r = railDemandFromLegs(rows);
    expect(r.tripsWithLegs).toBe(10);
    expect(r.tripsWithTrain).toBe(2);
    expect(r.percent).toBe(20);
  });

  it('says nothing (null) below the minimum number of trips', () => {
    const r = railDemandFromLegs(legs([['train'], ['train']]));
    expect(r.tripsWithLegs).toBeLessThan(MIN_TRIPS);
    expect(r.percent).toBeNull();
  });

  it('ignores rows without a trip, and no data is not 0%', () => {
    expect(railDemandFromLegs([{ trip_id: '', mode: 'train' }]).tripsWithLegs).toBe(0);
    expect(railDemandFromLegs([]).percent).toBeNull();
  });
});
