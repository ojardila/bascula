# Archive

Documents from the time Báscula was an offline-first Expo phone app with a
server being built behind it. The app has been removed from the repository;
these stay because the code still cites them (the sync and season-import
endpoints in `services/api` are kept for phones that still have the app) and
because they record why things are the way they are.

| Document | What it was |
|---|---|
| [`sincronizacion.md`](sincronizacion.md) | The phone ↔ server sync protocol behind `/v1/sync/*` and `/v1/import/season`. Still the spec for those endpoints. |
| [`sync-and-roles.md`](sync-and-roles.md) | Early notes on sync, tenants and roles. |
| [`simplificacion.md`](simplificacion.md) | The owner's proposal to take the money off the phone, costed. |
| [`plan-sprint-1.md`](plan-sprint-1.md) | The first delivery's plan. |
| [`diagrama-movil.md`](diagrama-movil.md) | Architecture diagrams of the Expo app. |

For the current system, start at the [README](../../README.md).
