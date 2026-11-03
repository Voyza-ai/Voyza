from sim import *
import random
def dist(model,budget,T=400,**kw):
    rng=random.Random(1); miss=[]; typedm=[]; homeonly=[]
    for t in range(T):
        L,Ho,Hr=trial(rng,model)
        allc=sorted((cost(o,L,Ho,Hr),o) for o in PERMS)
        ex=allc[0][0]
        run=Run(L,Ho,Hr); screen_besthome(run,PERMS[0])
        o,_=bestfirst(run,budget,**kw)
        miss.append((cost(o,L,Ho,Hr)-ex)/ex)
        typedm.append((cost(PERMS[0],L,Ho,Hr)-ex)/ex)
        hb=min(PERMS,key=lambda o:Ho[o[0]]+Hr[o[-1]])
        homeonly.append((cost(hb,L,Ho,Hr)-ex)/ex)
    q=lambda xs,p: sorted(xs)[int(p*len(xs))]
    for name,xs in (('ours',miss),('typed',typedm),('best-home',homeonly)):
        print(model,budget,name,'mean %.2f p50 %.2f p90 %.2f p99 %.2f'%(100*statistics.mean(xs),100*q(xs,.5),100*q(xs,.9),100*q(xs,.99)))
dist('vol',30,order='ev')
dist('vol',38,order='ev')
