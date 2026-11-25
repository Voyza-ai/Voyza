"""Per-run numbers for the A/B report: timings, provider calls, answer.

usage: python3 analyze.py <runs dir> [name-glob ...]
Prints one JSON line per run (and a table with --table).
"""
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from summ import legmode  # noqa: E402

UNITS_PER_ROUTE_DAY = 11


def load_reqs(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    uid_name = {}
    for r in rows:
        if r['op'] == 'aa.getLocations' and r.get('info'):
            for item in r['info'].get('locations', []):
                name, _, uid = item.rpartition('=')
                uid_name.setdefault(uid, name)
    return rows, uid_name


def server_timing(path):
    if not os.path.exists(path):
        return None
    for line in open(path):
        if '"Optimize timing"' in line:
            try:
                return json.loads(line[line.index('{'):])
            except Exception:
                return None
    return None


def answer(resp):
    if not resp or 'bestRoute' not in resp:
        return None
    br = resp['bestRoute']
    return {
        'order': ' > '.join(br['ordering']),
        'total': round(br['totalCost'], 2),
        'legs': [f"{l['from']}-{l['to']}:{legmode(l)}" for l in br['legs']],
        'outbound': f"{(resp.get('outboundLeg') or {}).get('originAirport')} {(resp.get('outboundLeg') or {}).get('price')}",
        'return': f"{(resp.get('returnLeg') or {}).get('destAirport')} {(resp.get('returnLeg') or {}).get('price')}",
        'savingsVsNaive': resp.get('savingsVsNaive'),
        'dateShift': (resp.get('dateShiftSuggestion') or {}).get('savings'),
        'dateShiftChecked': resp.get('dateShiftChecked'),
    }


def analyze(result_path):
    r = json.load(open(result_path))
    base = result_path[: -len('.result.json')]
    rows, uid_name = load_reqs(base + '.req.jsonl')
    timing = server_timing(base + '.server.log')
    t_post = None
    # The request log's clock is the server process's; align on the first
    # provider request of the run (both start within a few ms of the POST).
    prov = [x for x in rows if x['op'] not in ('supabase',)]
    t0 = min((x['t'] for x in prov), default=0)

    duffel = [x for x in rows if x['op'] == 'duffel.offer_request']
    duffel_ok = [x for x in duffel if x.get('served') != 'sim429' and x.get('status') not in (429,)]
    sim429 = sum(1 for x in duffel if x.get('served') == 'sim429' or x.get('status') == 429)
    sugg = [x for x in rows if x['op'] == 'duffel.suggestions']
    gj = [x for x in rows if x['op'] == 'aa.getJourneys']
    route_days = []
    for x in gj:
        m = re.search(r'\{.*\}', x['summary'])
        v = json.loads(m.group(0)) if m else {}
        route_days.append((uid_name.get(v.get('o'), v.get('o')), uid_name.get(v.get('d'), v.get('d')), v.get('date')))
    distinct_rd = sorted(set(route_days))
    offers = [x for x in rows if x['op'] == 'aa.getJourneyOffer']
    misses = [x for x in rows if x.get('served') == 'MISS']
    live = [x for x in rows if x.get('served') == 'live']
    # Rail searches that came back with no usable timetable (ERROR/UNKNOWN, no segments).
    gj_empty = sum(1 for x in gj if (x.get('info') or {}).get('withSegments', 1) == 0)
    gj_aborted = sum(1 for x in gj if x.get('error') == 'AbortError')

    resp = r.get('response')
    final = r.get('final') or (resp if not (resp or {}).get('finalPending') else None)
    out = {
        'name': r['name'],
        'trip': r['trip'],
        'version': r['version'] + (('-' + r['variant']) if r.get('variant') else '') + (('-s' + r['slots']) if r.get('slots') else '') + (('-b' + r['budget']) if r.get('budget') else ''),
        'twoPhase': r.get('twoPhase'),
        'phase': r.get('duffelPhase'),
        'status': r['status'],
        'responseMs': r['responseMs'],
        'finalMs': r['finalMs'] if r.get('finalMs') else r['responseMs'],
        'rankingMs': (timing or {}).get('rankingMs') if timing else r['stages'].get('finishing'),
        'rankingMsPoll': r['stages'].get('finishing'),
        'rail': (timing or {}).get('rail'),
        'duffelSearches': len({x['summary'] for x in duffel_ok}),
        'duffelRequests': len(duffel),
        'duffel429': sim429,
        'suggestions': len(sugg),
        'aaJourneySearches': len(gj),
        'aaRouteDays': len(distinct_rd),
        'aaUnitsEst': UNITS_PER_ROUTE_DAY * len(distinct_rd),
        'aaNoTimetable': gj_empty,
        'aaAborted': gj_aborted,
        'aaOfferRequests': len(offers),
        'routeDays': [' '.join(map(str, rd)) for rd in distinct_rd],
        'misses': len(misses),
        'live': len(live),
        'first': answer(resp) if (resp or {}).get('finalPending') else None,
        'final': answer(final),
    }
    return out


if __name__ == '__main__':
    runs = sys.argv[1]
    pats = [a for a in sys.argv[2:] if not a.startswith('--')] or ['*']
    files = sorted({f for p in pats for f in glob.glob(os.path.join(runs, p + '.result.json'))})
    for f in files:
        try:
            print(json.dumps(analyze(f)))
        except Exception as e:  # noqa: BLE001
            print(json.dumps({'file': f, 'error': str(e)}))
