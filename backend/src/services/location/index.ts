/**
 * Public surface of the location resolver.
 *
 * Phase 1 is dark: nothing in the running app imports this yet. Shadow mode
 * comes later, and the switch is a runtime flag rather than a deploy.
 */

export * from './types';
export { buildIndex, type BuiltIndex } from './buildIndex';
export { resolve, createResolver } from './resolve';
export { DEFAULT_OPTIONS, fuzzyDistanceFor, type ResolverOptions } from './options';
export { keysFor, keysForQuery, normalizeKeys, splitSegments, hasLatinForm } from './normalize';
export { buildTrigramIndex, boundedLevenshtein, type TrigramIndex } from './trigram';
export { prominenceOf } from './prominence';
export { haversineKm, centroidOf, type LatLon } from './geo';
