# Incident response

One page, meant to be read while the incident is already running. The
[security policy](../SECURITY.md) owns the severity tiers and response
times; this page is how the maintainer actually responds.

## Owner

- On-call: [@ojardila](https://github.com/ojardila). Steven
  ([@bizoru](https://github.com/bizoru)) is the backup for sev-1 outside
  Oscar's working hours.
- The incident lives in **the same private GitHub advisory thread** the
  report came in on. No Slack, no email, no screenshots in a public issue.
- The reporter is kept in the thread and told what is happening; silence
  is not acceptable past the response times in `SECURITY.md`.

## Triage, in order

1. **Confirm the finding.** Reproduce it on `bascula-dev` whenever
   possible. If it only reproduces against a specific farm, keep that
   farm's name out of the thread; refer to it as "farm A".
2. **Assign a severity** from `SECURITY.md`. If in doubt, go one tier up.
3. **Decide containment.** Can we hold the attacker out while we fix?
   See the sev-1 mitigation chain below. Containment goes first; the fix
   follows.
4. **Open a private tracking issue** inside the advisory thread with the
   agreed severity, the reproducer, and the containment plan. The issue
   stays closed to the public until the advisory publishes.

## Sev-1 mitigation chain

For cross-tenant access, a leaked credential or a confirmed auth bypass,
in this order:

1. **Rotate `JWT_SECRET`** via the sealed-secrets rotation runbook (every
   session is invalidated; farms are logged out). This is the brake.
2. **Suspend the affected farm** from the super-admin console if its
   data was reached. Pickers lose the ability to record new weighings
   until the fix lands; this is the trade-off.
3. **Invalidate the refresh-token family** for the implicated session
   (`DELETE FROM refresh_tokens WHERE family_id = $1`). A reused refresh
   token already does this on its own; this step covers the window
   between the leak and the first replay.
4. **Pin a hotfix release**. Open the PR against `master`, let CI go
   green, approve `production` in the GitHub Environment. The usual
   release train runs; this is not the moment to skip CI.

Steps 1-3 are safe to run even if the finding later turns out to be a
false alarm. Step 4 is the only one that touches master.

## Communication

- Reporter: keep updated in the advisory thread. Minimum one update per
  response window in `SECURITY.md`.
- Users: once the fix is live and the advisory publishes, a release note
  on GitHub (English) and the usual farm bulletin (Spanish) explain what
  happened and what, if anything, farms should do.
- Public: no comment until the advisory publishes. If asked, point at
  `SECURITY.md`.

## Post-mortem

Every sev-1 and sev-2 gets one, written as a new row in `docs/audits.md`
(same scoreboard, same "closed when the reproducer fails" rule). Template:

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

**Lesson.** One SEC-### invariant added to or edited in
`docs/security-invariants.md`, with a test pointer.
```

The reproducer committed under `services/api/internal/apitest/` or
`apps/web/e2e/` is what proves the fix. A finding without a red test
against its reproducer is not closed, no matter what the markdown says.
