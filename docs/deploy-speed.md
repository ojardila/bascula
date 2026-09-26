# How a change gets to production, and how long each part takes

## The flow

```
PR opened/pushed ── CI ──┬─ what changed (path filter)
                         ├─ migration order, money rules        (always, seconds)
                         ├─ console: lint, vitest, build         (web changes)
                         ├─ typecheck                            (web changes)
                         ├─ api: vet, migrate, diagram, go test  (api changes)
                         └─ images: api, web → Harbor src-<key>  (in parallel)

merge to master ── CD ── plan ─┬─ ci      (only if the PR did not test these exact sources)
                               ├─ images  (no-op: src-<key> is already in Harbor)
                               └─ release: promote src-<key> → vX.Y.Z, tag, pin dev,
                                           tell Argo ──► production (approval):
                                           pin prod + every farm in one commit,
                                           tell Argo, wait for /version.json = vX.Y.Z
                                           on every host, purge Cloudflare
```

**Images are built once.** The key of an image is a hash of the sources it is
built from (`scripts/ci/source-keys.sh`), not of the commit. The PR builds
`api:src-<key>` and `web:src-<key>`; the squash commit on master has the same
sources, so CD copies those tags to `vX.Y.Z` in Harbor (same digest, nothing
pulled or rebuilt). A web-only PR keeps the API key, so the API image is not
built at all, and vice versa.

The release number is therefore not baked into the images. The web's
`/version.json` is answered by nginx from the pod's environment
(`BASCULA_VERSION`, stamped into `manifests/base/web.yaml` by CD), and the
«versión nueva» (new version) banner compares **build keys**: a release that only changed
the API does not ask anyone to reload an identical page.

**CI is not run twice.** Before, master ran CI on push and again inside CD.
Now CI has no push trigger, and CD calls it only when the PR's green run does
not cover the commit (a direct push, or master moved under the PR).

**Argo is told at once.** Argo polls git every ~3 minutes, and the
`gitops-repo` app-of-apps has to notice the pin before `bascula` and the
tenant ApplicationSet can. CD is on the tailnet already, so it posts a GitHub
push event to Argo's webhook right after each gitops push
(`scripts/ci/argocd-refresh.sh`).

**Tests and builds do not queue behind production approval.** The old
workflow-wide `concurrency: cd` lock made a new run wait for the previous run's
production approval. Now only `release` and `production` are serialized per
job, and the release lock never cancels a queued run. While holding that lock,
release fetches the latest master and tags, retries a rebased push, and lets a
run whose commit is already in the newest release finish as a no-op. This
keeps rapid merges in order without moving dev or production backwards.

## Before (last 7 CD runs, 2026-09-26)

| stage | typical | range |
|---|---|---|
| queue before first job | 3 s | 3–38 s |
| CI inside CD (critical path: Go suite) | 3 min 15 s | 2 min 59 s – 3 min 47 s |
| ↳ `go test ./...` | 2 min 30 s | 2 min 14 s – 2 min 38 s |
| ↳ console (vitest 66–103 s) | 2 min 10 s | 1 min 42 s – 2 min 36 s |
| release job total | 2 min 25 s | 2 min 7 s – 2 min 43 s |
| ↳ tailnet + Harbor login | 15 s | |
| ↳ build + push api | 40 s | 34–47 s |
| ↳ build + push web (after api, not in parallel) | 58 s | 48–72 s |
| waiting for the production approval (human) | 20 s | 8 s – 2 min 17 s |
| production job: pin prod + farms | 2 s | |
| ↳ waiting for Argo to notice and roll (polled every 20 s) | 3 min 8 s | 2 min 17 s – 5 min 5 s |
| ↳ farms, one after another, then purge | 10 s | |
| **merge → live on the apex** | **9 min 38 s** | 8 min 44 s – 11 min 18 s |

Plus the standalone master CI (3 min 15 s) that ran in parallel and changed
nothing.

## Auto-approval of production (prepared, OFF)

Production requires Oscar's approval on every release. Most releases are a
web or API change with no migration, and the approval is the only step that
waits for a person.

What is ready:

* The `release` job decides `needs_review`: **true** when, compared with the
  release production runs *now*, anything changed in
  `services/api/migrations/`, `manifests/base/postgres.yaml`,
  `manifests/cluster/`, `manifests/overlays/prod/` or
  `manifests/overlays/tenant/`. Comparing with what production runs (not with
  the previous tag) means a release that was never approved cannot slip its
  migration through with the next one.
* The `production` job picks its environment:
  `production-auto` only when the repository variable `PROD_AUTO_APPROVE` is
  `true` **and** `needs_review` is false; `production` (approval) otherwise.

To switch it on (Oscar's call):

1. Settings → Environments → New environment `production-auto`; no
   reviewers; Deployment branches: `master` only.
2. Settings → Variables → `PROD_AUTO_APPROVE` = `true`.

To switch it off: delete the variable (or set it to anything else). Every
release goes back through `production`.

Risks: an API or web bug reaches the farms without a human looking at dev
first. The run is still gated by the full CI, and a bad release is undone by
merging a revert (about the same few minutes).
