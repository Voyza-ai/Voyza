import sim
from sim import *
from sim2 import go2
import sys
T=int(sys.argv[1])
for p in [float(x) for x in sys.argv[2].split(',')]:
    sim.PESS=p
    for model in ('30','vol'):
        print(model,'pess',p,sys.argv[3] if len(sys.argv)>3 else '',go2(model,screen_besthome,bestfirst,T,budget=30,order='ev',**({'shrink':'eb'} if len(sys.argv)>3 else {})),flush=True)
