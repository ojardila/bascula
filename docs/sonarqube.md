# SonarQube

Static analysis and coverage on https://sonarqube.int.engp.io (SonarQube
Community Build, self-hosted on the k8 cluster, **tailnet only**; the server
lives in the gitops repo, `apps/sonarqube`).

| | |
|:--|:--|
| Workflow | [`.github/workflows/sonarqube.yml`](../.github/workflows/sonarqube.yml) — PRs, pushes to `master`, manual |
| Config | [`sonar-project.properties`](../sonar-project.properties) — sources, tests, exclusions, coverage paths |
| Summary | [`scripts/sonar-report.py`](../scripts/sonar-report.py) — quality gate + measures via the Web API |
| Secrets | `SONAR_TOKEN` (token of the SonarQube user `github-ci`: Browse + Execute Analysis on `bascula`, plus Create Projects; the permission template `bascula PR scratch` makes it admin only of the `bascula-pr-*` projects it creates), `SONAR_HOST_URL`, and the existing `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` |

## How it runs

1. Go (`go test -coverprofile`), web (vitest + v8 → lcov) and `packages/shared`
   (`node --test` → lcov) run with coverage. Failures do not stop the scan:
   `ci.yml` is what reports broken tests.
2. Only then the runner joins the tailnet as `tag:ci` (same OAuth client as
   the Harbor pushes) and the scanner uploads to SonarQube.
3. `sonar-report.py` waits for the server to process the report and writes
   the job summary; on a PR it also posts (and later updates) one comment.

## Branches and PRs

Community Build analyses a single branch per project. So:

- **`master`** → project **`bascula`**, versioned by `VERSION`. That is the
  dashboard; "new code" is everything since the last release.
- **PRs** → a throwaway project **`bascula-pr-<run id>-<attempt>`**, created
  before the scan and deleted at the end of the job, so `bascula` is the only
  project left on the server. The comment compares it with `bascula`: deltas in bugs, vulnerabilities,
  hotspots, smells, coverage and duplication, and the open issues in the
  files the PR touches that master does not have. More bugs, vulnerabilities
  or hotspots, or coverage down by more than a point, is flagged as a
  regression.

It is **advisory**: the job fails only if SonarQube cannot be reached, and it
is not a required check. Forks and Dependabot PRs skip it (no secrets).

Each PR run has its own project, so two PRs scanned at the same moment no
longer overwrite each other. If a job dies before its last step, delete the
leftover `bascula-pr-*` project by hand.
