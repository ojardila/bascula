# Incident response

One page, meant to be read while the incident is already running. The
[security policy](../SECURITY.md) owns the severity tiers; this page is how
the maintainer actually responds.

## Owner

- On-call: [@ojardila](https://github.com/ojardila) (Oscar).
- The incident lives in **the same private GitHub advisory thread** the
  report came in on. Nothing goes into a public issue, pull request or
  discussion until the advisory publishes.
- The reporter is kept in the thread and told what is happening.

## Triage, in order

1. **Confirm the finding.** Reproduce it on dev (namespace `bascula-dev`)
   whenever possible. If it only reproduces against a specific farm, keep
   that farm's name out of the thread; refer to it as "farm A".
2. **Assign a severity** from `SECURITY.md`. If in doubt, go one tier up.
3. **Decide containment.** Can we hold the attacker out while we fix? See
   the sev-1 mitigation chain below. Containment goes first; the fix
   follows.
4. **Record the plan in the advisory** (severity, reproducer, containment
   plan). Work on the fix in the advisory's temporary private fork, or in a
   normal PR whose title and description do not reveal the vulnerability.

## Sev-1 mitigation chain

For cross-tenant access, a leaked credential or a confirmed auth bypass,
in this order. Pick the steps that match what leaked:

1. **Rotate `jwt-secret`** in the `bascula-api` Secret (see
   [Secrets](../manifests/README.md#secrets)) and restart the API. Every
   access token in flight stops verifying. Sessions survive it: refresh
   tokens are rows in Postgres, not signatures, so clients refresh once and
   carry on. This alone is enough when the signing key itself leaked.
2. **Suspend the affected farm** from the super-admin console if its data
   was reached or its accounts are compromised. Suspension cuts that farm's
   sessions (`FARM_SUSPENDED`); its pickers cannot record new weighings
   until it is reactivated. That is the trade-off.
3. **Revoke the implicated refresh-token family** (the user can do it from
   «Sesiones abiertas»; from the database:
   `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`).
   A replayed refresh token already revokes its family on its own
   (`TOKEN_REUSED`); this step covers the window between the leak and the
   first replay. Access tokens already issued live until they expire
   (15 minutes), or until step 1.
4. **Ship a hotfix release.** Open the PR against `master` and let CI go
   green, including the required `semgrep` check. Merging cuts the release,
   which deploys to dev automatically and to production after approval of
   the `production` GitHub Environment. This is not the moment to skip CI.

Steps 1 and 3 are cheap to undo if the finding turns out to be a false
alarm; step 2 stops a farm from working, so take it only on evidence. Step 4
is the only one that touches `master`.

## Communication

- Reporter: keep updated in the advisory thread.
- Users: once the fix is live and the advisory publishes, the GitHub
  release notes (English) and the published advisory explain what happened
  and what, if anything, farms should do. Anything farms read directly is
  written in plain Spanish.
- Public: no comment until the advisory publishes. If asked, point at
  `SECURITY.md`.

## Post-mortem

Every sev-1 and sev-2 gets one, written as a new section in
[`docs/audits.md`](audits.md) (same scoreboard, same "closed when the
reproducer fails" rule). Template:

```
## <date> — <one-line summary>

**Severity.** sev-<n>.

**What happened.** Two or three sentences. Facts only.

**Impact.** Who could do what to whom, and whether we have evidence any of
it actually happened on a real farm.

**Mitigation.** The steps that were taken (which of the chain above ran,
in what order, how long each took).

**Root cause.** The code or design mistake. Not "the attacker". Not the
person.

**Fix.** PR link, migration number if any, reproducer location.

**Lesson.** What changes so the same class of bug is caught earlier
(a test, a Semgrep rule, a review rule).
```

The reproducer committed under `services/api/internal/apitest/` or
`apps/web/e2e/` is what proves the fix. A finding without a red test
against its reproducer is not closed, no matter what the markdown says.
