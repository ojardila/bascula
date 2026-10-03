# RFC 0001 — Portal telemetry

- **Status**: Draft
- **Author**: @bizoru
- **Date**: 2026-10-03
- **Target repo**: ojardila/bascula
- **Target surface**: `apps/web` (PWA) and `services/api` (Go)

## Summary

Instrument the Báscula PWA and its API with first-party, self-hosted product analytics so the team can answer concrete questions about who uses the app, when, from where, on what, and where they get stuck — without taking on a third-party data processor, without relaxing the current CSP, and without shipping anything that leaks worker PII.

Proposed stack: **PostHog, self-hosted on the existing k3s cluster, reverse-proxied under `/i/` of the same origin that serves `apps/web`**. No session replay in v1, no Microsoft Clarity, no third-party cookies, no change to `apps/web/security-headers.conf`.

The RFC specifies:
- the business questions the instrumentation must answer,
- the event taxonomy (grounded in `services/api/openapi.yaml` and `apps/web/src/features/*`),
- the client/server split and the reason for it,
- how offline-first (`src/offline/queue.ts`) interacts with analytics,
- the Habeas Data posture (Ley 1581 / Decreto 1377),
- the test strategy that produces a red test before the fix (Oscar's bar),
- a gated rollout plan with measurable exit criteria per phase.

## Motivation

Three gaps today:

1. **No way to answer basic product questions**: how many farms performed a weighing yesterday; what fraction of invited workers ever logged in; how long from signup to first weighing; which features of the app see any use beyond onboarding. These answers today require a database query by a developer and are never asked twice.
2. **No feedback loop on UX friction**: `src/offline/OfflineBar.tsx` fires when the device is offline, but we do not know how often; `react-joyride` tours exist (`listTours`, `saveTour`) but we do not know which steps people abandon. Changes ship on vibes.
3. **No signal on growth**: the landing at `/` is public; we do not know referrers, campaign effectiveness, or conversion to signup.

A thin, privacy-respecting telemetry layer closes all three gaps with roughly two engineering days of work.

## Context (so the rest of the RFC is grounded)

- The web is a React 19 + Vite 8 + MUI v9 PWA (`apps/web/package.json`), service-worker-driven (`vite-plugin-pwa`, see `apps/web/vite.config.ts`). Target audience: Colombian coffee farms, mostly on mobile over cellular, often offline.
- The API is Go 1.26 (`services/api`), no CORS middleware (same-origin by design, see the comment at the top of `vite.config.ts`), mounts RequestID / RealIP / Recoverer. Business routes documented in `services/api/openapi.yaml`.
- Tenancy: **farm**. Every signed-in request is scoped to one farm; the admin surface (`adminListFarms`, `adminCreateFarm`) is the only cross-farm view.
- CSP (`apps/web/security-headers.conf`) is intentionally strict: `script-src 'self'`, `connect-src 'self' https://formsubmit.co`. Any script-based telemetry that is **not same-origin** requires loosening it. We will not loosen it.
- Offline queue (`apps/web/src/offline/queue.ts`, `store.ts`, `OfflineContext.tsx`): weighings are written to IndexedDB and uploaded when connectivity returns. The authoritative event therefore cannot be a client-side one.
- Log hardening (`services/api/internal/logsafe/`): there is already a pattern for sanitizing values that came from outside before they hit a log line, enforced by CodeQL's `go/log-injection`. The telemetry layer will use the same package.
- Security alerting (`services/api/internal/secalert/`): there is already an infrastructure for "security signal crossed its threshold" (PR #351). The telemetry layer must hook into it, not duplicate it.
- Habeas Data posture is **already documented** in `docs/data-protection.md` (the authoritative mapping of data categories to tables, retention, and reader roles), with legal templates in `docs/legal/` (`aviso-privacidad-trabajador.md`, `dpa-encargo-tratamiento.md`, `terminos-de-servicio.md`). The farm is the *responsable del tratamiento*; Bascula is the *encargado*. This RFC extends that mapping — it does not reinvent it.
- Decision record `docs/decisions.md` 2026-08-28 §2: the super-admin console **cannot** read a farm's employee data. This constrains what any cross-farm analytics view may display.

## Goals

1. Answer the business questions in the next section without further plumbing.
2. Zero third-party scripts loaded by the browser (same-origin only).
3. Zero PII in any emitted event. Worker names, cédulas, phones, emails never leave the backend.
4. Non-blocking: analytics failure is silent; the app and the API never degrade because PostHog is unreachable.
5. Offline-aware: a weighing recorded while the device is offline produces exactly one authoritative `weighing_recorded` event when (and only when) the server persists it.
6. Oscar's bar: every behavioral claim in the implementation PR is covered by a test that fails without the change.

## Non-goals (v1)

- Session replay. Rural cellular bandwidth and the risk of masking regressions outweigh the value; revisit in a later RFC with a sampling + strict-masking proposal.
- Heatmaps. Covered by the same reasoning. If demand is strong, we add PostHog's heatmap feature (replay-free) in a follow-up.
- Server-side APM / tracing. Separate RFC.
- Marketing attribution modeling beyond last-touch UTM.
- Native mobile analytics (the PWA is the only client today).

## Business questions this must answer

| # | Question | Primary event(s) |
|---|---|---|
| Q1 | How many farms perform ≥1 weighing on any given day? | `weighing_recorded` grouped by `farm` |
| Q2 | What is the median time from `signup_completed` to first `weighing_recorded`? | funnel |
| Q3 | What fraction of invited workers reach `invite_accepted`? And then `first_login`? | funnel |
| Q4 | Does Modo cosecha (`setHarvestMode`) correlate with more weighings per operator per day? | cohort |
| Q5 | What percentage of weighings are logged while offline (`offline_queue_flushed` originator) vs online? | property breakdown |
| Q6 | Which `features/*` modules see use beyond onboarding (payroll, settlements, expenses, reports, documents)? | `page_viewed` + named events |
| Q7 | Where in the onboarding tour do new owners drop? | `onboarding_tour_step` + `onboarding_tour_completed` |
| Q8 | What devices and OS versions do operators actually use (so we know what to test against)? | autocaptured properties |
| Q9 | Where are users geographically (country/region, no finer)? | derived from inbound request, server-side only |

These nine questions are the acceptance criteria for v1. If a dashboard answering them exists at end of rollout, v1 is done.

## Event taxonomy

### Authoritative events (emitted from `services/api`)

The ground truth about the business lives here. The server emits these when, and only when, the corresponding row is persisted.

| Event | Fired by | Properties (non-PII) |
|---|---|---|
| `signup_completed` | `operationId: signup` handler | `farm_id` (hashed), `source` (invite / public) |
| `email_verified` | `operationId: verifyEmail` | `farm_id`, `hours_since_signup` |
| `password_reset_completed` | `operationId: resetPassword` | `farm_id` |
| `passkey_added` | `operationId: createPasskey` | `farm_id`, `passkey_count_after` |
| `invite_sent` | `operationId: inviteUser` | `farm_id`, `role` |
| `invite_accepted` | invite→signup join | `farm_id`, `role`, `hours_since_invite` |
| `role_changed` | `operationId: setUserRole` | `farm_id`, `role_before`, `role_after` |
| `farm_suspended` | `operationId: adminSetFarmStatus` | `farm_id`, `reason_code` |
| `farm_reactivated` | same, inverse | `farm_id` |
| `harvest_mode_set` | `operationId: setHarvestMode` | `farm_id`, `enabled` |
| `weighing_recorded` | weighing persistence handler | `farm_id`, `was_offline` (bool), `age_at_upload_seconds`, `worker_count_on_batch` |
| `batch_created` | batches handler | `farm_id`, `size` |
| `pickup_logged` | pickups handler | `farm_id`, `kilograms_bucket` (categorical, not raw) |
| `settlement_closed` | settlements handler | `farm_id`, `period_days` |
| `payroll_generated` | payroll handler | `farm_id`, `worker_count_bucket`, `period_days` |
| `security_signal_fired` | `services/api/internal/secalert` | `signal_id`, `severity`, `farm_id` (hashed) |

### UX events (emitted from `apps/web`)

Signals about the UI. Lower trust (device clock, user can disable JS, offline), but necessary for Q5–Q8.

| Event | Fired by | Properties |
|---|---|---|
| `page_viewed` | React Router v7 listener in `App.tsx` | `path`, `route`, `is_authenticated` |
| `onboarding_tour_step` | `react-joyride` callback | `tour_id`, `step_index`, `action` |
| `onboarding_tour_completed` | same | `tour_id` |
| `offline_banner_shown` | `OfflineBar.tsx` effect | — |
| `offline_queue_flushed` | `offline/queue.ts` on drain | `drained_count` |
| `report_viewed` | reports feature | `report_id` |
| `price_book_edited` | prices feature | — |

No property in any of these ever carries a cédula, name, email, phone, address, GPS point, or free-text field.

### Autocaptured properties (on every event, server- and client-side)

- `distinct_id` — `sha256(SALT || user_id)`. SALT lives next to the DB password in the secret store, never rotated (rotation would break historical linkage).
- `device`, `os`, `browser`, `viewport`, `connection` — client, from `navigator.*`.
- `country`, `region` — server, from `RealIP` + MaxMind lookup; **not** per-event IP.
- `app_build` — client, from `__APP_BUILD__` (already defined in `vite.config.ts`).
- `api_version` — server, from `services/api/VERSION`.
- `$groups: { farm: <hashed farm_id> }` — PostHog group analytics. Every event in both surfaces carries this.
- `is_authenticated: bool` — client only; the server surface implies true by definition.

## Stack

### Primary: PostHog, self-hosted

Deployment target: existing k3s cluster, PostHog's official Helm chart, Postgres + ClickHouse managed inside the chart initially. Reverse-proxied at `/i/` from the same ingress that serves `apps/web`.

Why self-hosted:
1. **CSP stays `script-src 'self'`.** The client SDK is loaded from `/i/static/array.js`; events post to `/i/e/`. No new origin, no browser cookie banner for third-party cookies (there are none).
2. **Data residency.** Weighing patterns, farm identities (even hashed) and worker counts stay on infrastructure Oscar controls. Ley 1581 compliance is easier because there is no processor to disclose beyond `ojardila/bascula`.
3. **No per-event cost.** PostHog cloud free tier (1M events/mo) looks generous until a few farms with hourly weighing seasons eat the quota in a weekend.
4. **Group analytics by farm** without paying for the Cloud Enterprise tier.

Why **not** PostHog Cloud (even as a stopgap):
- Loosens CSP to `connect-src https://us.i.posthog.com` or `eu.i.posthog.com`.
- Adds a US (or EU) data processor to the Habeas Data disclosure.
- Not operationally simpler by much — the Helm chart is one `helm install`.

### Explicitly rejected: Microsoft Clarity

Clarity would give us session replays and heatmaps for free, forever. We're not using it in v1 because:

1. **CSP relaxation required** for `www.clarity.ms` + `c.clarity.ms` in `script-src` and `connect-src`.
2. **Masking defaults are not safe enough** for a form that renders worker cédulas (`WeighingForm.tsx`). The default masks inputs but not computed text nodes; a bug in a masking selector leaks PII into a US-hosted replay.
3. **Rural cellular bandwidth cost** of recording a 10-minute weighing session on 3G is unacceptable product-side.
4. **Third-party processor** compounds the Habeas Data story for no v1-critical gain.

### Explicitly rejected: GA4

- No native funnels worth the name at this scale.
- Sampling kicks in as traffic grows.
- Hostile cross-origin fetches that would require CSP exceptions.
- Property model is awkward for product analytics.

### Explicitly rejected: a custom pipeline (ClickHouse + Grafana)

- 10× the implementation effort for a worse analyst UX.
- Reconsider only if PostHog self-host turns out to carry an unacceptable ops burden (which, given the k3s cluster already runs Postgres and ClickHouse workloads, it should not).

## Design

### Deployment topology

```
                    farm.bascula.engp.io
                            │
                     nginx (apps/web pod)
                            │
                    ┌───────┴───────┬──────────┐
                    ▼               ▼          ▼
                 /          /v1, /health      /i
            app shell       Go API         PostHog
          (precached)   (same-origin)   (same-origin,
                                         rewritten path)
```

PostHog gets a dedicated Service and a reverse-proxy block in `nginx.conf` that rewrites `/i/*` to the PostHog service inside the cluster. The browser sees nothing but `/i/...` on the farm's own origin.

### Client wrapper (`apps/web/src/analytics/`)

**New files**, grounded in the existing conventions of `apps/web/src/lib/*.test.ts`:

```
apps/web/src/analytics/
  index.ts            # loadAnalytics(), track(), identify(), reset()
  events.ts           # one typed function per named UX event
  scrubPII.ts         # regex + property allowlist
  index.test.ts       # red-then-green
  scrubPII.test.ts    # red-then-green
```

Design rules:

1. `loadAnalytics()` is called from `App.tsx` after the first paint. It `import()`s the PostHog SDK dynamically so the landing page never pays the ~70 kB cost.
2. `track()` and `identify()` always route through `scrubPII()`. The scrubber:
   - Rejects any string property whose value matches a Colombian cédula regex (`^\d{6,10}$` conservatively).
   - Rejects properties whose keys match an allowlist complement (allowlist of ~20 keys; anything else is dropped and logged at warn).
   - Produces a typed error in tests so the red test is explicit.
3. The AuthContext calls `identify(hashedId, { farm: hashedFarmId })` after a successful `operationId: me` response. On logout, `reset()` fires.
4. All public functions catch and swallow their own errors. `track()` never throws into app code.

### Server wrapper (`services/api/internal/telemetry/`)

**New package**, structured like `services/api/internal/logsafe/` and `services/api/internal/secalert/`:

```
services/api/internal/telemetry/
  posthog.go      # typed client, batches, context-aware
  scrub.go        # mirror of apps/web scrubPII
  events.go       # one typed Emit* per authoritative event
  posthog_test.go # red-then-green
  scrub_test.go   # red-then-green; mirrors the JS cases
```

Design rules:

1. The client is injected through the handler struct that already carries `secalert.Emitter`. No globals.
2. `Emit` takes a context; if the context is cancelled the event is dropped (not blocked, not retried).
3. All inbound-origin strings pass through `logsafe.Str` before becoming a property value, same posture as logging.
4. The telemetry client lifetime is tied to the API process; it buffers up to N events and flushes on shutdown, matching how the existing logger drains.
5. The authoritative events in the taxonomy table are emitted at the end of their handlers, after commit, before response write. If the handler fails, no event.

### Offline interplay

- `apps/web/src/offline/queue.ts` persists weighings in IndexedDB. On a successful upload, it already dispatches a context event; we add a `offline_queue_flushed` emission there with `drained_count`.
- The **authoritative** `weighing_recorded` is server-side (persisted row). Its `was_offline` property is derived from the upload payload (which already carries a client-side timestamp), and `age_at_upload_seconds = server_now - client_ts`. The server, not the client, decides what "offline" means.
- The client-side `weighing_recorded_local` is deliberately **not** in the taxonomy: duplicate counting with the authoritative event is worse than losing the client-side signal.

### Multi-tenancy (farm scoping)

- Every event carries `$groups: { farm: <hashed farm_id> }`.
- PostHog group dashboards are configured per-farm; farm owners see only their farm via a scoped project token.
- Platform admins (ojardila and bizoru today) see cross-farm.
- The hashed farm_id is derived server-side with the same salt as `distinct_id`, so joins work.

### Privacy posture (Habeas Data / Ley 1581 / Decreto 1377)

This section extends `docs/data-protection.md`. The implementation PR updates that file in the same commit as the code — same convention CI already enforces for `docs/database.md`.

- **New data category to add to `docs/data-protection.md`.** "Analytics events — PostHog (self-hosted)": lives outside Postgres in a dedicated ClickHouse; columns are the event taxonomy of this RFC; readers are platform admins only; retention policy stated below. Who can read it: never a farm's workers' PII (there is none), always aggregated by `farm` group, with the super-admin cross-farm view scoped to counts and times, in line with `docs/decisions.md` 2026-08-28 §2.
- **Encargado chain unchanged.** Self-hosted PostHog runs under the same operator (`Operador` in `docs/legal/dpa-encargo-tratamiento.md`). No sub-encargado is introduced; the DPA signed with each farm does not need an Art. 25 Decreto 1377 amendment to list a new third party. **PostHog Cloud would add a sub-encargado and therefore would require a DPA amendment** — a second reason to self-host.
- `distinct_id = sha256(SALT || user_id)`, SALT stored next to the DB password, server-only, never rotated.
- `farm_id` in events: hashed the same way, same salt.
- No cédula (`doc_id`), name, `last_name`, phone, address, city, municipality, country, photo_id, or free-text field (`employee_notes.body`, `work_records.note`) in any event. Enforced in two places (client and server scrubber) with mirrored test suites and a static grep guard in CI.
- `ip: false` in PostHog init on the client; server-side events never include the request IP.
- Country/region derived server-side from the inbound IP, then **the IP is dropped before emission**.
- Retention: **180 days**. Covers one harvest cycle (6 months) with margin, meets the minimization principle of Decreto 1377 Art. 11. Configurable in PostHog's project settings; this RFC is the decision record and the number is added to `docs/data-protection.md`.
- **Worker privacy notice** (`docs/legal/aviso-privacidad-trabajador.md`) does not require an update: workers' personal data never enters the telemetry pipeline.
- **Terms of service** (`docs/legal/terminos-de-servicio.md`) and **DPA** (`docs/legal/dpa-encargo-tratamiento.md`): both already list `docs/data-protection.md` as the technical annex. Updating that annex is sufficient; neither template changes.
- **Signup-time acceptance is still pending** across the whole legal stack (see `docs/data-protection.md#what-is-pending`). This RFC does not block on that work; the telemetry rollout proceeds while that signup-acceptance work continues on its own track.
- Deletion flow (Art. 15 Ley 1581 → `docs/data-protection.md`'s "Rights" rows): the existing worker-deletion path is a soft delete and does not touch telemetry (no worker PII in it anyway). The owner-deletion path, when it lands, calls PostHog's admin delete-by-distinct-id in the same transaction.

### CSP

No change required. The reverse-proxy under `/i/` is same-origin from the browser's point of view, satisfying `script-src 'self'` and `connect-src 'self'`.

### Bundle size

- PostHog JS core: ~70 kB gzipped. +40 kB for autocapture.
- Loaded via dynamic `import()` after first paint. The landing at `/` does not pay the cost (visitors who are not operators do not need to be tracked by the product tool; marketing analytics for the landing is out of scope for v1).
- Added to the Vite `manualChunks` as its own chunk (`analytics`), to isolate it from the `react` and `mui` chunks that are cached per-release.

### Rollout plan

| # | Phase | Exit criterion | Effort |
|---|---|---|---|
| 0 | RFC approved | this PR merged | — |
| 1 | PostHog deployed on k3s under `/i/` | smoke event visible in the UI within 60 s of install | 1 d |
| 2 | Client wrapper + `page_viewed` + `offline_banner_shown` + `offline_queue_flushed` | red tests merged, events appear scoped by `farm` in a staging dashboard | 3 h |
| 3 | Server wrapper + `signup_completed` + `weighing_recorded` | both events fire from the API within a request handler; red tests pass | 4 h |
| 4 | Remaining named events | all events in the taxonomy fire from the right surface | 3 h |
| 5 | Dashboards for Q1–Q9 | one PostHog dashboard per question, linked from the ops wiki | 2 h |
| 6 | Flag flip in prod behind `telemetry.enabled` | 24 h of production use with no regression in the API error-rate dashboard attributable to telemetry | 30 min |
| 7 | Retro | docs updated, follow-up RFCs filed for replay/heatmaps if demanded | 1 h |

Total: **~2 engineering days** of real work.

## Testing (meeting Oscar's bar)

Every claim in the implementation PR has a test that fails without the change. Concretely:

### Client (`apps/web/src/analytics/`)

- `scrubPII.test.ts`:
  - Red fixture: an event payload with a `cedula: "1234567890"` property.
  - Assertion: `scrubPII(payload)` returns an object without the `cedula` key, and the function reports a `scrubbed: ["cedula"]` audit list.
  - Rejects allowlist-complement keys: `scrubPII({ email: "x@y" })` strips `email`.
  - Rejects values that match the cédula regex regardless of key name: `scrubPII({ note: "1098765432" })` strips `note`.
- `index.test.ts`:
  - Red: calls `track("weighing_recorded", {...})` before `loadAnalytics()` → verifies the call is a silent no-op (no throw, no `posthog.capture`).
  - Green: after `loadAnalytics()`, verifies one `posthog.capture` with the exact event name, the hashed `distinct_id`, the hashed farm in `$groups`, and no scrubbed key present.

### Server (`services/api/internal/telemetry/`)

- `scrub_test.go` mirrors the JS cases table-for-table; a divergence between the two is itself a test failure.
- `posthog_test.go`:
  - Red: handler emits `weighing_recorded` with a cédula in its property set; test fakes the PostHog HTTP endpoint; test asserts the sent payload has no cédula.
  - Green: with the scrubber active, the test passes.
  - Context cancellation: `Emit(ctxCancelled, event)` returns without a network call.

### Integration (`apps/web/e2e/`)

- New file `apps/web/e2e/analytics.test.ts` beside the existing `harvest.test.ts` / `payroll.test.ts`:
  - Spins up the API (same pattern as `live-api.test.ts`), performs a signup, asserts the API-local PostHog mock received a `signup_completed` with the expected properties.
  - The API-local PostHog mock is a tiny HTTP server stood up in `services/api/internal/apitest/`, same style as the existing fakes there.

### Static

- CI gets a `grep` guard: no file under `apps/web/src/analytics/` or `services/api/internal/telemetry/` imports a known PII column name (`cedula`, `nombre`, `nombres`, `email`, `telefono`). Fails the build if violated.
- Bundle size CI check: a Vite plugin emits per-chunk sizes to `dist/sizes.json`; CI diffs against `origin/master` and fails if `analytics` chunk grows beyond a budget set in this PR.

## Risks

| Risk | Mitigation |
|---|---|
| PII leaked into an event property | Mirrored scrubber on both sides + static grep guard + property allowlist |
| PostHog outage degrades the app | Non-blocking emit on both sides; `track()` and `Emit()` never throw into app code |
| Bundle size regression | Lazy-loaded chunk + CI size check |
| CSP broken on deploy | Reverse-proxy under same origin; no CSP change in v1; snapshot test on the response headers in the nginx config |
| Service worker fires events the main thread misses | Authoritative events are server-side; client-side is UX signal only |
| Habeas Data complaint from a worker about their data | Documented deletion flow via PostHog admin API + 180-day retention + privacy-policy update in the same PR as the rollout flag flip |
| Mock PostHog in e2e drifts from the real wire format | PostHog ships an OpenAPI; the mock derives its validator from that spec |
| ClickHouse ops burden on k3s | Start on PostHog's self-managed-with-ClickHouse Helm config; revisit externalising ClickHouse if disk pressure appears |

## Open questions for Oscar

1. Is self-hosted PostHog acceptable given the ops burden, or do you want to start on PostHog Cloud (EU) and plan a migration? My strong vote is self-hosted from day one.
2. Is **180-day retention** the right number given one harvest cycle, or do you want **365**?
3. Which farm is the pilot — your demo farm, or a known internal test farm?
4. Who owns the dashboards after v1 ships — you alone, both of us, or a product role you intend to hire?
5. Should the landing page (`/`) stay instrumentation-free, or do we add a minimal `landing_viewed` event (no cookies, no fingerprint, counted server-side from the already-handled HTTP request)?

## Appendix A: Minimal wiring

```ts
// apps/web/src/analytics/index.ts (shape, not final)
import type { PostHog } from "posthog-js";
import { scrubPII } from "./scrubPII";

let ph: PostHog | null = null;

export async function loadAnalytics(): Promise<void> {
  if (ph) return;
  const { default: posthog } = await import("posthog-js");
  posthog.init("<project-key>", {
    api_host: "/i",
    ui_host: "/i",
    persistence: "localStorage",
    ip: false,
    autocapture: true,
    capture_pageview: false, // we fire these ourselves from the Router
    disable_session_recording: true,
  });
  ph = posthog;
}

export function identify(distinctId: string, farmId: string): void {
  ph?.identify(distinctId, {}, { $groups: { farm: farmId } });
}

export function track(event: string, props: Record<string, unknown> = {}): void {
  if (!ph) return;
  const { safe } = scrubPII(props);
  try {
    ph.capture(event, safe);
  } catch {
    // non-blocking by contract
  }
}

export function reset(): void {
  ph?.reset();
}
```

```go
// services/api/internal/telemetry/posthog.go (shape, not final)
package telemetry

import (
    "context"
    "net/http"

    "github.com/ojardila/bascula/services/api/internal/logsafe"
)

type Client struct {
    endpoint string
    http     *http.Client
    buf      chan event
}

type event struct {
    name  string
    props map[string]any
}

func (c *Client) Emit(ctx context.Context, name string, props map[string]any) {
    if ctx.Err() != nil {
        return
    }
    safe, _ := Scrub(props)
    for k, v := range safe {
        if s, ok := v.(string); ok {
            safe[k] = logsafe.Str(s)
        }
    }
    select {
    case c.buf <- event{name: name, props: safe}:
    default: // non-blocking by contract
    }
}
```

## Appendix B: Files touched by the implementation PR

New:
```
apps/web/src/analytics/{index,events,scrubPII}.ts
apps/web/src/analytics/{index,scrubPII}.test.ts
apps/web/e2e/analytics.test.ts
services/api/internal/telemetry/{posthog,scrub,events}.go
services/api/internal/telemetry/{posthog,scrub}_test.go
services/api/internal/apitest/posthog_fake.go
```

Modified:
```
apps/web/src/App.tsx                     # loadAnalytics() after first paint; Router listener → page_viewed
apps/web/src/auth/AuthContext.tsx        # identify() on me-success; reset() on logout
apps/web/src/offline/queue.ts            # emit offline_queue_flushed on drain
apps/web/src/offline/OfflineBar.tsx      # emit offline_banner_shown on mount
apps/web/vite.config.ts                  # manualChunks → analytics
apps/web/nginx.conf                      # /i/* reverse proxy block
services/api/internal/httpapi/*.go       # Emit calls at the authoritative points in the taxonomy
services/api/internal/secalert/*.go      # hook security_signal_fired into the Emit path
services/api/cmd/*                       # wire telemetry.Client into the handler struct
docs/rfcs/0001-portal-telemetry.md       # this file
infra/helm/posthog/                      # separate PR
```

Documentation updated in the same PR as the code (same convention `make db-diagram` + CI already enforces for `docs/database.md`):
```
docs/data-protection.md     # add «Analytics events — PostHog (self-hosted)» section
docs/decisions.md           # one dated entry: self-hosted PostHog, 180-day retention, no cloud, no replay in v1
```

Not modified: `apps/web/security-headers.conf` (CSP stays as it is), `docs/legal/{aviso-privacidad-trabajador,dpa-encargo-tratamiento,terminos-de-servicio}.md` (worker PII does not enter telemetry; data-protection.md as the technical annex is the only point of update).
