from sim import *
import random

def screen_none(run,typed):
    for i in range(N-1): run.price((typed[i],typed[i+1],i))

def ts(run,budget,width=6,draws=None,seed=0,maxrounds=99):
    # Thompson-ish: unknown legs drawn from observed price pool (empirical), pick best ordering per draw, price its unknown legs
    rng=random.Random(seed)
    while run.searches<budget and run.rounds<maxrounds:
        pool=[v for vs in run.seen.values() for v in vs]
        cap=min(width,budget-run.searches)
        batch=[]
        tries=0
        while len(batch)<cap and tries<50:
            tries+=1
            samp={}
            best=None
            for o in PERMS:
                c=run.home(o)
                for i in range(N-1):
                    k=(o[i],o[i+1],i)
                    if k in run.known: c+=run.known[k]
                    else:
                        if k not in samp:
                            r=(o[i],o[i+1])
                            # route mean scaled by random pool ratio
                            samp[k]=rng.choice(pool)
                        c+=samp[k]
                if best is None or c<best[0]: best=(c,o)
            o=best[1]
            fresh=[(o[i],o[i+1],i) for i in range(N-1) if (o[i],o[i+1],i) not in run.known and (o[i],o[i+1],i) not in batch]
            if len(batch)+len(fresh)<=cap: batch+=fresh
        if not batch: break
        for k in batch: run.price(k)
        run.rounds+=1
    full=[(cost(o,run.L,run.Hout,run.Hret),idx,o) for idx,o in enumerate(PERMS) if all((o[i],o[i+1],i) in run.known for i in range(N-1))]
    return min(full)[2],True

def go2(model,screen,policy,trials=500,seed=1,**kw):
    rng=random.Random(seed)
    same=0;miss=[];srch=[];rnds=[];stops=0
    for t in range(trials):
        L,Ho,Hr=trial(rng,model)
        ex=min((cost(o,L,Ho,Hr),idx,o) for idx,o in enumerate(PERMS))
        run=Run(L,Ho,Hr)
        screen(run,PERMS[0])
        o,stop=policy(run,**kw)
        c=cost(o,L,Ho,Hr)
        same+=(o==ex[2]); miss.append((c-ex[0])/ex[0]); srch.append(run.searches); rnds.append(run.rounds); stops+=stop
    return dict(ident=round(100*same/trials,1),mean=round(100*statistics.mean(miss),2),worst=round(100*max(miss),2),searches=round(statistics.mean(srch),1),rounds=round(statistics.mean(rnds),2),stop=round(100*stops/trials,1))

if __name__=='__main__':
    import sys
    T=int(sys.argv[1])
    exps=sys.argv[2].split(',')
    for model in ('30','vol'):
        for e in exps:
            if e=='shr5': r=go2(model,screen_besthome,bestfirst,T,budget=30,order='ev',shrink=0.5)
            if e=='shr85': r=go2(model,screen_besthome,bestfirst,T,budget=30,order='ev',shrink=0.85)
            if e=='b34': r=go2(model,screen_besthome,bestfirst,T,budget=34,order='ev')
            if e=='b38': r=go2(model,screen_besthome,bestfirst,T,budget=38,order='ev')
            if e=='none-ev': r=go2(model,screen_none,bestfirst,T,budget=30,order='ev')
            if e=='none-ts': r=go2(model,screen_none,ts,T,budget=30)
            if e=='bh-ts': r=go2(model,screen_besthome,ts,T,budget=30)
            if e=='none-ts-w3': r=go2(model,screen_none,ts,T,budget=30,width=3)
            print(model,e,r,flush=True)
