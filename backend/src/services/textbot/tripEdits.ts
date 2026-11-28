/**
 * Typed door onto the website's own trip-edit functions (bundled from
 * frontend/lib by scripts/build-trip-edits.mjs into src/generated/). The text
 * bot applies a YES with exactly what the results page runs on Accept:
 *   - applyCityEdit          city_edit proposals (add / remove / replace a city)
 *   - applyTransportChange   transport_change proposals (any leg, home ones too)
 *   - transportChangeApplies does the proposal still describe the trip?
 *   - liveTripTotal          the header total
 * Trips are the frontend `Trip` shape — what buildTripFromDb returns.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundle = require('../../generated/tripEditsBundle');

export const applyCityEdit: (trip: any, proposal: any) => any = bundle.applyCityEdit;
export const applyTransportChange: (trip: any, proposal: any) => any = bundle.applyTransportChange;
export const transportChangeApplies: (trip: any, proposal: any) => boolean = bundle.transportChangeApplies;
export const liveTripTotalFrontend: (trip: any) => number = bundle.liveTripTotal;
