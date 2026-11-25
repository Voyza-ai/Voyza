"""Aggregate replay runs into the A/B table (medians over Duffel window phases).

usage: python3 table.py <replays dir> [trip ...]
"""
import glob
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(__file__))
from analyze import analyze  # noqa: E402


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def rng(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    m = med(xs) / 1000
    return f"{m:.1f}s" + (f" ({min(xs)/1000:.1f}-{max(xs)/1000:.1f})" if max(xs) - min(xs) > 300 else '')


def main():
    d = sys.argv[1]
    trips = sys.argv[2:] or ['T1', 'T2', 'T3', 'T4']
    rows = []
    for f in sorted(glob.glob(os.path.join(d, '*.result.json'))):
        a = analyze(f)
        if a['trip'] in trips:
            rows.append(a)
    groups = {}
    for a in rows:
        key = (a['trip'], a['version'] + ('-2p' if a['twoPhase'] else ''))
        groups.setdefault(key, []).append(a)
    out = []
    for (trip, ver), runs in sorted(groups.items()):
        two = ver.endswith('-2p')
        answers = {json.dumps(r['final'], sort_keys=True) for r in runs}
        firsts = {json.dumps(r['first'], sort_keys=True) for r in runs if r['first']}
        rec = {
            'trip': trip,
            'version': ver,
            'runs': len(runs),
            'phases': sorted(r['phase'] for r in runs),
            'response': rng([r['responseMs'] for r in runs]),
            'ranking': rng([r['rankingMs'] for r in runs]),
            'full': rng([r['finalMs'] for r in runs]),
            'duffel': med([r['duffelSearches'] for r in runs]),
            'duffel429': med([r['duffel429'] for r in runs]),
            'aaSearches': med([r['aaJourneySearches'] for r in runs]),
            'aaRouteDays': med([r['aaRouteDays'] for r in runs]),
            'aaUnits': med([r['aaUnitsEst'] for r in runs]),
            'aaOffers': med([r['aaOfferRequests'] for r in runs]),
            'rail': runs[0].get('rail'),
            'misses': sum(r['misses'] for r in runs),
            'distinctFinalAnswers': len(answers),
            'final': runs[0]['final'],
            'first': runs[0]['first'] if two else None,
            'distinctFirstAnswers': len(firsts) if two else None,
            'perPhase': {r['phase']: {'resp': r['responseMs'], 'rank': r['rankingMs'], 'full': r['finalMs'], '429': r['duffel429'],
                                      'order': (r['final'] or {}).get('order'), 'total': (r['final'] or {}).get('total')} for r in runs},
        }
        out.append(rec)
        print(json.dumps(rec))


if __name__ == '__main__':
    main()
