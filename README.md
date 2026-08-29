# ⚖️ Báscula

**Harvest control and payroll for farms.** A picker weighs in on a phone with no
signal; the office sees it, settles it and pays it from the web. Coffee, cacao
and whatever else gets picked by the kilo.

<p align="center">
  <img src="docs/screenshots/home.png"        width="24%" alt="Home" />
  <img src="docs/screenshots/payments.png"    width="24%" alt="Payments" />
  <img src="docs/screenshots/week-detail.png" width="24%" alt="Week detail" />
  <img src="docs/screenshots/performance.png" width="24%" alt="Performance" />
</p>

| Piece | What it is | State |
|---|---|---|
| [`apps/mobile`](apps/mobile) | Expo app: weighing, settling, paying, performance | **Working** |
| [`apps/web`](apps/web) | React: farm administration and super-admin | Planned |
| [`services/api`](services/api) | Go + PostgreSQL, multi-tenant, sync endpoint | Planned |
| [`packages/shared`](packages/shared) | The ledger contract shared by all three | Planned |

## Getting started

```bash
npm install          # installs every workspace
npm run android      # or: npm run ios
npm test             # 75 tests, no build step
npm run typecheck
```

Requirements: Node 18+ and the **Expo Go** app on a simulator or device. The
mobile app works standalone and offline — none of the planned services are
needed to use it.

## Design notes

- [Sync and roles](docs/sync-and-roles.md) — how records travel from a phone
  with no signal to the server, what happens when two phones settle the same
  week, and what each role can do.

## 📄 License

MIT
