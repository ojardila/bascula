# How a change gets to production, and how long each part takes

## The flow

```
PR opened/pushed ── CI ──┬─ what changed (path filter)
                         ├─ migration order, money rules        (always, seconds)
                         ├─ console: lint, build                 (web changes)
                         ├─ console tests 1/3, 2/3, 3/3: vitest  (web changes)
                         ├─ typecheck                            (web changes)
                         ├─ api lint: vet, gofmt, govulncheck    (api changes)
                         ├─ api: migrate, diagram, go test       (api changes;
                         │       apitest in 4 processes)
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

## Test suites split across processes and runners (2026-10-03)

### Before (last 40 runs of each workflow, 2026-10-03)

By then the suites had grown and were the critical path of both the PR and
the release:

| what | median | range |
|---|---|---|
| CI on a PR, open/push → green | 5 min 0 s | p90 8 min 22 s |
| ↳ `console` job | 5 min 20 s | 3 min 14 s – 5 min 39 s |
| ↳↳ `vitest run` (160 files, 1288 tests) | 4 min 23 s | 2 min 41 s – 4 min 40 s |
| ↳ `api` job | 4 min 48 s | 3 min 30 s – 5 min 11 s |
| ↳↳ `go test ./...` | 3 min 58 s | 2 min 48 s – 4 min 11 s |
| ↳↳↳ of which `internal/apitest`, one process | 3 min 6 s | |
| ↳↳ vet + gofmt + govulncheck, in front of the tests | 22 s | |
| SonarQube on a PR (slowest check of all) | 13 min 14 s | 10 min 47 s – 13 min 55 s |
| ↳ web tests with coverage | 5 min 40 s | |
| ↳ api tests with coverage (after the web ones) | 4 min 15 s | |
| CodeQL on a push to master (also docs-only pushes) | 2 min 3 s | |
| CD: push → `release` starts (CI inside CD) | 6 min 29 s | 5 min 6 s – 10 min 7 s |

Why CD runs CI at all: `plan` found the PR's run covered the merged sources
in 0 of the last 40 releases. Every one was "master moved under it" (35) or
had no PR run (5). Even comparing with the merge commit CI really tests
(`refs/pull/N/merge`) would have matched only 5 of 40, so that is not worth
the complexity. Making the suites themselves faster is.

The CD runs shown as *cancelled* (30 of 40) are not lost releases. ci.yml's
concurrency group lets one CI run inside CD run at a time and keeps only the
newest one waiting, so during a burst of merges the CD runs in between are
dropped. The next release carries their commits. This batches a burst into
one release every CI-length instead of one per merge. It is kept: with
`cancel-in-progress` a steady stream of merges would never release, and with
no group at all every merge would hold runners for a full CI. Shorter CI
shortens that wait (up to one CI-length, 63 s in run 37099546567) too.

### What changed

| item | before | change | expected after |
|---|---|---|---|
| `internal/apitest` | one process, one scratch DB, 186 s on CI | `scripts/ci/go-test.sh`: the same compiled test binary in 4 processes, each with its own scratch database (TestMain already makes one per process), disjoint subsets of `-test.list`. The four slow tests (season of reports, 12 MB dribbled upload, provisioning poll, certificate gate: 70% of the time) each get their own shard (`scripts/ci/apitest-weights.txt`). Same tests, same order inside a shard, nothing `t.Parallel` | locally on 4 CPUs: whole Go suite 163 s → 39 s; peak 47 Postgres connections of 100 |
| vet, gofmt, govulncheck | in front of the tests in `api` | own job `api lint`, beside the tests | −22 s on the `api` job |
| `vitest run` | one runner, 265 s | `console tests (n/3)`: `vitest --shard` over 3 runners, `console` keeps lint + build | locally on 4 CPUs: 112 s → 46 s for the slowest shard; on CI ~4 min 20 s → ~2 min |
| SonarQube | tests with coverage, web then api, then scan, one runner | `coverage (api)` and `coverage (web n/3)` run in parallel without secrets and hand LCOV / Go profile / linter reports to `sonarqube` as artifacts; shards merged by summing hits (`scripts/ci/merge-lcov.py`, checked against a single run: 9031 vs 9032 of 9701 lines; Go 91.5% both ways); skipped when no analysed source changed | ~13 min → ~6 min; docs-only PRs: 0 |
| CodeQL on master | every push | same path filter as on PRs; the weekly run still covers everything | docs/workflow-only pushes: 0 |

Not changed, and why:

* **Semgrep** is the one required check (ruleset "master: require semgrep"),
  so it keeps running on every PR. A path filter would leave it pending on
  docs-only PRs.
* **Image builds** are already one-per-source-key and normally no-ops in CD.
  The PR build is 21–46 s and runs beside the tests.
* **Go module/build cache** (setup-go, keyed on go.sum, written from master by
  CD's CI) and the **npm cache** were already in place.

Expected after, with both halves changed: CI on a PR ~5 min → ~2½–3 min, and
merge → `release` starts ~6½ min → ~4 min.

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
