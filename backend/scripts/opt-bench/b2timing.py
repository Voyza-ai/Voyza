"""How fast the ranking's NON_STOP rail searches answer, journeys and fares.

usage: python3 b2timing.py <run>.req.jsonl [--quick-live]

For each All Aboard getJourneys marked [NON_STOP] (or, with --quick-live,
every getJourneys served live — the quick ones in a top-up after A recorded
the full ones), prints when its timetable came back and when its last fare
did, relative to the search's start, and whether a priced fare made the 8 s
ranking cap.
"""
import json
import sys

rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
quick_live = '--quick-live' in sys.argv
gj = [r for r in rows if r['op'] == 'aa.getJourneys' and (('[NON_STOP]' in r.get('summary', '')) or (quick_live and r.get('served') == 'live'))]
offers = [r for r in rows if r['op'] == 'aa.getJourneyOffer']
CAP = 8000
inside = 0
for g in gj:
    start = g['t']
    # Fares asked right after this timetable answered (same instant, ±50 ms).
    mine = [o for o in offers if abs(o['t'] - g.get('done', g['t'])) <= 50]
    priced = [o for o in mine if (o.get('info') or {}).get('offers')]
    first_priced = min((o['done'] - start for o in priced), default=None)
    last = max((o['done'] - start for o in mine), default=None)
    ok = first_priced is not None and first_priced <= CAP
    inside += ok
    print(json.dumps({
        'search': g['summary'][:70],
        'journeysMs': g.get('done', start) - start,
        'statuses': (g.get('info') or {}).get('statuses'),
        'fares': len(mine),
        'firstPricedMs': first_priced,
        'lastFareMs': last,
        'pricedInside8s': ok,
    }))
print(json.dumps({'searches': len(gj), 'pricedInside8s': inside}))
