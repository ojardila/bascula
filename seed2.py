from api import *
import uuid
NS=uuid.UUID('6f1c1d2e-5a7b-4c3d-9e8f-000000000001')
def U(k): return str(uuid.uuid5(NS,k))
login()
wu=call('POST','/v1/catalogs/work-units',{"id":U("wu-arbol"),"code":"arbol","label":"Árbol sembrado"}); print(wu)
A=[("Desyerba con guadaña","mantenimiento","tiempo",6000000,{"timeUnit":"jornal"},None),
   ("Fertilización","mantenimiento","tiempo",6500000,{"timeUnit":"jornal"},None),
   ("Plateo de lote","mantenimiento","contrato",35000000,{},None),
   ("Resiembra","siembra","unidad_trabajo",60000,{},wu['id']),
   ("Beneficio (despulpado y lavado)","beneficio","tiempo",6000000,{"timeUnit":"jornal"},None)]
for n,cat,ps,rate,extra,unit in A:
    b={"id":U("a"+n),"name":n,"category":cat,"payScheme":ps,"rate":dict(rateCents=rate,validFrom="2026-07-01",**extra)}
    if unit: b["unitId"]=unit; b["rateSource"]="activity_dated"
    r=call('POST','/v1/activities',b); print(r['id'],r['name'],r['payScheme'],r['rateSource'],r['rate'])
