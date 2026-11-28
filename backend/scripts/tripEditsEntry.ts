// Entry for scripts/build-trip-edits.mjs: the website's own pure trip-edit
// functions, bundled so the backend applies a texted YES exactly as the
// results page applies an Accept. Do not add anything with side effects.
export { applyCityEdit } from '../../frontend/lib/cityEdit';
export { applyTransportChange, transportChangeApplies } from '../../frontend/lib/transportChange';
export { liveTripTotal } from '../../frontend/lib/tripTotals';
