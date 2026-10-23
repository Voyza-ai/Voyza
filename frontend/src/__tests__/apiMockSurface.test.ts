/**
 * A `jest.mock` factory with an explicit export list silently yields
 * `undefined` for anything it omits. That produced two real defects in this
 * repo, both of which passed a green suite:
 *
 *  - `hotelFromResult` was added to `@/lib/api` and not to the mock, so hotel
 *    enrichment threw inside its promise and a city silently kept its old
 *    hotel. (Fixed by moving the pure mapping to lib/hotelShape.ts.)
 *  - `updateTrip` and six others were live in app code and absent here. The
 *    sharp case was `ResultsHeader.handleRename`, which calls `updateTrip`
 *    inside a try/catch that rolls back and toasts on failure: under the mock
 *    the TypeError was indistinguishable from a 500, so a test asserting the
 *    "Could not rename this trip" toast passed, and would have kept passing if
 *    `updateTrip` had been deleted from the codebase entirely.
 *
 * This is the guard. It compares the mock's surface against the real module's
 * runtime exports, so the next omission fails here instead of hiding a bug.
 */
import './mocks';

const mocked = jest.requireMock('@/lib/api') as Record<string, unknown>;
const actual = jest.requireActual('@/lib/api') as Record<string, unknown>;

describe('the @/lib/api mock covers the real module', () => {
  it('mocks every runtime export', () => {
    const missing = Object.keys(actual).filter((k) => !(k in mocked));

    expect(missing).toEqual([]);
  });

  it('mocks nothing that no longer exists', () => {
    // A stale entry is harmless at runtime but means the mock is describing a
    // module that has moved on, which is how the first drift went unnoticed.
    const stale = Object.keys(mocked).filter((k) => !(k in actual));

    expect(stale).toEqual([]);
  });

  it('leaves no mocked export undefined', () => {
    const undefinedKeys = Object.keys(mocked).filter((k) => mocked[k] === undefined);

    expect(undefinedKeys).toEqual([]);
  });
});
