import random, itertools, statistics, sys
N=5
PERMS=list(itertools.permutations(range(N)))
LAM=(1-0.3)/(1+0.3)
PESS=1.0

def trial(rng, model):
    if model=='30':
        legb={(a,b):rng.uniform(50,225) for a in range(N) for b in range(N) if a!=b}
        legs={(a,b):0.3 for a in range(N) for b in range(N) if a!=b}
        hs=0.3
    else:
        legb={(a,b):rng.uniform(600,1100) for a in range(N) for b in range(N) if a!=b}
        legs={(a,b):rng.uniform(0.6,0.8) for a in range(N) for b in range(N) if a!=b}
        hs=None
    L={}
    for (a,b),base in legb.items():
        for i in range(N-1):
            L[(a,b,i)]=round(base*(1+legs[(a,b)]*rng.uniform(-1,1))*4,2)
    def hf():
        s=hs if hs is not None else rng.uniform(0.6,0.8)
        return round(rng.uniform(600,1100)*(1+s*rng.uniform(-1,1))*4,2)
    Hout=[hf() for _ in range(N)]; Hret=[hf() for _ in range(N)]
    return L,Hout,Hret

def cost(o,L,Hout,Hret):
    return Hout[o[0]]+sum(L[(o[i],o[i+1],i)] for i in range(N-1))+Hret[o[-1]]

class Run:
    def __init__(s,L,Hout,Hret):
        s.L=L;s.Hout=Hout;s.Hret=Hret;s.known={};s.searches=0;s.rounds=0
        s.high={};s.seen={}
    def price(s,key):
        if key in s.known: return
        s.known[key]=s.L[key]; s.searches+=1
        r=(key[0],key[1]); v=s.L[key]
        s.high[r]=max(s.high.get(r,0),v)
        s.seen.setdefault(r,[]).append(v)
    def home(s,o): return s.Hout[o[0]]+s.Hret[o[-1]]
    def ebshrink(s):
        allv=[v for vs in s.seen.values() for v in vs]
        if len(allv)<3: return 0.0
        m=sum(allv)/len(allv); tot=sum((v-m)**2 for v in allv)/(len(allv)-1)
        d=[]
        for vs in s.seen.values():
            if len(vs)>=2:
                mu=sum(vs)/len(vs); d.append((sum((v-mu)**2 for v in vs)/(len(vs)-1)))
        if not d or tot<=0: return 0.0
        wd=sum(d)/len(d)
        return max(0.0,min(1.0,wd/tot))
    def est(s,o,shrink=0.0):
        if shrink=='eb': shrink=s._eb
        lb=s.home(o); ev=lb; opn=[]
        allv=[v for vs in s.seen.values() for v in vs]; gm=sum(allv)/len(allv) if allv else 0
        for i in range(N-1):
            k=(o[i],o[i+1],i)
            if k in s.known:
                lb+=s.known[k]; ev+=s.known[k]
            else:
                r=(o[i],o[i+1])
                if r in s.high:
                    lb+=LAM*s.high[r]; m=sum(s.seen[r])/len(s.seen[r]); ev+=PESS*((1-shrink)*m+shrink*gm)
                    opn.append((i,(1-LAM)*s.high[r]))
                else:
                    ev+=PESS*gm; opn.append((i,float('inf')))
        return lb,ev,opn

def screen_besthome(run,typed):
    typedR=set((typed[i],typed[i+1]) for i in range(N-1))
    for i in range(N-1): run.price((typed[i],typed[i+1],i))
    best={}
    for idx,o in enumerate(PERMS):
        h=run.home(o)
        for i in range(N-1):
            r=(o[i],o[i+1])
            if r in typedR: continue
            if r not in best or h<best[r][0]: best[r]=(h,i)
    for r,(h,i) in best.items(): run.price((r[0],r[1],i))

def screen_packing(run,typed):
    typedR=set((typed[i],typed[i+1]) for i in range(N-1))
    for i in range(N-1): run.price((typed[i],typed[i+1],i))
    arcs=lambda o: frozenset((o[i],o[i+1]) for i in range(N-1))
    cand=[o for o in PERMS if not (arcs(o)&typedR)]
    cand.sort(key=run.home)
    best=None
    # greedy-ish: choose 3 arc-disjoint minimizing sum of home
    for a in range(len(cand)):
        for b in range(a+1,len(cand)):
            if arcs(cand[a])&arcs(cand[b]): continue
            if best and run.home(cand[a])+run.home(cand[b])>=best[0]: break
            for c in range(b+1,len(cand)):
                if (arcs(cand[a])|arcs(cand[b]))&arcs(cand[c]): continue
                t=run.home(cand[a])+run.home(cand[b])+run.home(cand[c])
                if not best or t<best[0]: best=(t,[cand[a],cand[b],cand[c]])
                break
    covered=set()
    for o in best[1]:
        for i in range(N-1):
            run.price((o[i],o[i+1],i)); covered.add((o[i],o[i+1]))
    # leftover routes: best-home day
    bh={}
    for o in PERMS:
        h=run.home(o)
        for i in range(N-1):
            r=(o[i],o[i+1])
            if r in typedR or r in covered: continue
            if r not in bh or h<bh[r][0]: bh[r]=(h,i)
    for r,(h,i) in bh.items(): run.price((r[0],r[1],i))

def bestfirst(run,budget,order='ev',whole=True,width=6,shrink=0.0):
    stop=False
    while True:
        run._eb=run.ebshrink() if shrink=='eb' else 0
        E=[(run.est(o,shrink),idx,o) for idx,o in enumerate(PERMS)]
        E.sort(key=lambda x:(x[0][0],x[1]))
        inc=next((k for k,x in enumerate(E) if not x[0][2]),None)
        if inc==0: break
        cont=E if inc is None else E[:inc]
        if order=='ev': cont=sorted(cont,key=lambda x:(x[0][1],x[1]))
        cap=min(width,budget-run.searches)
        batch=[]
        forced=inc is None
        for (lb,ev,opn),idx,o in cont:
            fresh=[(o[i],o[i+1],i) for i,_ in sorted(opn,key=lambda t:-t[1])]
            fresh=[k for k in fresh if k not in batch]
            if whole:
                if len(batch)+len(fresh)>cap and not (forced and not batch): continue
                batch+=fresh
            else:
                batch+=fresh[:max(0,cap-len(batch))]
            if len(batch)>=cap: break
        if not batch: stop=True;break
        for k in batch: run.price(k)
        run.rounds+=1
    full=[(cost(o,run.L,run.Hout,run.Hret),idx,o) for idx,o in enumerate(PERMS) if all((o[i],o[i+1],i) in run.known for i in range(N-1))]
    return min(full)[2],stop

def go(model,screen,budget,trials=2000,seed=1,**kw):
    rng=random.Random(seed)
    same=0;miss=[];srch=[];rnds=[];stops=0
    for t in range(trials):
        L,Ho,Hr=trial(rng,model)
        ex=min((cost(o,L,Ho,Hr),idx,o) for idx,o in enumerate(PERMS))
        run=Run(L,Ho,Hr)
        typed=PERMS[0]
        screen(run,typed)
        o,stop=bestfirst(run,budget,**kw)
        c=cost(o,L,Ho,Hr)
        same+= (o==ex[2]); miss.append((c-ex[0])/ex[0]); srch.append(run.searches); rnds.append(run.rounds); stops+=stop
    return dict(ident=round(100*same/trials,1),mean=round(100*statistics.mean(miss),2),worst=round(100*max(miss),2),searches=round(statistics.mean(srch),1),rounds=round(statistics.mean(rnds),2),stop=round(100*stops/trials,1))

if __name__=='__main__':
    T=int(sys.argv[1]) if len(sys.argv)>1 else 1000
    for model in ('30','vol'):
        for B in (30,):
            for name,scr in (('besthome',screen_besthome),('packing',screen_packing)):
                for order in ('lb','ev'):
                    print(model,B,name,order,go(model,scr,B,trials=T,order=order))
