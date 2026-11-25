// One-off: does a NON_STOP-filtered cold All Aboard search answer faster than
// an unfiltered one? Paris -> Berlin, two days nobody searched today.
// Run with NODE_USE_ENV_PROXY=1 (the proxy injects the api key).
import { randomUUID } from 'node:crypto';

const URL = 'https://test.api-gateway.allaboard.eu';
const PARIS = '7N6Cj_NH';
const BERLIN = '4X7ZaxZO';

async function journeys(label, date, filter) {
  const query = `query($o: ID!, $d: ID!, $date: Date!) { getJourneys(origin: $o, destination: $d, date: $date${filter}) { id status itinerary { ... on SegmentCollection { status segments { departureAt arrivalAt operator { name } } } } } }`;
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40_000);
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/graphql-response+json', 'api-key': 'placeholder', session: randomUUID() },
      body: JSON.stringify({ query, variables: { o: PARIS, d: BERLIN, date } }),
      signal: ctl.signal,
    });
    const body = await res.json();
    const list = body?.data?.getJourneys ?? [];
    const statuses = new Set();
    let withSegs = 0;
    const direct = [];
    for (const j of list) {
      if (j.status) statuses.add(j.status);
      let segs = 0;
      for (const it of j.itinerary ?? []) {
        if (it.status) statuses.add(it.status);
        segs += (it.segments ?? []).length;
      }
      if (segs > 0) withSegs++;
      if (segs === 1) direct.push(j.id);
    }
    console.log(JSON.stringify({ label, date, ms: Date.now() - t0, http: res.status, journeys: list.length, withSegments: withSegs, singleSegment: direct.length, statuses: [...statuses], errors: body?.errors?.map((e) => e.message) }));
  } catch (err) {
    console.log(JSON.stringify({ label, date, ms: Date.now() - t0, error: String(err?.name ?? err) }));
  } finally {
    clearTimeout(timer);
  }
}

await Promise.all([
  journeys('unfiltered', '2027-01-20', ''),
  journeys('NON_STOP', '2027-01-21', ', filter: {types: [NON_STOP]}'),
]);
