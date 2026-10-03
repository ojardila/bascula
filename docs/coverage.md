# Coverage ledger

Every line and branch that stays uncovered on `master`, and why. The rule:
**unreachable code is documented, not hidden.** There are no
`istanbul ignore` / `c8 ignore` / coverage-ignore comments in the repo, and
there should not be any.

Measured on 2026-10-03, `master` at `3462c17` (Release v0.2.131):

| | Covered | Uncovered | % |
|:--|--:|--:|--:|
| Go statements (`services/api`, without `internal/apitest`) | 11980 / 12056 | 76 | 99.37 |
| Web lines (`apps/web`) | 7502 / 7503 | 1 | 99.99 |
| Web branches (`apps/web`) | 7405 / 7429 | 24 | 99.68 |

SonarQube leaves `services/api/internal/apitest/**`, `apps/web/src/mocks/**`
and `apps/web/src/main.tsx` out of coverage (`sonar.coverage.exclusions` in
[`sonar-project.properties`](../sonar-project.properties)); the numbers
above do the same.

## Measuring it locally

Go, from `services/api` (a Postgres the tests can create databases on):

```sh
TEST_ADMIN_DATABASE_URL=postgres://postgres@localhost:5432/bascula?sslmode=disable \
COVERPROFILE=coverage.raw ../../scripts/ci/go-test.sh
go tool cover -func=coverage.raw | tail -1
```

With `-coverpkg=./...` one block can appear several times in a profile; a
block is covered when **any** of its entries has a count above zero.

Web, from the repo root:

```sh
npm ci
npm install --no-save --workspace apps/web "@vitest/coverage-v8@$(node -p "require('vitest/package.json').version")"
npx --workspace apps/web vitest run --coverage.enabled --coverage.provider=v8 \
  --coverage.reporter=json --coverage.reporter=text-summary
```

Uncovered branches are the `b[id][k] == 0` arms in
`apps/web/coverage/coverage-final.json`.

## Policy

- **Tests assert behavior.** A test that only executes a line, without
  checking what it did, does not count.
- **Error branches are reached by fault injection**, not skipped:
  `testTxWrap` in `internal/tenant` (the request transaction fails on its Nth
  call), the per-handler sweep in `internal/httpapi/fault_sweep_test.go`, the
  auth failure paths in `internal/apitest/auth_faults_test.go`, and MSW
  handlers that answer 4xx/5xx (`server.use(...)`) on the web.
- **Dead code is deleted.** If nothing can reach a branch and it protects
  nothing, it goes.
- **What cannot be reached is listed here**, with a reason a reviewer can
  check against the code.
- **Defensive guards stay** when they protect against a plausible future
  refactor or a real race, even though no test can reach them today.

## Go (76 statements)

### Deliberately kept defensive guards (17)

| Where | Why it stays |
|:--|:--|
| `services/api/internal/auth/jwt.go:145-147` | The keyfunc's HMAC check. `jwt.WithValidMethods([]string{"HS256"})` refuses every other `alg` first, so it is unreachable; it is the second lock against alg confusion if that option is ever dropped. |
| `services/api/internal/httpapi/handlers_expenses.go:59-62` | `tenant.Tx` after `confirmOurs`, which already read the same tx from the same context and returned its error. Kept as a tenant-isolation guard: if `confirmOurs` is moved or removed, this is what stops a handler from running without the farm's transaction. |
| `services/api/internal/httpapi/handlers_expenses.go:142-145` | Same `tenant.Tx` after `confirmOurs`. |
| `services/api/internal/httpapi/handlers_expenses.go:199-202` | Same. |
| `services/api/internal/httpapi/handlers_sales.go:43-46` | Same. |
| `services/api/internal/httpapi/handlers_stock.go:89-92` | Same. |
| `services/api/internal/httpapi/handlers_stock.go:115-118` | Same. |
| `services/api/internal/httpapi/handlers_stock.go:162-165` | Same. |
| `services/api/internal/httpapi/handlers_stock.go:253-256` | Same. |

### Cannot fail in this runtime (52)

`crypto/rand.Read` never returns an error since Go 1.24 (it crashes the
process instead) and `go.mod` is on Go 1.26. `auth.HashPassword` and
`auth.NewOpaqueToken` now always return a nil error (their only failure was
that read); the error result stays in the signature for the callers.

| Where | Why |
|:--|:--|
| `services/api/internal/httpapi/handlers_mcp_write.go:412-414` | `rand.Read` error. |
| `services/api/internal/httpapi/handlers_oauth.go:1450-1452` | `rand.Read` error in `randomToken`. |
| `services/api/internal/httpapi/handlers_password.go:367-369` | `rand.Read` error in `newResetSecret`. |
| `services/api/internal/httpapi/handlers_users.go:168-170` | `rand.Read` error in `newUnusablePasswordHash`. |
| `services/api/internal/httpapi/handlers_users.go:586-588` | `rand.Read` error in `newTemporaryPassword`. |
| `services/api/internal/httpapi/handlers_oauth.go:296-299` | Passes on the `randomToken` error. |
| `services/api/internal/httpapi/handlers_oauth.go:335-338` | Passes on the `randomToken` error (via `oauthRegMintSecret`). |
| `services/api/internal/httpapi/handlers_oauth.go:358-360` | Passes on the `randomToken` error. |
| `services/api/internal/httpapi/handlers_oauth.go:781-784` | Passes on the `randomToken` error. |
| `services/api/internal/httpapi/handlers_oauth.go:1528-1531` | Passes on the `randomToken` error. |
| `services/api/internal/httpapi/handlers_password.go:246-249` | Passes on the `newResetSecret` error. |
| `services/api/internal/httpapi/handlers_farm.go:338-340` | Passes on the `newTemporaryPassword` error. |
| `services/api/internal/httpapi/handlers_users.go:247-250` | Passes on the `newInviteSecrets` error, which is only rand. |
| `services/api/internal/httpapi/handlers_users.go:344-346` | Passes on the `newTemporaryPassword` error. |
| `services/api/internal/httpapi/handlers_users.go:353-355` | Passes on the `newUnusablePasswordHash` error. |
| `services/api/internal/httpapi/handlers_auth.go:372-374` | `auth.HashPassword` returns nil. |
| `services/api/internal/httpapi/handlers_farm.go:343-345` | `auth.HashPassword` returns nil. |
| `services/api/internal/httpapi/handlers_users.go:349-351` | `auth.HashPassword` returns nil. |
| `services/api/internal/httpapi/handlers_password.go:107-110` | `auth.HashPassword` returns nil. |
| `services/api/internal/httpapi/handlers_password.go:321-324` | `auth.HashPassword` returns nil. |
| `services/api/internal/httpapi/handlers_auth.go:431-433` | `auth.NewOpaqueToken` returns nil. |
| `services/api/internal/httpapi/handlers_auth.go:909-911` | `auth.NewOpaqueToken` returns nil. |
| `services/api/internal/httpapi/handlers_auth.go:905-907` | `IssueSession` signs HS256 with a `[]byte` key; `SigningMethodHMAC.Sign` cannot fail with one, even an empty one. |
| `services/api/internal/httpapi/handlers_mcp_docs.go:156-159` | `json.Marshal` of the fixed tool catalogue (strings and slices). |
| `services/api/internal/httpapi/handlers_oauth.go:320-323` | `json.Marshal` of a map built from strings and JSON-decoded values. |
| `services/api/internal/httpapi/handlers_oauth.go:1139-1141` | `json.Marshal(*webauthn.Credential)`: plain data. |
| `services/api/internal/httpapi/handlers_passkeys.go:414-417` | `json.Marshal(*webauthn.Credential)`. |
| `services/api/internal/httpapi/handlers_passkeys.go:620-623` | `json.Marshal(*webauthn.Credential)`. |
| `services/api/internal/httpapi/handlers_passkeys.go:186-188` | `json.Marshal(*webauthn.SessionData)`: strings, bytes, a time, and an extensions map we never set. |
| `services/api/internal/httpapi/handlers_passkeys.go:339-342` | Passes on the `sealPasskeySession` error above. |
| `services/api/internal/httpapi/handlers_passkeys.go:545-548` | Passes on the `sealPasskeySession` error above. |
| `services/api/internal/httpapi/provision.go:91-93` | `json.Marshal` of a `map[string]any` holding only strings. |
| `services/api/internal/httpapi/provision.go:395-397` | `json.Marshal(tenantSeed)`: strings, numbers, bools and times. |
| `services/api/internal/httpapi/handlers_passkeys.go:334-337` | `BeginRegistration` runs after `webauthn.New` accepted the same config (same RP id validation, the configured origin, a 16-byte user handle); the only failure left is the challenge's `rand.Read`. |
| `services/api/internal/httpapi/handlers_passkeys.go:540-543` | `BeginDiscoverableLogin`, same reasoning. |
| `services/api/internal/store/db.go:74-76` | `pgxpool.NewWithConfig` fails only for a config not from `ParseConfig` or `MaxConns < 1`; `MaxConns` is the constant `OrdinaryConns + MaxImportsAtOnce`. Connecting is lazy, so a dead database shows up at `Ping`, which is covered. Kept: it guards a library constructor. |

### Already checked earlier in the same flow (7)

| Where | Why |
|:--|:--|
| `services/api/internal/httpapi/handlers_oauth.go:548-550` | `url.Parse(reg)` on a string `oauthRedirectOK` parsed successfully just before. |
| `services/api/internal/httpapi/handlers_oauth.go:694-697` | `a.target == nil`: both callers run after `oauthAuthzClient` has set it. |
| `services/api/internal/httpapi/handlers_oauth.go:949-951` | Empty `memberships`: `oauthSignIn` already returned on an empty list, and the unverified path returns before this line. |
| `services/api/internal/httpapi/handlers_oauth.go:1104-1106` | The farm-host fallback. A membership of the pinned farm has `FarmSlug` equal to the slug (same `farms` join, same transaction), so the loop above already returned it. |
| `services/api/internal/httpapi/farm_certificate.go:193-195` | `h == nil`: `cfsaas.Client.Ensure` and `Get` never return `(nil, nil)`; `Find` returns a hostname or falls through to `Create`, which returns `&h`. |
| `services/api/internal/httpapi/slug.go:204-206` | `slug == "bascula"` under the dev suffix is `bascula.int.dev.engp.io`, i.e. `devFarmHostApex`, which the switch above already returned for. |

That is 6 rows and 7 statements (`oauth.go:694` is two).

## Web (1 line, 24 branches)

### Deliberately kept defensive guards (5)

| Where | Why it stays |
|:--|:--|
| `apps/web/src/api/client.ts:126` | `if (!tokens) return null` in `refreshTokens`. Callers only refresh while signed in, but a logout can clear `tokens` between their check and this call; without it a refresh with no token would fire a spurious logout. |
| `apps/web/src/features/onboarding/TourCard.tsx:43` | `if (busy) return`. The button is `disabled={busy}`, but two taps in the same tick land before that render. Re-entrancy guard; jsdom cannot tap twice in one tick. |
| `apps/web/src/lib/returnTo.ts:30` | The `catch` around `new URL(from, BASE)`. Input that passed the checks above always parses, but the parse guards untrusted router state and stays. (The one uncovered web line.) |
| `apps/web/src/lib/returnTo.ts:32` | `url.origin !== BASE`. Same input always resolves to `BASE`'s origin; it is the last check before following a redirect target, and stays. |
| `apps/web/src/features/workrecords/RegistroMasivoPage.tsx:163` | The future-day clamp in `setDay`. Every caller already excludes future days (disabled toggles, next-week button); the clamp is a business rule. |

### UI state the DOM can't produce in jsdom (6)

| Where | Why |
|:--|:--|
| `apps/web/src/features/inventory/StockMoveDialog.tsx:181` | Crop without a lot: the crop select is disabled until a lot is chosen, and every lot change clears the crop. |
| `apps/web/src/features/prices/WeekPricePage.tsx:570` | `newCents === null` in `save`: the confirm dialog only opens when `priceProblem(newCents)` is null, which needs a number. |
| `apps/web/src/features/workrecords/WeighingForm.tsx:257` | `!worker \|\| !activity` in `save`: `check()` already required both, and the doubt dialog is modal. |
| `apps/web/src/features/settlements/SettlementsPage.tsx:172` | No rows in `printPayroll`: the print button is disabled under the same condition. |
| `apps/web/src/features/prices/BasePriceCard.tsx:368` | The `"lunes"` fallback: the button is disabled without `data`, and `data.thisWeek` is a required string. |
| `apps/web/src/features/workrecords/RegistroMasivoPage.tsx:164` | `next === day`: no caller passes the current day (week buttons always move, "Ir a hoy" shows only when `day !== today`, the toggle passes null for the selected day). |

### Already established earlier in the same flow (11)

The `??` / ternary is there for TypeScript, which cannot follow the earlier
check.

| Where | Why |
|:--|:--|
| `apps/web/src/features/dashboard/DashboardPage.tsx:161` | `shownOwedCents ?? 0`: `tileValue` only calls the callback when the value is not null. |
| `apps/web/src/features/marketing/LandingPage.tsx:1536` | `phone.ok ? … : …`: `validateDemo` already refused a phone that is not ok. |
| `apps/web/src/features/sales/SaleFormDialog.tsx:309` | `"menos"`: the warning needs `available !== null`, which needs the chosen product in the list. |
| `apps/web/src/features/settlements/SettlementsPage.tsx:175` | `user?.farm.name ?? …`: the page renders past `can("money.read")` only with a user. |
| `apps/web/src/features/settlements/SettlementsPage.tsx:179` | `user?.farm.timezone ?? …`: same. |
| `apps/web/src/features/payroll/CrewPayrollPage.tsx:1058` | `unitLabel ?? ""`: a quantity exists only with a weighed line, which carries a unit. |
| `apps/web/src/features/payroll/CrewPayrollPage.tsx:1165` | `paidCents ?? 0`: a done row always has `grossCents` (settle) or `paidCents` (pay) set by `runSettlements` / `runPayments`. |
| `apps/web/src/features/workrecords/WeighingForm.tsx:272` | `?? []`: `plotId` is only ever an id from the loaded `plots`. |
| `apps/web/src/features/workrecords/WeighingForm.tsx:279` | `?? ""`: same. |
| `apps/web/src/features/workrecords/WeighingForm.tsx:303` | `?? ""`: same. |
| `apps/web/src/features/workrecords/planilla.ts:90` | `records ?? 1`: a cell with `recordId` is always written with `records: 1`; the field is optional in `SheetCell`. |

### Cannot fail in this runtime (3)

| Where | Why |
|:--|:--|
| `apps/web/src/lib/passkeys.ts:82` | `codePointAt(i) ?? 0` with `i < length` is never undefined. |
| `apps/web/src/features/workers/WorkerPerformance.tsx:408` | `?? 10`: `n = max / 10^floor(log10 max)` is in [1, 10] for any finite positive `max`, and 10 is in `steps`. |
| `apps/web/src/lib/appVersion.ts:22` | `"dev"`: Vite's `define` always injects a non-empty `__APP_BUILD__`. The fallback is for bundles built without Vite. |

### Fixed since the measurement

`apps/web/src/features/documents/documents.ts:289` (the deduction line of
the WhatsApp receipt) was reachable; `documents.led.test.ts` now covers it.

## Keeping it honest

- **Adding an entry** needs a reason a reviewer can check against the code:
  which earlier check, which library guarantee, which disabled control. "Hard
  to test" is not a reason; that item goes under a "Reachable, not yet
  covered" heading until it has a test.
- **Removing a guard to gain coverage is not allowed.** The guards in the
  "deliberately kept" tables were restored in review for that reason.
- **Line numbers drift.** A PR that moves a listed line updates this file; a
  PR that covers one removes its row.
