## What and why

<!-- What this changes and the problem it solves. Link the issue: "Closes #123". -->

## How it was tested

<!-- Commands run, screens checked by hand, roles tried. -->

## Checklist

- [ ] Small and focused on one thing; text is in English
- [ ] Text shown to farm workers is plain Spanish
- [ ] Tests added or updated, and CI is green
- [ ] If it adds or changes a migration: `make db-diagram` was run and `docs/database.md` is committed, and the migration is safe on every farm
- [ ] No secrets, real farm data or internal hostnames in the code, tests or screenshots

<!--
Security: if this change touches auth, tenant boundary, money, PII or the
rate-limit axes, read docs/incident-response.md once before merging; it is
short, and it is what the on-call reads first when something goes wrong.
-->

