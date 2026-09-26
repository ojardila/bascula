#!/usr/bin/env bash
# Tell Argo CD that gitops main just moved, instead of waiting for its poll.
#
# Argo polls git every 3 minutes (plus jitter), and the gitops-repo
# app-of-apps has to notice the pin before bascula (and the tenant
# ApplicationSet) can. That wait was most of the time between "gitops
# pinned" and "the new bundle is live". Argo is tailnet-only, so GitHub
# cannot deliver the webhook itself; the CD job, already on the tailnet,
# posts the same GitHub push event to Argo's webhook endpoint.
#
# Best effort: if it fails, Argo's poll still picks the change up.
#
# usage: scripts/ci/argocd-refresh.sh <after sha> [changed file...]
set -uo pipefail
after="$1"; shift
files="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")"
payload=$(cat <<JSON
{"ref":"refs/heads/main","before":"0000000000000000000000000000000000000000","after":"${after}",
 "repository":{"html_url":"https://github.com/ojardila/gitops","default_branch":"main"},
 "commits":[{"id":"${after}","added":[],"removed":[],"modified":${files}}]}
JSON
)
for i in 1 2 3; do
  code=$(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' \
    -X POST "https://${ARGOCD_HOST:-argocd.int.engp.io}/api/webhook" \
    -H 'X-GitHub-Event: push' -H 'Content-Type: application/json' \
    --data "$payload" || true)
  if [ "$code" = "200" ]; then
    echo "argocd refresh requested (gitops ${after})"
    exit 0
  fi
  echo "argocd webhook answered ${code:-nothing} (${i})"
  sleep 3
done
echo "::warning::could not reach the Argo CD webhook; the change lands on its next poll (up to ~3 min)"
exit 0
