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

Reports are handled on a best-effort basis. You will get an answer in the
advisory thread, and credit in the published advisory if you want it.

## Testing rules

- Test against your own farm only. Create one from the public sign-up.
- Do not read, change or delete other farms' data, and stop as soon as you
  see data that is not yours.
- No denial of service, spam, social engineering or physical attacks.
- Do not try to reach internal infrastructure (registry, cluster, private
  network). Report what you can see from the outside instead.
