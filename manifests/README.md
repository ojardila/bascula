# Deployment

Báscula on the [`k8`](https://github.com/ojardila/k8) cluster, at
**bascula.engp.io** (production, public) and
**bascula.int.dev.engp.io** (dev, tailnet only).

CD writes the image tags into `kustomization.yaml`, creates the git tag,
then pins that tag on ArgoCD Applications in
[`gitops`](https://github.com/ojardila/gitops):

- `applications/bascula-dev.yaml` — every release, no approval
- `applications/bascula.yaml` — GitHub Environment `production`, after approval

Dev is `manifests/overlays/dev` (namespace `bascula-dev`, internal Gateway).
Prod is this directory. After a prod pin, CD waits for the public origin and
purges Cloudflare for `bascula.engp.io`. Nothing here is applied by hand.

```
                    bascula.engp.io
                          │
                   Cloudflare tunnel
                          │
                  Gateway (Cilium/Envoy)
                          │
        ┌─────────────────┼──────────────────┐
        │ /v1, /health    │                  │ /
        ▼                 │                  ▼
   bascula-api            │            bascula-web
   (Go, 1 replica)        │            (nginx, 2 replicas)
        │                 │
        ▼                 │
   bascula-db-rw ◄────────┘
   (CNPG, Postgres 17 + PostGIS 3.5, 2 instances)
```

---

## One hostname, split by path

`docs/decisiones.md` left a decision open: serve the web and the API behind the
same origin, or mount CORS on the server with an origin allowlist. This picks
the first. `route.yaml` sends `/v1` and `/health` to the API and everything
else to the web, so the browser never makes a cross-origin request — the API
keeps having no CORS middleware, and there is no allowlist to maintain.

That is also why `apps/web/Dockerfile` passes no `VITE_API_BASE_URL`: it
defaults to `""`, which makes the client fetch `/v1` relative to the page it
was served from.

---

## The database

A `Cluster` from [CloudNativePG](https://cloudnative-pg.io), which the `k8`
repo installs. Two instances, anti-affinity across nodes, on Longhorn.

**PostGIS is required, not optional.** `00001_extensions_and_roles.sql` does
`CREATE EXTENSION postgis` and `plots` stores boundaries as `geography`, so a
plain `postgres` image fails on the first migration. The cluster runs
`ghcr.io/cloudnative-pg/postgis:17-3.5` — the same PostGIS version as the
`docker-compose.yml` used for local work.

Three roles, three different jobs:

| Role | Comes from | Used by |
|:--|:--|:--|
| `postgres` | CNPG (`enableSuperuserAccess`) | the migration Job only |
| `bascula_api` | CNPG managed role | the API at runtime |
| `bascula_app` | migration 00001 | nothing connects as it; it is the privilege bundle |

The migration Job connects as the superuser because 00001 creates an extension
and a role, and the database owner may do neither.

> [!IMPORTANT]
> `bascula_api` is declared in `postgres.yaml` under `managed.roles` rather
> than left to migration 00001, which creates it with a password that is
> committed to this repository and expects production to replace it out of
> band. Creating it first means the migration's `IF NOT EXISTS` skips it and
> that password never exists on this cluster.

`NOBYPASSRLS` on that role is load-bearing: row level security is the tenant
boundary, so the role the API connects with must not be able to step over it.

---

## Migrations

A Job, not an init container. An init container re-runs on every pod restart
and every scale-up, and two of them racing is how a schema ends up half
applied. It is an ArgoCD sync hook with
`hook-delete-policy: BeforeHookCreation`, so each sync deletes and recreates
it — a completed Job's pod spec is immutable and could not otherwise pick up
a new image.

To see what the last one did:

```bash
kubectl logs -n bascula job/bascula-migrate
```

---

## Why the API is pinned to one replica

`UPLOAD_DIR` is a ReadWriteOnce Longhorn volume holding the photos attached to
weighings, so a second pod on another node cannot mount it. The Deployment is
`strategy: Recreate` for the same reason — RollingUpdate deadlocks against a
ReadWriteOnce volume, with the new pod waiting for a volume the old one holds
and the old one waiting for the new one to be ready.

Scaling past one means moving uploads to a ReadWriteMany volume or to object
storage first. Raising `replicas` on its own will not work.

---

## Secrets

None are in this repo, and none are in git. Both are created against the
cluster:

```bash
# The password for bascula_api. CNPG reconciles the role to match it.
kubectl create secret generic bascula-db-app -n bascula \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=bascula_api \
  --from-literal=password="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)"

# The token signing key. The API refuses to boot without it, by design.
kubectl create secret generic bascula-api -n bascula \
  --from-literal=jwt-secret="$(openssl rand -base64 48)"

# Dev namespace (harbor-pull copied from prod, new DB password and JWT).
./scripts/create-dev-secrets.sh
```

`bascula-db-superuser`, `bascula-db-ca`, `bascula-db-server` and
`bascula-db-replication` are generated by CNPG; they are not created by hand.

> [!WARNING]
> Rotating `jwt-secret` invalidates every access token in flight. Sessions
> survive it — refresh tokens are sha256 rows in Postgres, not signatures, and
> both clients answer a 401 by refreshing once.

---

## What is deliberately not here

**Backups.** The Postgres volume is covered only by Longhorn's snapshots,
which protect the disk and not the database: restoring one gives you the data
files mid-write and Postgres recovers from its WAL on start. CNPG can write
base backups and WAL to S3-compatible storage — DigitalOcean Spaces already
serves that role for Longhorn and etcd. **This is the first thing to add
before the farm's season lives here.**

**The cutover.** `docs/simplificacion.md` describes a sequenced migration
(P0–P8) that moves a live farm's season from the phone to a server. None of it
has been run, and standing this up does not start it. This is an empty
database.
