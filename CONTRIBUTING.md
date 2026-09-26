# Contributing

Small, independent pull requests against `master`, in English (commits, PR
text, code). Text shown to farm workers is plain Spanish. CI must be green
before merging; see [README.md](README.md#ci-and-deploy) for what it runs.

## Database changes

- Migrations live in [`services/api/migrations`](services/api/migrations/README.md);
  read the rules there before adding one (sequential number above `master`,
  row level security for farm data).
- **Every PR that adds or changes a migration must include the regenerated
  database diagram:**

  ```bash
  make db-diagram      # needs Docker; from the repo root or services/api
  git add docs/database.md
  ```

  [`docs/database.md`](docs/database.md) is generated (Mermaid ER diagram of
  every table, column, key and relation, with the latest migration number in
  its header). The `api` CI job regenerates it and fails when the committed
  file differs. Do not edit it by hand.
- Production CD bumps the tenants' `targetRevision`
  (`applications/bascula-tenants.yaml` in the gitops repo), so a migration runs
  on **every farm** when the release is approved, not only on
  `bascula.engp.io`. Write it to be safe on all of them.
