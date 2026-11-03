from sim import *
from sim2 import screen_none, go2

def bf2(run,budget,first=16,width=6,shrink=0.0,order='ev',maxr=99):
    stop=False
    w=first
    while run.rounds<maxr:
        E=[(run.est(o,shrink),idx,o) for idx,o in enumerate(PERMS)]
        E.sort(key=lambda x:(x[0][0],x[1]))
        inc=next((k for k,x in enumerate(E) if not x[0][2]),None)
        if inc==0: break
        cont=E if inc is None else E[:inc]
        if order=='ev': cont=sorted(cont,key=lambda x:(x[0][1],x[1]))
        cap=min(w,budget-run.searches)
        batch=[]
        forced=inc is None
        for (lb,ev,opn),idx,o in cont:
            fresh=[(o[i],o[i+1],i) for i,_ in sorted(opn,key=lambda t:-t[1])]
            fresh=[k for k in fresh if k not in batch]
            if len(batch)+len(fresh)>cap and not (forced and not batch): continue
            batch+=fresh
            if len(batch)>=cap: break
        if not batch: stop=True;break
        for k in batch: run.price(k)
        run.rounds+=1
        w=width
    full=[(cost(o,run.L,run.Hout,run.Hret),idx,o) for idx,o in enumerate(PERMS) if all((o[i],o[i+1],i) in run.known for i in range(N-1))]
    return min(full)[2],stop

if __name__=='__main__':
    import sys
    T=int(sys.argv[1])
    for model in ('30','vol'):
        for first in [int(x) for x in sys.argv[2].split(',')]:
            for sh in [float(x) for x in sys.argv[3].split(',')]:
                r=go2(model,screen_none,bf2,T,budget=30,first=first,shrink=sh)
                print(model,'first',first,'shrink',sh,r,flush=True)
