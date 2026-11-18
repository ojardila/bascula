from api import *
import uuid, random, datetime as dt
NS=uuid.UUID('6f1c1d2e-5a7b-4c3d-9e8f-000000000001')
def U(k): return str(uuid.uuid5(NS,k))
login()
rnd=random.Random(20260926)
workers={w['docId']:w for w in call('GET','/v1/workers')['items']}
plots={p['name']:(p['id'],p['crops'][0]['id']) for p in call('GET','/v1/plots')['items']}
acts={a['name']:a['id'] for a in call('GET','/v1/activities')['items']}
HARV=acts['Recoleccion']
skill={d:rnd.uniform(0.72,1.3) for d in workers}
skill['75089214']=1.38  # José Arley, best picker (special price)
skill['24336871']=1.22
skill['1002654871']=0.68 # Brayan, new
mondays=[dt.date(2026,8,3)+dt.timedelta(weeks=i) for i in range(8)]
wf=[0.55,0.62,0.72,0.82,0.92,1.0,1.06,1.02]
# which plots are being picked each week (ripening moves through the farm)
rot=[["La Palmera","La Cañada"],["La Cañada","El Mirador"],["El Mirador","La Quiebra"],["El Mirador","El Guamo"],
     ["El Guamo","Alto Bonito"],["El Guamo","El Mirador","La Quiebra"],["Alto Bonito","El Mirador","La Cañada"],["El Guamo","La Palmera","El Mirador"]]
today=dt.date(2026,9,26)
# non-harvest labores: (doc, date, activity, qty, plot)
labor=[]
for i,m in enumerate(mondays):
    sat=m+dt.timedelta(days=5)
    labor.append(("4345120",sat,"Beneficio (despulpado y lavado)",1,None))       # Luis Alberto every Saturday
    if i%2==0: labor.append(("9870543",sat,"Desyerba con guadaña",1,rnd.choice(["La Palmera","La Cañada","La Quiebra"])))
labor+= [("9870543",dt.date(2026,8,11),"Fertilización",1,"Alto Bonito"),("75102338",dt.date(2026,8,11),"Fertilización",1,"Alto Bonito"),
         ("9870543",dt.date(2026,8,12),"Fertilización",1,"La Palmera"),("75102338",dt.date(2026,8,12),"Fertilización",1,"La Palmera"),
         ("75102338",dt.date(2026,8,8),"Plateo de lote",1,"La Quiebra"),
         ("25098761",dt.date(2026,8,5),"Resiembra",180,"Alto Bonito"),("25098761",dt.date(2026,8,6),"Resiembra",145,"Alto Bonito"),
         ("4345120",dt.date(2026,9,16),"Beneficio (despulpado y lavado)",1,None),("4345120",dt.date(2026,9,23),"Beneficio (despulpado y lavado)",1,None)]
busy={(d,day) for d,day,*_ in labor}
total=0; nrec=0
for i,m in enumerate(mondays):
    items=[]
    for k in range(6):
        day=m+dt.timedelta(days=k)
        if day>today: continue
        lots=rot[i]
        for j,(doc,w) in enumerate(sorted(workers.items())):
            if doc=='1002654871' and day<dt.date(2026,8,17): continue   # Brayan joined week 3
            if doc=='25098761' and mondays[3]<=day<mondays[4]: continue  # Rubiela sick that week
            if (doc,day) in busy: continue
            if rnd.random()<0.07: continue
            kg=85*wf[i]*skill[doc]*rnd.uniform(0.82,1.18)*(0.6 if k==5 else 1.0)
            kg=max(22,min(128,kg)); kg=round(kg*2)/2
            lot=lots[(j+k)%len(lots)]
            pid,cid=plots[lot]
            items.append({"workerId":w['id'],"quantity":kg,"dateFrom":day.isoformat(),"plotIds":[pid],"plotCropIds":[cid]})
            total+=kg
    for doc,day,an,q,lot in labor:
        if m<=day<m+dt.timedelta(days=7):
            it={"activityId":acts[an],"workerId":workers[doc]['id'],"quantity":q,"dateFrom":day.isoformat()}
            if lot: it["plotIds"]=[plots[lot][0]]; it["plotCropIds"]=[plots[lot][1]]
            items.append(it)
    r=call('POST','/v1/work-records/batch',{"id":U("batch"+m.isoformat()),"weekStart":m.isoformat(),"activityId":HARV,"items":items})
    nrec+=len(items)
    print(m, len(items), {k:(v if not isinstance(v,list) else len(v)) for k,v in r.items()})
print("harvest kg",total,"records",nrec)
