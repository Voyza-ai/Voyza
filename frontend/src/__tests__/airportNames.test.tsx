/**
 * Airport names in the browser, from the generated table.
 *
 * The bug: `lib/airportNames.ts` was a hand-written table of ~100 codes, and
 * the resolver returns any of 4,008. The home card showed "Portland Intl."
 * above PDX and a bare "PWM" above Portland, Maine — which is the card the
 * origin clarification banner re-points to when a traveller picks the other
 * reading of "Portland".
 *
 * So the cases here are, in order: a name OUTSIDE the old table resolves; a
 * name that does not exist degrades to the bare code; and the not-yet-loaded
 * state — which every first render passes through, because the table is a
 * deferred chunk — degrades the same way rather than rendering "undefined".
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';

import CanvasHomeCard from '@/components/canvas/CanvasHomeCard';
import {
  getAirportName,
  preloadAirportNames,
  resetAirportNamesForTests,
} from '@/lib/airportNames';

const MODULE_SOURCE = path.resolve(__dirname, '../../lib/airportNames.ts');
const FRONTEND_TABLE = path.resolve(__dirname, '../../lib/generated/airportNames.json');
const BACKEND_TABLE = path.resolve(
  __dirname,
  '../../../backend/src/data/generated/airportNames.json',
);

beforeEach(() => {
  resetAirportNamesForTests();
});

describe('a name outside the old hand-written table', () => {
  it('resolves PWM, which the ~100-entry table had no row for', async () => {
    await preloadAirportNames();
    // The case that started this. PDX was in the old table; PWM was not, and
    // the two are the two readings of "Portland".
    expect(getAirportName('PWM')).toBe('Portland Intl. Jetport');
    expect(getAirportName('PDX')).toBe('Portland Intl.');
  });

  it('resolves codes from well outside the old table, not just PWM', async () => {
    await preloadAirportNames();
    // A spread of the long tail: a US regional, a Greek island with scheduled
    // service (the pipeline's own trim-rule canary), an Alaskan field, and a
    // small European field. None of these was in the hand-written table.
    expect(getAirportName('PAS')).toBe('Paros National');
    expect(getAirportName('GEG')).toBe('Spokane Intl.');
    expect(getAirportName('DUT')).toBe('Tom Madsen');
    expect(getAirportName('NRN')).toBe('Weeze');
  });

  it('is case-insensitive, because codes come from stored trips too', async () => {
    await preloadAirportNames();
    expect(getAirportName('pwm')).toBe('Portland Intl. Jetport');
  });
});

describe('a missing name degrades to the bare code', () => {
  it('returns null for an unknown code, never a placeholder', async () => {
    await preloadAirportNames();
    expect(getAirportName('ZZZ')).toBeNull();
    expect(getAirportName('')).toBeNull();
    expect(getAirportName('not a code')).toBeNull();
  });

  it('returns null before the deferred chunk has landed', () => {
    // Not an edge case: this is the state of every first render. It must be
    // null rather than a throw or an "undefined" string.
    expect(getAirportName('PWM')).toBeNull();
    expect(getAirportName('PDX')).toBeNull();
  });

  it('renders the code and no name text while the chunk is still loading', async () => {
    render(
      <CanvasHomeCard
        origin={{ city: 'Portland', airports: ['PWM'] }}
        direction="outbound"
      />,
    );
    // The card's name slot falls back to the code, so the code is on screen
    // and the string "undefined" is not.
    expect(screen.getAllByText('PWM').length).toBeGreaterThan(0);
    expect(screen.queryByText(/undefined/i)).toBeNull();
    // Flush the chunk the mount kicked off, so the re-render it causes lands
    // inside this test rather than warning from the next one.
    await act(async () => {
      await preloadAirportNames();
    });
  });

  it('shows the code and no name text for a code the table does not know', async () => {
    render(
      <CanvasHomeCard
        origin={{ city: 'Nowhere', airports: ['ZZZ'] }}
        direction="outbound"
      />,
    );
    await act(async () => {
      await preloadAirportNames();
    });
    expect(getAirportName('PWM')).not.toBeNull();
    expect(screen.getAllByText('ZZZ').length).toBeGreaterThan(0);
    expect(screen.queryByText(/undefined/i)).toBeNull();
    expect(screen.queryByText(/null/i)).toBeNull();
  });
});

describe('the card shows the name once the chunk lands', () => {
  it('fills in PWM without the component asking for it', async () => {
    // The end-to-end shape of the fix: the component calls a hook, the hook
    // pulls the chunk, and the card re-renders with the name. The card does
    // not know the table is lazy.
    render(
      <CanvasHomeCard
        origin={{ city: 'Portland', airports: ['PWM'] }}
        direction="outbound"
      />,
    );
    expect(screen.queryByText('Portland Intl. Jetport')).toBeNull();
    await waitFor(() => {
      expect(screen.getByText('Portland Intl. Jetport')).toBeInTheDocument();
    });
    // The code stays on screen beside the name.
    expect(screen.getByText('PWM')).toBeInTheDocument();
  });
});

describe('nothing here is hand-maintained any more', () => {
  it('holds no airport names in its own source', () => {
    // The guard against this file drifting back into the table it replaced.
    // The old table's entries were object literals keyed by code; this one
    // has none, and no airport name appears in the module text at all.
    const source = fs.readFileSync(MODULE_SOURCE, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/John F\. Kennedy|LaGuardia|Heathrow|Schiphol/);
    expect(code).not.toMatch(/^\s*[A-Z]{3}:\s*\{/m);
  });

  it('reads a table that is byte-identical to the backend copy', () => {
    // One generated file, written to both packages by
    // `npm run build:location-hotset`. Mirrors the hot set's own parity test.
    expect(fs.readFileSync(FRONTEND_TABLE).equals(fs.readFileSync(BACKEND_TABLE))).toBe(true);
  });

  it('reads a table covering the whole scheduled-IATA set', () => {
    // Non-vacuity: a truncated or stubbed table would pass every lookup
    // assertion above that happens to name a code it kept.
    const table = JSON.parse(fs.readFileSync(FRONTEND_TABLE, 'utf8')) as {
      basis: string;
      names: Record<string, string>;
    };
    expect(table.basis).toBe('ourairports-name');
    expect(Object.keys(table.names).length).toBeGreaterThan(3_500);
  });
});
