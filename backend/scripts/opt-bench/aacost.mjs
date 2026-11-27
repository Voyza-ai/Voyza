#!/usr/bin/env node
// What one All Aboard getJourneys costs, read off getSalesAgent.rateLimits:
//   1. a cold route-day, unfiltered
//   2. the same request again (a repeat)
//   3. the same route-day with filter {types: [NON_STOP]}
//   4. a different cold route-day, NON_STOP only
// Paris -> Berlin, days nobody planned. Production shares the key, so a
// delta can include someone else's search; each step is read twice to spot it.
// Run with NODE_USE_ENV_PROXY=1 (the proxy injects the key).
import { randomUUID } from 'node:crypto';

const URL = 'https://test.api-gateway.allaboard.eu';
const PARIS = '7N6Cj_NH';
const BERLIN = '4X7ZaxZO';

async function gql(query, variables = {}) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/graphql-response+json', 'api-key': 'placeholder', session: randomUUID() },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function quota() {
  const body = await gql('{ getSalesAgent { rateLimits { resource unit remaining } } }');
  const out = {};
  for (const r of body.data.getSalesAgent.rateLimits) out[`${r.resource}/${r.unit}`] = r.remaining;
  return out;
}

async function journeys(date, filter) {
  const t0 = Date.now();
  const body = await gql(
    `query($o: ID!, $d: ID!, $date: Date!) { getJourneys(origin: $o, destination: $d, date: $date${filter}) { id status itinerary { ... on SegmentCollection { status segments { departureAt } } } } }`,
    { o: PARIS, d: BERLIN, date },
  );
  const list = body?.data?.getJourneys ?? [];
  const statuses = [...new Set(list.flatMap((j) => [j.status, ...(j.itinerary ?? []).map((i) => i.status)]).filter(Boolean))];
  return { ms: Date.now() - t0, journeys: list.length, statuses };
}

const steps = [
  ['cold unfiltered 2027-01-24', '2027-01-24', ''],
  ['repeat unfiltered 2027-01-24', '2027-01-24', ''],
  ['NON_STOP same day 2027-01-24', '2027-01-24', ', filter: {types: [NON_STOP]}'],
  ['NON_STOP cold 2027-01-25', '2027-01-25', ', filter: {types: [NON_STOP]}'],
];
let before = await quota();
console.log(JSON.stringify({ step: 'start', quota: before }));
for (const [label, date, filter] of steps) {
  const r = await journeys(date, filter);
  const after = await quota();
  const again = await quota();
  const delta = Object.fromEntries(Object.keys(after).map((k) => [k, before[k] - after[k]]));
  console.log(JSON.stringify({ step: label, ...r, delta, settled: JSON.stringify(after) === JSON.stringify(again) }));
  before = again;
}
