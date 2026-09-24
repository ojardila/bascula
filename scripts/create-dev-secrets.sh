#!/usr/bin/env bash
# Cluster secrets for namespace bascula-dev. Never committed.
# Copies harbor-pull from prod; mints a new DB password and JWT.
set -euo pipefail
NS=bascula-dev
kubectl get ns "$NS" >/dev/null
if ! kubectl get secret harbor-pull -n "$NS" >/dev/null 2>&1; then
  kubectl get secret harbor-pull -n bascula -o json \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); d["metadata"]={"name":"harbor-pull","namespace":"'"$NS"'"}; d.pop("resourceVersion",None); d.pop("uid",None); d.pop("creationTimestamp",None); print(json.dumps(d))' \
    | kubectl apply -f -
fi
# bascula-db-api holds bascula_api. CNPG owns bascula-db-app for owner bascula.
if ! kubectl get secret bascula-db-api -n "$NS" >/dev/null 2>&1; then
  kubectl create secret generic bascula-db-api -n "$NS" \
    --type=kubernetes.io/basic-auth \
    --from-literal=username=bascula_api \
    --from-literal=password="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)"
fi
if ! kubectl get secret bascula-api -n "$NS" >/dev/null 2>&1; then
  kubectl create secret generic bascula-api -n "$NS" \
    --from-literal=jwt-secret="$(openssl rand -base64 48)"
fi
echo "secrets in $NS: harbor-pull, bascula-db-api, bascula-api"
