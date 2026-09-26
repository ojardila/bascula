# «Preparando su finca»: real provisioning progress

`GET /v1/farms/{slug}/provision-status` returns, besides the four legacy
`steps`, weighted monotonic `stages`, a `percent`, the `current` step in plain
Spanish, the `source` of the data and an optional `note`. The waiting screen
renders them as a progress bar with a step list.

## Stages (dedicated farm stack)

| key | weight | done when | read from |
|---|---|---|---|
| received | 2 | always (the farm row exists) | platform DB |
| pipeline_started | 5 | a `provision-tenant` run named `Provision tenant {slug}` exists | GitHub Actions |
| pipeline_done | 8 | that run succeeded, or the Argo Application exists | GitHub Actions / Argo CD |
| deployment | 10 | Application `argocd/bascula-{slug}` is Synced (or its last operation succeeded) | Argo CD |
| namespace | 5 | namespace `bascula-{slug}` is Active | Kubernetes |
| database | 20 | CNPG Cluster `bascula-db` readyInstances ≥ instances | CNPG |
| migrations | 10 | Job `bascula-migrate` succeeded | Kubernetes |
| pods | 15 | Deployments `bascula-api` and `bascula-web` have all replicas Ready | Kubernetes |
| route | 5 | HTTPRoute `bascula` Accepted and Services `bascula-api`/`bascula-web` exist | Gateway API |
| app | 5 | the stack reports the farm, owner and password copied in | stack internal API |
| certificate | 10 | Cloudflare custom hostname `status` and `ssl.status` are `active` | Cloudflare API |
| site | 5 | `https://{slug}.bascula.engp.io/health` answers 200 over strictly verified TLS (cache-busted), with the certificate active | HTTPS |

The first nine stages (through route) form a chain: a later one seen done marks
the earlier ones done; app, certificate and site are independent. Stages are remembered per process, so progress never goes back, and the
percentage is capped at 99 until the ready gate (database, app, certificate,
web) passes. Each stage's first "done" is logged as `provision stage done` with
`afterSeconds`, which gives per-stage timings.

Shared-only deployments (no dispatch token) show `received`, `certificate`,
`site`.

## Fallback

If the cluster cannot be read (no ServiceAccount token, RBAC missing, API
server unreachable) `source` is `pipeline` (GitHub answered) or `basic`, the
cluster stages are inferred from the stack's own answer, and `note` tells the
owner in plain words that some detail is not visible. Nothing technical is
shown.

## Credentials and permissions

- **Kubernetes**: the platform API runs as ServiceAccount `bascula-api`
  (manifests/base/api.yaml) with its in-cluster token. Farm stacks run with the
  same name but `automountServiceAccountToken: false` and no bindings. RBAC,
  all `get/list/watch`:
  - `ClusterRole bascula-namespace-reader` (namespaces) +
    `ClusterRoleBinding` — manifests/cluster/bascula-provision-reader.yaml
  - `Role argocd/bascula-app-reader` (applications.argoproj.io) + RoleBinding —
    same file
  - `ClusterRole bascula-tenant-reader` (pods, services, deployments, jobs,
    httproutes, clusters.postgresql.cnpg.io), bound only inside each
    `bascula-{slug}` by `RoleBinding bascula-provision-reader`, shipped by the
    tenant overlay (manifests/overlays/tenant/provision-reader-binding.yaml).
  - No secrets, configmaps, writes or exec anywhere.
  - Apply the cluster file once: `kubectl apply -f manifests/cluster/bascula-provision-reader.yaml`.
  - Network: CiliumNetworkPolicy `bascula-api` allows egress to the
    `kube-apiserver` entity (6443/443).
- **GitHub**: the existing `GITHUB_DISPATCH_TOKEN` (secret `bascula-api`,
  key `github-dispatch-token`). Reading runs needs `actions: read` on
  ojardila/bascula; without it the pipeline stages are inferred from the
  cluster.
- **Cloudflare**: the existing `CF_SAAS_TOKEN` (secret `bascula-cloudflare`,
  key `saas-token`), "SSL and Certificates: Edit" on zone engp.io.

## Missing-hostname sweep

With a cluster client and Cloudflare configured, the platform API lists
namespaces 30 s after start and every 10 minutes; for every Active
`bascula-{slug}` whose certificate it has not seen active it (re)starts the
certificate watcher, which creates the custom hostname if missing, re-requests
failed certificates and surfaces errors in `certificateError`.
