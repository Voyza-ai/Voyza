"""Print one benchmark run's answer: order, total, each leg's mode."""
import json
import sys


def legmode(leg):
    opts = leg.get('options') or []
    if opts:
        return f"{opts[0]['mode']}${opts[0].get('price')}"
    c = leg['comparison']
    rec = c['recommendation']
    if rec == 'train' and c.get('trainOption'):
        return f"train${c['trainOption'].get('price')}(rec)"
    if rec == 'flight' and c.get('flightOption'):
        return f"flight${c['flightOption'].get('price')}(rec)"
    return 'unavailable'


def summ(resp):
    br = resp['bestRoute']
    return {
        'order': ' > '.join(br['ordering']),
        'total': round(br['totalCost'], 2),
        'rank': round(br['rankCost'], 2),
        'legs': [
            f"{l['from'][:4]}-{l['to'][:4]}:{legmode(l)} "
            f"[f={(l['comparison'].get('flightOption') or {}).get('price')} "
            f"t={(l['comparison'].get('trainOption') or {}).get('price')}]"
            for l in br['legs']
        ],
        'out': f"{(resp.get('outboundLeg') or {}).get('originAirport')} ${(resp.get('outboundLeg') or {}).get('price')}",
        'ret': f"{(resp.get('returnLeg') or {}).get('destAirport')} ${(resp.get('returnLeg') or {}).get('price')}",
        'saving': resp.get('savingsVsNaive'),
        'dateShift': (resp.get('dateShiftSuggestion') or {}).get('savings'),
        'checked': resp.get('dateShiftChecked'),
    }


if __name__ == '__main__':
    for path in sys.argv[1:]:
        r = json.load(open(path))
        print(r['name'], 'status', r['status'], 'resp', r['responseMs'], 'final', r['finalMs'], 'stages', r['stages'])
        print(json.dumps(summ(r['response']), indent=1))
        if r.get('final'):
            print('FINAL', json.dumps(summ(r['final']), indent=1))
