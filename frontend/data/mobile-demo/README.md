# /m/demo fixtures

`/m/demo` runs with no backend: `components/mobile/demoApi.ts` answers the
app's own `/api` calls from these files in the browser.

- `demoTrip.json` — the trip from a real mobile planner run against the dev
  backend ("Paris and London", from New York, 2 travellers, round trip):
  flights, alternatives, AI picks and the day schedule are as the backend
  returned them. That backend had no hotel-provider key, so the **hotel rows
  are illustrative sample data** (names of real hotels, sample prices).
- `demoChat.json` — the BlueMurr AI script. The "night" reply is the real
  `/api/plan/chat` proposal recorded in the same run (only its wording
  trimmed); anything else gets a fixed answer.

Dates are recorded as January 2027 and shifted at load so the trip always
starts about 30 days from today (`demoTrip()` in demoApi.ts).
