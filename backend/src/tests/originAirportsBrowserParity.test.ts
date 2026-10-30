/**
 * The airports the BROWSER sends equal the airports the SERVER would serve.
 *
 * This is the property the optimizer's comment assumed and nothing asserted.
 * `optimizer.ts` prices home legs from the request's `originAirports`
 * verbatim whenever it is non-empty, and the planner fills that field from
 * `frontend/lib/locationResolver.ts` — a second implementation reading the
 * hot set, not this package's `resolveOriginAirports`. So a fix made on the
 * server side alone never reaches pricing.
 *
 * That is exactly what happened with `Moscow`. Commit e9ca160 taught
 * `fromResolution` to prefer the city over the federal-city region that prints
 * the same label, and the server started answering SVO, DME, VKO. The browser
 * kept answering SVO, VKO, ZIA — the region's list — because the hot set
 * stores the resolver's raw candidate order and the browser took
 * `candidates[0]` off it. Verification had injected the server's answer into
 * the frontend store, so it passed while the real path never changed.
 *
 * So this compares the two implementations over EVERY key the browser can
 * answer, not a sample: the only reason it is safe for the browser to decide
 * what gets priced is that it decides the same thing the server would.
 *
 * Context is out of scope here on purpose. With a trip as context the browser
 * defers contested keys to the server, and the user-location rule is
 * cross-checked in `locationHotSet.test.ts`.
 */

import { locationArtifact } from '../data/locationArtifact';
import { buildIndex } from '../services/location/buildIndex';
import { resolveOriginAirports, setOriginIndex } from '../services/location/originAirports';
import hotSetJson from '../data/generated/locationHotSet.json';
import { retiredInputs } from '../data/retiredOriginAirports';

type HotSet = { exact: Record<string, { s: 'ok' | 'ask'; ids: string[] }> };
const set = hotSetJson as unknown as HotSet;

setOriginIndex(buildIndex(locationArtifact));

type BrowserAnswer =
  | { status: 'resolved'; place: { placeId: string } }
  | { status: 'ambiguous'; candidates: Array<{ placeId: string; label: string; kind: string }> }
  | { status: 'unknown' };

// Required lazily: it reads the hot set and pulls in the frontend package.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const browser = require('../../../frontend/lib/locationResolver') as {
  originAirportsForCity: (q: string) => string[];
  resolveLocally: (q: string) => BrowserAnswer | null;
};

describe('the browser prices from the same airports the server would', () => {
  it('agrees on the airports for every hot-set key', () => {
    const keys = Object.keys(set.exact);
    const mismatches: string[] = [];
    for (const key of keys) {
      const sent = browser.originAirportsForCity(key);
      const served = resolveOriginAirports(key).airports;
      if (sent.join(',') !== served.join(',')) {
        mismatches.push(`${key}: browser ${sent.join('/')} vs server ${served.join('/')}`);
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(mismatches).toHaveLength(0);
    // Non-vacuity: a hot set that shipped nothing would agree about nothing.
    expect(keys.length).toBeGreaterThan(4000);
  });

  it('asks the same question, in the same order, for every contested key', () => {
    // The candidate order is what a clarification renders and what a
    // non-asking caller takes `[0]` from, so it has to match too — not just
    // the airports of the lead.
    const mismatches: string[] = [];
    let asked = 0;
    for (const [key, entry] of Object.entries(set.exact)) {
      if (entry.s !== 'ask') continue;
      asked++;
      const answer = browser.resolveLocally(key);
      const mine = answer?.status === 'ambiguous' ? answer.candidates.map((c) => c.placeId) : [];
      const server = resolveOriginAirports(key).needsClarification?.candidates.map((c) => c.placeId) ?? [];
      if (mine.join(',') !== server.join(',')) {
        mismatches.push(`${key}: ${mine.join(',')} vs ${server.join(',')}`);
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(mismatches).toHaveLength(0);
    expect(asked).toBeGreaterThan(50);
  });

  it('agrees on every input the retired hand-written table answered', () => {
    // Typed forms rather than normalised keys: `Newark, NJ`, `Brooklyn, New
    // York, USA`. These are the one independent record of what travellers
    // type into an origin field.
    const mismatches: string[] = [];
    for (const input of retiredInputs()) {
      const sent = browser.originAirportsForCity(input);
      if (sent.length === 0) continue; // a deferral is always allowed
      const served = resolveOriginAirports(input).airports;
      if (sent.join(',') !== served.join(',')) mismatches.push(`${input}: ${sent} vs ${served}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe('the cases that motivated it', () => {
  it('Moscow: both sides price Sheremetyevo, Domodedovo, Vnukovo', () => {
    expect(resolveOriginAirports('Moscow').airports).toEqual(['SVO', 'DME', 'VKO']);
    expect(browser.originAirportsForCity('Moscow')).toEqual(['SVO', 'DME', 'VKO']);
  });

  it('Moscow, Idaho: both sides lead with Pullman, 9 km away', () => {
    expect(resolveOriginAirports('Moscow, Idaho').airports[0]).toBe('PUW');
    expect(browser.originAirportsForCity('Moscow, Idaho')[0]).toBe('PUW');
  });

  it.each([
    ['Portland', 'PDX'],
    ['London', 'LHR'],
  ])('%s: both sides lead with %s', (query, lead) => {
    expect(resolveOriginAirports(query).airports[0]).toBe(lead);
    expect(browser.originAirportsForCity(query)[0]).toBe(lead);
  });
});
