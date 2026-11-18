from api import *
import uuid, random, datetime as dt
NS=uuid.UUID('6f1c1d2e-5a7b-4c3d-9e8f-000000000001')
def U(k): return str(uuid.uuid5(NS,k))
login()
rnd=random.Random(7)
workers={w['docId']:w for w in call('GET','/v1/workers')['items']}
mondays=[dt.date(2026,8,3)+dt.timedelta(weeks=i) for i in range(6)]
nset=npay=0; paid=0
for m in mondays:
    sun=m+dt.timedelta(days=6); sat=m+dt.timedelta(days=5)
    if m==dt.date(2026,8,31):
        print(call('POST','/v1/deductions',{"id":U("ded-jhon"),"workerId":workers['1053778402']['id'],"amountCents":4500000,"note":"Botas de caucho","date":"2026-09-05"})['id'])
    for doc,w in sorted(workers.items()):
        pv=call('POST','/v1/settlements/preview',{"workerId":w['id'],"from":m.isoformat(),"to":sun.isoformat()})
        if not pv.get('items'): continue
        try:
            s=call('POST','/v1/settlements',{"id":U(f"set-{doc}-{m}"),"expectedGrossCents":pv['grossCents'],"workerId":w['id'],"from":m.isoformat(),"to":sun.isoformat(),"note":f"Liquidación semana {m.isoformat()}"})
        except Exception as e:
            if 'NOTHING_TO_SETTLE' in str(e): continue
            raise
        nset+=1
        bal=call('GET',f"/v1/workers/{w['id']}/balance")
        b=bal['balanceCents']
        if b>0:
            meth="transferencia" if doc in ('1053778402','1054993120','1053812644','1002654871') else "efectivo"
            call('POST','/v1/payments',{"id":U(f"pay-{doc}-{m}"),"workerId":w['id'],"amountCents":b,"method":meth,"date":sat.isoformat(),"note":f"Pago semana {m.isoformat()}"})
            npay+=1; paid+=b
    print(m,'done',nset,npay,paid/100)
adv=call('POST','/v1/advances',{"id":U("adv-yeison"),"workerId":workers['1054993120']['id'],"amountCents":10000000,"method":"efectivo","date":"2026-09-18","note":"Anticipo para mercado"})
print('advance',adv['id'])
print('settlements',nset,'payments',npay,'paid COP',paid/100)
