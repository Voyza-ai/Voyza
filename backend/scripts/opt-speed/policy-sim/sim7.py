import sim, math
from sim import *
from sim2 import go2
def phi(z): return math.exp(-z*z/2)/math.sqrt(2*math.pi)
def Phi(z): return 0.5*(1+math.erf(z/math.sqrt(2)))
def ei_bf(run,budget,width=6,cv=None,shrink=0.0,perleg=True):
    stop=False
    while True:
        run._eb=run.ebshrink() if shrink=='eb' else 0
        E=[(run.est(o,shrink),idx,o) for idx,o in enumerate(PERMS)]
        E.sort(key=lambda x:(x[0][0],x[1]))
        inc=next((k for k,x in enumerate(E) if not x[0][2]),None)
        if inc==0: break
        cont=E if inc is None else E[:inc]
        I=E[inc][0][0] if inc is not None else float('inf')
        allv=[v for vs in run.seen.values() for v in vs]; gm=sum(allv)/len(allv)
        sd_leg=(cv if cv is not None else 0.17)*gm
        scored=[]
        for (lb,ev,opn),idx,o in cont:
            n=len(opn); s=math.sqrt(n)*sd_leg
            if I==float('inf'): e=1e9-ev
            else:
                z=(I-ev)/s; e=(I-ev)*Phi(z)+s*phi(z)
            scored.append((-(e/n if perleg else e),idx,o,opn))
        scored.sort()
        cap=min(width,budget-run.searches)
        batch=[]
        forced=inc is None
        for _,idx,o,opn in scored:
            fresh=[(o[i],o[i+1],i) for i,_ in opn]
            fresh=[k for k in fresh if k not in batch]
            if len(batch)+len(fresh)>cap and not (forced and not batch): continue
            batch+=fresh
            if len(batch)>=cap: break
        if not batch: stop=True;break
        for k in batch: run.price(k)
        run.rounds+=1
    full=[(cost(o,run.L,run.Hout,run.Hret),idx,o) for idx,o in enumerate(PERMS) if all((o[i],o[i+1],i) in run.known for i in range(N-1))]
    return min(full)[2],stop
import sys
T=int(sys.argv[1])
for e in sys.argv[2].split(','):
    for model in ('30','vol'):
        kw={}
        if e=='cv17': kw=dict(cv=0.17)
        if e=='cv4': kw=dict(cv=0.4)
        if e=='cv4-tot': kw=dict(cv=0.4,perleg=False)
        if e=='cv17-tot': kw=dict(cv=0.17,perleg=False)
        print(model,e,go2(model,screen_besthome,ei_bf,T,budget=30,**kw),flush=True)
