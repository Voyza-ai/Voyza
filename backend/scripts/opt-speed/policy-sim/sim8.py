import sim
from sim import *
from sim2 import go2
def screen_topk(K):
    def scr(run,typed):
        typedR=set((typed[i],typed[i+1]) for i in range(N-1))
        for i in range(N-1): run.price((typed[i],typed[i+1],i))
        top=sorted(PERMS,key=run.home)[:K]
        best={}
        for o in top:
            h=run.home(o)
            for i in range(N-1):
                r=(o[i],o[i+1])
                if r in typedR: continue
                if r not in best or h<best[r][0]: best[r]=(h,i)
        for r,(h,i) in best.items(): run.price((r[0],r[1],i))
    return scr
import sys
T=int(sys.argv[1])
for K in [int(x) for x in sys.argv[2].split(',')]:
    for model in ('30','vol'):
        print(model,'topK',K,go2(model,screen_topk(K),bestfirst,T,budget=30,order='ev'),flush=True)
