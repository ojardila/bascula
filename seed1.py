from api import *
import uuid, random, math
NS=uuid.UUID('6f1c1d2e-5a7b-4c3d-9e8f-000000000001')
def U(k): return str(uuid.uuid5(NS,k))
login()
# --- users
for email,name,role,pw in [("pesador.sanjose@example.com","Hernán Giraldo (Pesador)","weigher","pesador2026"),
                           ("mayordomo.sanjose@example.com","Luis Fernando Ocampo (Mayordomo)","admin","mayordomo2026")]:
    print(call('POST','/v1/users',{"email":email,"name":name,"role":role,"password":pw}))
# --- workers
W=[("José Arley","Cardona Ríos","75089214"),("María Eugenia","Valencia Osorio","24336871"),("Jhon Fredy","Marín Gómez","1053778402"),
   ("Luz Dary","Henao Castaño","30405512"),("Carlos Arturo","Duque Salazar","75071633"),("Yeison Andrés","Restrepo López","1054993120"),
   ("Gloria Inés","Arango Zuluaga","24392075"),("Wilson","Quintero Patiño","9870543"),("Diana Marcela","Grajales Toro","1053812644"),
   ("Luis Alberto","Ospina Cárdenas","4345120"),("Sandra Milena","Castro Arias","30234987"),("Édgar","Montoya Villegas","75102338"),
   ("Brayan Stiven","Agudelo Muñoz","1002654871"),("Rubiela","Serna Tabares","25098761")]
for i,(n,l,doc) in enumerate(W):
    body={"id":U("w"+doc),"name":n,"lastName":l,"documentType":"CC","docId":doc,"tag":f"{i+1:02d}",
          "phone":f"3{random.Random(doc).randint(100000000,229999999)}","municipality":"Chinchiná","city":"Chinchiná","address":"Vereda El Trébol","country":"CO"}
    r=call('POST','/v1/workers',body); print('worker',r['id'],n,l)
# --- plots
cafe=call('GET','/v1/catalogs/crop-types')['items'][0]['id']
P=[("El Mirador",3.2,"Castillo","2019-04-15"),("La Cañada",2.5,"Colombia","2016-05-10"),("El Guamo",4.1,"Castillo","2020-10-01"),
   ("La Palmera",1.8,"Caturra","2014-03-20"),("Alto Bonito",2.9,"Cenicafé 1","2021-04-12"),("La Quiebra",2.2,"Tabi","2018-09-05")]
lat0,lon0=4.9790,-75.6045
x=0.0
for i,(n,a,v,pl) in enumerate(P):
    side=math.sqrt(a*10000)  # metres
    dlat=side/111320; dlon=side/(111320*math.cos(math.radians(lat0)))
    row=i//3; col=i%3
    la=lat0+row*0.0022; lo=lon0+col*0.0024
    j=0.00012
    ring=[[lo,la],[lo+dlon+j,la+j/2],[lo+dlon,la+dlat],[lo-j/2,la+dlat-j],[lo,la]]
    body={"id":U("p"+n),"name":n,"areaHa":a,"department":"Caldas","municipality":"Chinchiná",
          "boundary":{"type":"Polygon","coordinates":[ring]},
          "location":{"type":"Point","coordinates":[lo+dlon/2,la+dlat/2]},
          "crops":[{"id":U("pc"+n),"cropTypeId":cafe,"variety":v,"areaHa":a,"plantedOn":pl+"T00:00:00Z"}]}
    r=call('POST','/v1/plots',body); print('plot',r['id'],n,r.get('computedAreaHa'),[c['id'] for c in r['crops']])
