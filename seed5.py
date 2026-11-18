from api import *
import uuid, datetime as dt
NS=uuid.UUID('6f1c1d2e-5a7b-4c3d-9e8f-000000000001')
def U(k): return str(uuid.uuid5(NS,k))
login()
plots={p['name']:(p['id'],p['crops'][0]['id']) for p in call('GET','/v1/plots')['items']}
acts={a['name']:a['id'] for a in call('GET','/v1/activities')['items']}
wh=call('POST','/v1/warehouses',{"id":U("wh1"),"name":"Bodega del beneficiadero"}); print(wh)
prod=call('POST','/v1/products',{"id":U("prod-cps"),"name":"Café pergamino seco","category":"Café","storageUnit":"kg"}); print(prod)
# weekly entries of dry parchment coffee into the warehouse
entries=[("2026-08-08",610,"La Palmera"),("2026-08-15",690,"La Cañada"),("2026-08-22",820,"El Mirador"),("2026-08-29",905,"El Mirador"),
         ("2026-09-05",1010,"El Guamo"),("2026-09-12",1120,"El Guamo"),("2026-09-19",1180,"Alto Bonito")]
for d,q,lot in entries:
    call('POST','/v1/stock/moves',{"id":U("mv"+d),"productId":prod['id'],"warehouseId":wh['id'],"qty":q,"reason":"cosecha","plotId":plots[lot][0],"plotCropId":plots[lot][1],"localDay":d,"note":"Entrada de café seco de la semana"})
sales=[("2026-08-22",500,1950000,"Cooperativa de Caficultores de Manizales"),("2026-09-05",750,1965000,"Cooperativa de Caficultores de Manizales"),
       ("2026-09-12",400,2010000,"Trilladora La Esperanza"),("2026-09-19",900,1990000,"Cooperativa de Caficultores de Manizales")]
for d,q,pk,c in sales:
    s=call('POST','/v1/sales',{"id":U("sale"+d),"productId":prod['id'],"warehouseId":wh['id'],"customer":c,"qty":q,"amountCents":q*pk,"localDay":d,"note":f"{q} kg pergamino seco a ${pk//100:,}/kg"})
    print('sale',s['id'],d,q)
ex=[("Costales y lonas para cosecha",28000000,"2026-08-04",{"activityId":acts["Recoleccion"]}),
    ("Plántulas Castillo para resiembra (325 un.)",29250000,"2026-08-04",{"plotId":plots["Alto Bonito"][0],"plotCropId":plots["Alto Bonito"][1]}),
    ("Fertilizante 17-6-18 (20 bultos)",320000000,"2026-08-10",{"activityId":acts["Fertilización"]}),
    ("Gasolina y nylon para guadaña",15000000,"2026-08-15",{"activityId":acts["Desyerba con guadaña"]}),
    ("Mantenimiento despulpadora",45000000,"2026-08-29",{"activityId":acts["Beneficio (despulpado y lavado)"]}),
    ("Transporte de café a Chinchiná",18000000,"2026-09-05",{"activityId":acts["Recoleccion"]}),
    ("Transporte de café a Chinchiná",18000000,"2026-09-19",{"activityId":acts["Recoleccion"]})]
for i,(c,a,d,t) in enumerate(ex):
    e=call('POST','/v1/expenses',dict(id=U(f"exp{i}"),concept=c,amountCents=a,localDay=d,**t)); print('expense',e['id'],c)
print(call('GET','/v1/stock'))
