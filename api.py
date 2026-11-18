import requests,json,sys,os
B="https://san-jose.bascula.engp.io"
S=requests.Session()
def login():
    r=S.post(B+"/v1/auth/login",json={"email":"oscar3425@gmail.com","password":"buenosaires5"})
    r.raise_for_status(); t=r.json()
    S.headers["Authorization"]="Bearer "+t["accessToken"]
    return t
def call(m,p,body=None,ok=(200,201,204),**kw):
    r=S.request(m,B+p,json=body,**kw)
    if r.status_code==401:
        login(); r=S.request(m,B+p,json=body,**kw)
    if r.status_code not in ok:
        raise Exception(f"{m} {p} -> {r.status_code} {r.text[:800]} body={json.dumps(body)[:400]}")
    return r.json() if r.text else None
