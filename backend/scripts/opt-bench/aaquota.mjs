#!/usr/bin/env node
// All Aboard's own quota counters for this key (getSalesAgent.rateLimits):
// one JSON line per resource. Reads nothing else from the account.
// Run with NODE_USE_ENV_PROXY=1 (the proxy injects the key).
import { randomUUID } from 'node:crypto';

const res = await fetch('https://test.api-gateway.allaboard.eu', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'api-key': 'placeholder', session: randomUUID() },
  body: JSON.stringify({ query: '{ getSalesAgent { rateLimits { resource unit limit remaining resetAt } } }' }),
});
const body = await res.json();
if (body.errors) {
  console.log(JSON.stringify({ at: new Date().toISOString(), errors: body.errors.map((e) => e.message) }));
} else {
  for (const r of body.data?.getSalesAgent?.rateLimits ?? []) {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
  }
}
