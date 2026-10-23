import { useTripStore } from '@/store/tripStore';
import type { Hotel } from '@/lib/types';

/**
 * The price guards protected the AUTO-selection and nothing else.
 *
 * Measured on this store with the production Florence set: the flagged
 * $5383.47/night row sat last in the list, and ONE backward click from a $600
 * trip selected it and took the total to $16,150. "A flagged row can never
 * reach the trip total" was false the moment a user touched the next/previous
 * control.
 */
const hotel = (name: string, pricePerNight: number, priceSuspect = false): Hotel => ({
  name,
  rating: 8.5,
  pricePerNight,
  area: '',
  priceSuspect,
});

const seed = (hotels: Hotel[], selectedHotelIndex = 0) => {
  useTripStore.setState({
    currentTrip: {
      id: 't1',
      cities: [
        {
          name: 'Florence',
          country: 'Italy',
          nights: 3,
          hotels,
          selectedHotelIndex,
          hotel: hotels[selectedHotelIndex],
          dates: { arrival: '2027-04-10', departure: '2027-04-13' },
        },
      ],
      totalCost: 0,
    } as any,
  });
};

const selected = () => {
  const c = useTripStore.getState().currentTrip!.cities[0];
  return { index: c.selectedHotelIndex, name: c.hotels[c.selectedHotelIndex].name };
};

const florence = [
  hotel('Hotel Arno', 200),
  hotel('Hotel Medici', 210),
  hotel('Hotel Cosimo', 220),
  hotel('Radisson Blu', 170.31),
  hotel('Hotel Aldobrandini', 5383.47, true),
];

describe('cycleHotel steps over rows the backend does not trust', () => {
  it('does not land on the flagged row going backward — the measured $16,150 click', () => {
    seed(florence, 0);

    useTripStore.getState().cycleHotel(0, -1);

    expect(selected().name).not.toBe('Hotel Aldobrandini');
    expect(selected().name).toBe('Radisson Blu');
  });

  it('does not land on the flagged row going forward either', () => {
    // From index 3, forward would be index 4, the flagged row.
    seed(florence, 3);

    useTripStore.getState().cycleHotel(0, 1);

    expect(selected().name).toBe('Hotel Arno');
  });

  it('still reaches every trusted row in order', () => {
    seed(florence, 0);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      useTripStore.getState().cycleHotel(0, 1);
      seen.push(selected().name);
    }

    // Four trusted rows, cycled back to the start, flagged one never offered.
    expect(seen).toEqual(['Hotel Medici', 'Hotel Cosimo', 'Radisson Blu', 'Hotel Arno']);
  });

  it('steps over a run of several flagged rows', () => {
    seed(
      [
        hotel('Good', 200),
        hotel('Bad 1', 5000, true),
        hotel('Bad 2', 6000, true),
        hotel('Bad 3', 7000, true),
        hotel('Also good', 250),
      ],
      0,
    );

    useTripStore.getState().cycleHotel(0, 1);

    expect(selected().name).toBe('Also good');
  });

  it('falls back to plain cycling when every row is flagged', () => {
    // Nothing better to land on, so refusing to move would just look broken.
    seed([hotel('A', 5000, true), hotel('B', 6000, true)], 0);

    useTripStore.getState().cycleHotel(0, 1);

    expect(selected().index).toBe(1);
  });

  it('leaves a single trusted row where it is', () => {
    seed([hotel('Only', 200)], 0);

    useTripStore.getState().cycleHotel(0, 1);

    expect(selected().name).toBe('Only');
  });

  it('treats priceSuspect: false and absent alike', () => {
    seed([hotel('A', 200), { ...hotel('B', 210), priceSuspect: undefined } as Hotel], 0);

    useTripStore.getState().cycleHotel(0, 1);

    expect(selected().name).toBe('B');
  });

  it('still lets an explicit pick reach a flagged row', () => {
    // Flagging demotes and warns; it must not make real inventory unbookable.
    // A deliberate selection is the user's call, cycling past it is ours.
    seed(florence, 0);

    useTripStore.getState().setSelectedHotel(0, 4);

    expect(selected().name).toBe('Hotel Aldobrandini');
  });
});
