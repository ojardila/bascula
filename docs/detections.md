# Detections — what pages, and why

The short list agreed before any dashboard (issue #312). The emission side
already existed — `login_failures`, `mcp_audit`, the API's `slog` lines — and
the limiter held during the 200-passwords exercise
([audits.md](audits.md#the-door-with-no-counter-was-the-one-everybody-knocks-on)).
What was missing was somebody hearing about it while it happened. This page is
the catalog; the list grows in follow-ups once the plumbing is proven.

## The pipeline

```
handler (the event already happens here)
   │  s.loginRefused / mcpOutcomeSignal / oauthErrorSignal / watchServerErrors
   ▼
internal/secalert  ── sliding window per (signal, key), threshold, cooldown
   │                  └─ log line: WARN "security alert" signal=… key=… count=…
   ▼
internal/mailer (the same Resend SMTP relay as the security notices)
   ▼
operator inbox  ── SECURITY_ALERT_EMAIL
```

**Why in the API and not Alertmanager.** The cluster runs kube-prometheus-stack
(Prometheus, Alertmanager, Grafana) but the API exports no metrics and there is
no log pipeline (no Loki), so an Alertmanager route would first need a metrics
endpoint, a ServiceMonitor per farm namespace and SMTP credentials copied into
`monitoring`. The API already has a working mailer, already sees every event at
the moment it happens, and one replica per stack makes in-memory windows exact
enough. Moving the counters to Prometheus is a follow-up if dashboards need
history; the signals and thresholds below do not change when that happens.

**Destination.** `SECURITY_ALERT_EMAIL`, read from ConfigMap `bascula-mail`
key `security-alert-to`. That ConfigMap lives in `bascula-shared` (gitops repo,
`apps/bascula-mail`) and Kyverno clones it into `bascula`, `bascula-dev` and
every `bascula-{slug}`, so one address covers every stack. The subject names
the stack (`bascula.engp.io`, `bascula.int.dev.engp.io`, a farm slug).
Unset, nothing is sent and nothing changes.

**Noise budget.**

- A key that alerted stays quiet for **1 h** (per signal and key). The
  200-passwords burst is one email, not two hundred.
- At most **10 alert emails per hour** leave a stack, across every key. A
  spray from many addresses is a few emails plus the log.
- At most 10 000 keys are tracked; beyond that the overflow is counted under
  the key `overflow`, which pages like any other.

**Silence / ack for a planned drill.** Set `security-alert-silence-until` (RFC
3339, e.g. `2026-10-03T18:00:00Z`) in the stack's `bascula-mail` and restart
the API. Crossings are still logged with `silenced=true`, so the drill leaves
evidence; nothing is mailed until the instant passes. An unplanned page is
acked by the cooldown itself: it will not repeat for that key within the hour.
A silence that does not parse is a startup warning, never a failed boot.

## Signals

| # | Signal | Key | Threshold | Status |
|:--|:--|:--|:--|:--|
| 1 | `login_refusals` | client IP | 30 in 5 min | wired |
| 2 | `mcp_failures` | user | 10 in 10 min | wired |
| 3 | `server_errors` | Host (farm) | 10 in 5 min | wired |
| 4 | `oauth_errors` | OAuth client | 20 in 15 min | wired |
| 5 | repeated 401 after refresh | session | — | follow-up |

Thresholds sit far above what a person produces: the login limiter itself
refuses at 10 per (address, IP) and 50 per IP in 15 min, so a person who
forgot a password is refused long before they page anybody.

### 1. `login_refusals` — password guessing / credential stuffing

- **Counts:** every refused sign-in — wrong password, wrong passkey, wrong
  current password on a change, the OAuth sign-in form — **and** every refusal
  by the limiter (429). The limiter stops writing rows once it is full, so the
  table alone undercounts a burst; the alert does not.
- **Query (evidence):**
  ```sql
  SELECT ip, lower(email) AS email, count(*), min(at), max(at)
    FROM login_failures
   WHERE at > now() - interval '15 minutes'
   GROUP BY 1, 2 ORDER BY 3 DESC;
  ```
- **Response:** the limiter is already refusing the IP. Confirm in the query
  above; if it persists or rotates, block at Cloudflare (WAF rule on the IP or
  ASN). If one address is targeted from many IPs, tell its owner — never lock
  the address (see `store.CountLoginFailures`).

### 2. `mcp_failures` — an assistant's writes keep failing

- **Counts:** `mcp_audit.outcome` in (`failed`, `refused`) per user.
- **Query:**
  ```sql
  SELECT user_id, client_id, tool, outcome, count(*), max(created_at)
    FROM mcp_audit
   WHERE outcome <> 'done' AND created_at > now() - interval '1 hour'
   GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC;
  ```
- **Response:** read the summaries; if the writes are not what the owner
  meant, revoke the connector (Ajustes → Asistentes) and tell the owner.

### 3. `server_errors` — a 5xx burst on `/v1`

- **Counts:** any response ≥ 500 on `/v1/**`, including a recovered panic,
  keyed by Host (on the shared platform each farm has its own address; a
  dedicated stack is one farm).
- **Query (logs):** `kubectl -n <ns> logs deploy/bascula-api | grep '"msg":"server error"'`
- **Response:** if it began with a release, roll back (pin the previous tag in
  gitops); otherwise follow [incident-response.md](incident-response.md).

### 4. `oauth_errors` — authorize requests bounced with an error

- **Counts:** `/oauth/authorize` answering the client with `error=` (bad PKCE,
  wrong resource, unknown redirect…), keyed by `client_id`.
- **Query (logs):** connector lines, `grep '"path":"/oauth/'` on the API log.
- **Response:** a broken connector shows one client failing the same way; a
  probe shows many clients or many redirect URIs. Remove a hostile client's
  registration; tell the owner of a broken one.

### 5. Repeated 401 after a refresh — follow-up

Not wired in this slice: the refresh path rotates tokens and its reuse
detection already revokes the family, so the signal needs care to page on an
attack and not on a phone waking up with a stale token. Tracked on #312.

## Dashboards — follow-up

Grafana is on the cluster (`monitoring` namespace) with Prometheus only. Until
the API exports these counters (or logs are shipped), the SQL above is the
dashboard: each alert email carries the key to paste into it.

## Tabletop: the 200-passwords replay

`internal/apitest/security_alerts_test.go` replays docs/audits.md: 200 wrong
passwords at one address from one IP against a server with an alerter. All 200
are refused, exactly **one** email reaches the operator naming the IP, and the
rows are in `login_failures`. `internal/secalert` tests the window, cooldown,
hourly budget, silence and key-spray bound with a fake clock.

Against a real stack (dev):

```
for i in $(seq 1 40); do
  curl -s -o /dev/null -w '%{http_code}\n' https://bascula.int.dev.engp.io/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"drill@example.com","password":"wrong-'$i'"}'
done
kubectl -n bascula-dev logs deploy/bascula-api | grep 'security alert'
```
