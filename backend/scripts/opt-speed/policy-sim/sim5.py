from sim import *
from sim2 import go2
import sys
T=int(sys.argv[1])
for model in ('30','vol'):
    for e in sys.argv[2].split(','):
        kw=dict(budget=30,order='ev')
        if e=='w3': kw['width']=3
        if e=='w4': kw['width']=4
        if e=='eb': kw['shrink']='eb'
        if e=='eb-w4': kw.update(shrink='eb',width=4)
        print(model,e,go2(model,screen_besthome,bestfirst,T,**kw),flush=True)
