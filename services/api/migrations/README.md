# Migrations

SQL migrations for the API, applied by [goose](https://github.com/pressly/goose)
and embedded in the binary (`embed.go`), so a release runs exactly the files it
shipped with. `make migrate` applies them locally; on a cluster the
`bascula-migrate` Job does (see [`manifests/README.md`](../../../manifests/README.md#migrations)).

## Rules for a new migration

1. **Next number, sequential.** `000NN_short_name.sql`, strictly above every
   version already on `master` — never a free gap. `scripts/check-migrations.sh`
   (CI job "migration order") fails otherwise, because goose refuses to start
   at a site whose history is missing a version.
2. **Forward only in production.** Write a `-- +goose Down` for local work, but
   deployed databases only move up.
3. **Regenerate the database diagram in the same PR.**

   ```bash
   make db-diagram        # from the repo root or services/api; needs Docker
   git add docs/database.md
   ```

   It applies every migration to a throwaway Postgres+PostGIS container,
   reads the schema back and rewrites [`docs/database.md`](../../../docs/database.md)
   (Mermaid ER diagram; the header names the latest migration included). The
   `api` CI job regenerates it against its own Postgres and **fails if the
   committed file differs**, so a migration PR without the regenerated diagram
   cannot merge. Never edit `docs/database.md` by hand.
4. **Row level security.** A new table holding farm data gets `farm_id`, RLS
   enabled and forced, and its policies, like the tables before it
   ([`docs/modelo-datos.md`](../../../docs/modelo-datos.md)).

## How a migration reaches every farm

- **dev** (`bascula.int.dev.engp.io`): CD pins `applications/bascula-dev.yaml`
  in the gitops repo to the new release; Argo CD syncs and the migration Job
  (a `Sync` hook) runs before the new API starts.
- **production** (`bascula.engp.io`): after the manual approval in the GitHub
  `production` environment, CD pins `applications/bascula.yaml` **and bumps
  `targetRevision` (and the image tags) in `applications/bascula-tenants.yaml`**,
  the ApplicationSet behind every dedicated farm (`{slug}.bascula.engp.io`).
  Each farm's Argo CD application then syncs to the same release and runs its
  own migration Job against its own database. So every farm gets every
  migration on the production release, and a farm is never ahead of or behind
  production.

  Consequence: a migration must be safe to run on every farm's data, including
  a farm created minutes ago (empty) and the oldest one. To check a farm after a
  release: `kubectl logs -n bascula-<slug> job/bascula-migrate`.
