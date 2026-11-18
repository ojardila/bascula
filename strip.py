import yaml,sys,json
d=yaml.safe_load(open('openapi.yaml'))
def strip(o):
    if isinstance(o,dict):
        return {k:strip(v) for k,v in o.items() if k not in ('description','example','examples','summary','tags')}
    if isinstance(o,list): return [strip(x) for x in o]
    return o
what=sys.argv[1]
if what=='schema':
    for n in sys.argv[2:]:
        print(n, json.dumps(strip(d['components']['schemas'][n])))
elif what=='path':
    for p in sys.argv[2:]:
        print(p, json.dumps(strip(d['paths'][p])))
elif what=='list':
    print(list(d['components']['schemas'].keys()))
