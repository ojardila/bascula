# Security policy

## Supported versions

Bascula is deployed continuously. Only the latest release on `master` (and the
farms running it under `*.bascula.engp.io`) gets security fixes.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a
security problem.**

Report it privately through GitHub: open the
[Security tab](https://github.com/ojardila/bascula/security) and choose
**Report a vulnerability**. Only the maintainers can see the report.

Include what you can of:

- what is affected (endpoint, screen, file and line);
- steps to reproduce, or a proof of concept;
- the impact you expect (which role can do what to whom);
- any fix you suggest.

## Severity

Reports are triaged into one of four tiers. The tier sets the order in which
reports are worked on; it is not a contractual response time. Reports are
handled on a best-effort basis, the answer comes in the advisory thread, and
credit in the published advisory is offered to every reporter who wants it.

| Tier  | Example                                                                              |
|-------|--------------------------------------------------------------------------------------|
| sev-1 | Cross-tenant access, credential or token leak, auth bypass, privilege escalation     |
| sev-2 | Wrong money result (settlement, idempotency, double-payment lock)                    |
| sev-3 | Availability (crash, lockout, resource exhaustion) with no data impact               |
| sev-4 | Cosmetic, hardening suggestion, or a report that turns out not to be a vulnerability |

The maintainer running the response follows
[`docs/incident-response.md`](docs/incident-response.md): triage, the private
channel, the sev-1 mitigation chain and the post-mortem template.

## Testing rules

- Test against your own farm only. Create one from the public sign-up.
- Do not read, change or delete other farms' data, and stop as soon as you
  see data that is not yours.
- No denial of service, spam, social engineering or physical attacks.
- Do not try to reach internal infrastructure (registry, cluster, private
  network). Report what you can see from the outside instead.
