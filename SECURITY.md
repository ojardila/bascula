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

## Severity and response targets

Reports are triaged into one of four tiers. Targets are first-response
times measured from the moment the advisory is opened; the fix lands when
it lands, but a reporter should always hear back within the window below.
Credit in the published advisory is offered to every reporter who wants it.

| Tier  | Example                                                                                 | First response |
|-------|-----------------------------------------------------------------------------------------|----------------|
| sev-1 | Cross-tenant access, credential or token leak, auth bypass, privilege escalation         | 24 hours       |
| sev-2 | Wrong money result (settlement, idempotency, double-payment lock)                        | 72 hours       |
| sev-3 | Availability (crash, lockout, resource exhaustion) with no data impact                   | 5 business days|
| sev-4 | Cosmetic, hardening suggestion, or a report that turns out not to be a vulnerability     | 10 business days|

The maintainer running the response follows
[`docs/incident-response.md`](docs/incident-response.md): triage, private
comms channel, the sev-1 mitigation chain, the post-mortem template.

## Testing rules

- Test against your own farm only. Create one from the public sign-up.
- Do not read, change or delete other farms' data, and stop as soon as you
  see data that is not yours.
- No denial of service, spam, social engineering or physical attacks.
- Do not try to reach internal infrastructure (registry, cluster, private
  network). Report what you can see from the outside instead.
