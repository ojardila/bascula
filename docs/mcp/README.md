# Báscula MCP server

Báscula exposes its API to AI assistants (ChatGPT, Claude and any other
[Model Context Protocol](https://modelcontextprotocol.io) client) as a set of
**tools**. An assistant connected to a farm can answer questions such as "how
many kilos did Pedro pick this week?" or "who do I owe money to?", and — within
the caller's role — record weighings, payments and settlements.

- **Interactive tool reference:** [`/mcp/docs`](https://bascula.engp.io/mcp/docs)
  on every host (for example
  [san-jose.bascula.engp.io/mcp/docs](https://san-jose.bascula.engp.io/mcp/docs)),
  with a «Try it» panel. The same catalogue as JSON:
  [`/mcp/tools.json`](https://bascula.engp.io/mcp/tools.json).
- Guides: [Connect ChatGPT](connect-chatgpt.md) ·
  [Connect Claude](connect-claude.md) · [OAuth reference](oauth.md) · [Security](security.md) ·
  [Troubleshooting](troubleshooting.md)
- Code: `services/api/internal/httpapi/handlers_mcp.go` (read tools, server),
  `handlers_mcp_write.go` (write tools, two-step confirmation),
  `handlers_oauth.go` (OAuth 2.1), `handlers_mcp_docs.go` + `mcp_docs.html`
  (the reference page), `handlers_mcp_page.go` (the Spanish page a person sees
  when opening `/mcp` in a browser), `handlers_mcp_connections.go`
  (`GET/DELETE /v1/mcp/connections`, the «Conexiones» card).

## How it works

The MCP server is mounted on the same Go process that serves `/v1`. It is
**not a second API**: every tool is a name, a description, a JSON Schema and an
existing route. When a tool is called, the server builds an ordinary HTTP
request against its own router, carrying the caller's `Authorization` header,
and returns whatever the route answered. That inner request goes through the
same chain as any other — authentication, tenant (farm), the permission table
(`auth.Matrix`), row-level security — so:

- a tool can do nothing its route cannot;
- a role that gets `403` in the app gets a tool error with the same
  `FORBIDDEN` envelope through MCP;
- the JSON a tool returns is exactly what `services/api/openapi.yaml`
  documents for that route.

Conventions the server announces to every client (its `instructions`, in
Spanish): start with `me` to learn the farm and role; money values are
**integer cents** of the farm's currency; dates are `YYYY-MM-DD` in the farm's
time zone.

**Transport:** MCP streamable HTTP, **stateless** (no `Mcp-Session-Id`), with
JSON responses. `POST /mcp` takes one JSON-RPC 2.0 message and answers it; a
`tools/call` works without a prior `initialize`. `GET /mcp` is not a stream
(`405` from the SDK for clients; a browser asking for HTML gets a help page
with status `401`). The request must send
`Content-Type: application/json` and
`Accept: application/json, text/event-stream`.

```bash
curl -s https://bascula.engp.io/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"me","arguments":{}}}'
```

## Endpoints per host

Every Báscula host serves the same endpoints; what differs is which farm a
sign-in lands on.

| Host | MCP endpoint | Farm |
|---|---|---|
| Main host | `https://bascula.engp.io/mcp` | Chosen at sign-in. An account with one farm goes straight in; an account with several picks one with radio buttons on the consent page. |
| Farm host | `https://<slug>.bascula.engp.io/mcp`, e.g. `https://san-jose.bascula.engp.io/mcp` | Always that farm. The consent page shows «Finca: San José» (farm: San José) and never asks. |

Farm hosts are dedicated stacks (Kubernetes namespace `bascula-<slug>`, pinned
together with production in `ojardila/gitops`
`applications/bascula-tenants.yaml`). Use the token a host issued on that same
host.

Paths on every host:

| Path | What |
|---|---|
| `POST /mcp` | The MCP JSON-RPC endpoint (bearer token required) |
| `GET /mcp/docs` | Interactive tool reference (public, no data) |
| `GET /mcp/tools.json` | Tool catalogue as JSON (public, no data) |
| `GET /.well-known/oauth-protected-resource` (and `/mcp` suffix) | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` (and `/mcp` suffixes) | RFC 8414 authorization-server metadata |
| `POST /oauth/register` | RFC 7591 dynamic client registration |
| `GET/POST /oauth/authorize` | Sign-in and consent page (authorization code + PKCE) |
| `POST /oauth/token` | Code exchange and refresh |
| `POST /oauth/revoke` | RFC 7009 revocation |
| `GET /v1/mcp/connections`, `DELETE /v1/mcp/connections/{id}` | The caller's own assistant connections («Conexiones») |

All of these are routed to the API (the Gateway `HTTPRoute` sends `/mcp`,
`/oauth` and `/.well-known` prefixes to it) and answered with
`Cache-Control: no-store`. The web app's service worker must never answer
them with the app shell — see `apps/web/src/pwa/navigateFallbackDenylist.ts`.

## Authentication

`/mcp` accepts one thing: `Authorization: Bearer <access token>`, where the
token is a Báscula session JWT (HS256, 15-minute lifetime) naming one user, one
farm and one role. Without a valid token `/mcp` answers `401` with a
`WWW-Authenticate: Bearer … resource_metadata="…/.well-known/oauth-protected-resource"`
challenge so a client can discover OAuth.

There are two ways to get that token:

1. **OAuth 2.1** — what ChatGPT and Claude do. The client registers itself
   (dynamic client registration), sends the user to the Báscula sign-in page,
   and gets an access token plus a refresh token (60 days, rotated on every
   use, bound to that client). OAuth access tokens carry `aud: "mcp"` and are
   accepted **only on `/mcp`** — sent straight to `/v1` they get `401`, so an
   assistant's token cannot skip the tools' money confirmation. Details in
   [oauth.md](oauth.md).
2. **`POST /v1/auth/login`** — for scripts, the MCP Inspector or the «Try it»
   panel: `{"email":"…","password":"…"}` returns `accessToken` (15 minutes)
   and `refreshToken`. On `/mcp/docs`, «Use my Báscula session» reuses the
   session of the web app open in the same browser on the same host.

> **There is no long-lived API key in Báscula today.** Nothing in the API
> issues or accepts personal API keys; a pasted bearer is a normal session
> token and expires after 15 minutes. Claude connects with OAuth, like
> ChatGPT — see [connect-claude.md](connect-claude.md).

The OAuth sessions an assistant holds are listed, per user and per farm, in the
web app under «Configuración» (settings) → «Conexiones» (connections), where
they can be revoked.

## Roles

A tool answers according to the role in the token; the page at `/mcp/docs`
shows the allowed roles of every tool, computed from `auth.Matrix`.

| Role (API) | In the app | Through MCP |
|---|---|---|
| `owner` | «Dueño» (owner) | Everything, including the kilo price (`set_kilo_price`). |
| `admin` | «Administrador» (administrator) | Day-to-day running: workers, plots, weighings, balances, payments, advances, settlements, reports, stock, sales, expenses. Cannot change prices. |
| `weigher` | «Pesador» (weigher) | Reads workers (reduced projection), plots, activities (without rates), their own work records, `me`, `farm` (without the price); records weighings. **Never sees money** — balances, payroll, prices, reports, stock, sales and expenses answer `FORBIDDEN`. |

Write tools check the role **before** doing anything, so a role that may not
pay is never shown a payment preview or given a confirmation token.

### Two-step (money) tools

Tools that move money — `register_payment`, `register_advance`,
`create_settlement`, `void_settlement`, `set_kilo_price` — run in two calls:

1. Called without `confirmationToken`, the tool writes nothing and returns
   `status: "confirmation_required"`, a Spanish `summary`, a `preview` and a
   `confirmationToken` (signed, bound to user, farm, tool and the exact
   arguments; valid 10 minutes).
2. Called again with the **same arguments** plus `confirmationToken`, it
   executes. The token's nonce becomes the id of the row written and the money
   routes are idempotent by id, so a repeated confirmation never pays twice.

The server instructs assistants to show the summary and confirm only after the
user explicitly agrees.

## Tools

40 tools today. This list is a snapshot; the live, always-current
reference with parameters and examples is [`/mcp/docs`](https://bascula.engp.io/mcp/docs).

### Read tools

| Tool | Kind | Route | Roles |
|---|---|---|---|
| [`me`](https://bascula.engp.io/mcp/docs#tool-me) | read | `GET /v1/me` | owner, admin, weigher |
| [`farm`](https://bascula.engp.io/mcp/docs#tool-farm) | read | `GET /v1/farm` | owner, admin, weigher |
| [`list_workers`](https://bascula.engp.io/mcp/docs#tool-list_workers) | read | `GET /v1/workers` | owner, admin, weigher |
| [`get_worker`](https://bascula.engp.io/mcp/docs#tool-get_worker) | read | `GET /v1/workers/{id}` | owner, admin, weigher |
| [`worker_balance`](https://bascula.engp.io/mcp/docs#tool-worker_balance) | read | `GET /v1/workers/{id}/balance` | owner, admin |
| [`worker_ledger`](https://bascula.engp.io/mcp/docs#tool-worker_ledger) | read | `GET /v1/workers/{id}/ledger` | owner, admin |
| [`worker_payables`](https://bascula.engp.io/mcp/docs#tool-worker_payables) | read | `GET /v1/workers/{id}/payables` | owner, admin |
| [`worker_performance`](https://bascula.engp.io/mcp/docs#tool-worker_performance) | read | `GET /v1/workers/{id}/performance` | owner, admin |
| [`list_plots`](https://bascula.engp.io/mcp/docs#tool-list_plots) | read | `GET /v1/plots` | owner, admin, weigher |
| [`list_activities`](https://bascula.engp.io/mcp/docs#tool-list_activities) | read | `GET /v1/activities` | owner, admin, weigher |
| [`list_work_records`](https://bascula.engp.io/mcp/docs#tool-list_work_records) | read | `GET /v1/work-records` | owner, admin, weigher |
| [`pending`](https://bascula.engp.io/mcp/docs#tool-pending) | read | `GET /v1/pending` | owner, admin |
| [`list_balances`](https://bascula.engp.io/mcp/docs#tool-list_balances) | read | `GET /v1/balances` | owner, admin |
| [`list_settlements`](https://bascula.engp.io/mcp/docs#tool-list_settlements) | read | `GET /v1/settlements` | owner, admin |
| [`get_settlement`](https://bascula.engp.io/mcp/docs#tool-get_settlement) | read | `GET /v1/settlements/{id}` | owner, admin |
| [`get_payment`](https://bascula.engp.io/mcp/docs#tool-get_payment) | read | `GET /v1/payments/{id}` | owner, admin |
| [`week_price`](https://bascula.engp.io/mcp/docs#tool-week_price) | read | `GET /v1/prices/weeks/{monday}` | owner, admin |
| [`report_weeks`](https://bascula.engp.io/mcp/docs#tool-report_weeks) | read | `GET /v1/reports/weeks` | owner, admin |
| [`report_week`](https://bascula.engp.io/mcp/docs#tool-report_week) | read | `GET /v1/reports/weeks/{monday}` | owner, admin |
| [`report_crop`](https://bascula.engp.io/mcp/docs#tool-report_crop) | read | `GET /v1/reports/crops/{plotCropId}` | owner, admin |
| [`report_performance`](https://bascula.engp.io/mcp/docs#tool-report_performance) | read | `GET /v1/reports/performance` | owner, admin |
| [`report_anomalies`](https://bascula.engp.io/mcp/docs#tool-report_anomalies) | read | `GET /v1/reports/anomalies` | owner, admin |
| [`report_harvest_curve`](https://bascula.engp.io/mcp/docs#tool-report_harvest_curve) | read | `GET /v1/reports/harvest-curve` | owner, admin |
| [`list_stock`](https://bascula.engp.io/mcp/docs#tool-list_stock) | read | `GET /v1/stock` | owner, admin |
| [`list_products`](https://bascula.engp.io/mcp/docs#tool-list_products) | read | `GET /v1/products` | owner, admin |
| [`list_sales`](https://bascula.engp.io/mcp/docs#tool-list_sales) | read | `GET /v1/sales` | owner, admin |
| [`list_expenses`](https://bascula.engp.io/mcp/docs#tool-list_expenses) | read | `GET /v1/expenses` | owner, admin |
| [`list_customers`](https://bascula.engp.io/mcp/docs#tool-list_customers) | read | `GET /v1/customers` | owner, admin |

### Write tools

| Tool | Kind | Route | Roles |
|---|---|---|---|
| [`create_worker`](https://bascula.engp.io/mcp/docs#tool-create_worker) | write | `POST /v1/workers` | owner, admin |
| [`update_worker`](https://bascula.engp.io/mcp/docs#tool-update_worker) | write | `PATCH /v1/workers/{id}` | owner, admin |
| [`create_plot`](https://bascula.engp.io/mcp/docs#tool-create_plot) | write | `POST /v1/plots` | owner, admin |
| [`register_weighing`](https://bascula.engp.io/mcp/docs#tool-register_weighing) | write | `POST /v1/pickups` | owner, admin, weigher |
| [`register_harvest_week`](https://bascula.engp.io/mcp/docs#tool-register_harvest_week) | write | `POST /v1/work-records/batch` | owner, admin, weigher |
| [`correct_weighing`](https://bascula.engp.io/mcp/docs#tool-correct_weighing) | write | `PATCH /v1/work-records/{id}` | owner, admin |
| [`void_weighing`](https://bascula.engp.io/mcp/docs#tool-void_weighing) | write | `DELETE /v1/work-records/{id}` | owner, admin |
| [`set_kilo_price`](https://bascula.engp.io/mcp/docs#tool-set_kilo_price) | write · two-step | `PUT /v1/prices/base/{monday}` | owner |
| [`register_advance`](https://bascula.engp.io/mcp/docs#tool-register_advance) | write · two-step | `POST /v1/advances` | owner, admin |
| [`register_payment`](https://bascula.engp.io/mcp/docs#tool-register_payment) | write · two-step | `POST /v1/payments` | owner, admin |
| [`create_settlement`](https://bascula.engp.io/mcp/docs#tool-create_settlement) | write · two-step | `POST /v1/settlements` | owner, admin |
| [`void_settlement`](https://bascula.engp.io/mcp/docs#tool-void_settlement) | write · two-step | `POST /v1/settlements/{id}/void` | owner, admin |

## The reference page (`/mcp/docs`)

`GET /mcp/docs` and `GET /mcp/tools.json` are generated at startup from the
same `*mcp.Tool` values registered on the MCP server (`Server.mcpCatalog`),
so names, titles, descriptions, input schemas and annotations are identical to
`tools/list`. For each tool the page adds the API route it maps to, the
permission (`x-action`) and the allowed roles from `auth.Matrix`, a parameters
table built from the JSON Schema, an example `curl`, and a «Try it» panel.

«Try it» posts JSON-RPC to this host's `/mcp` with the token the reader pastes
(kept in `sessionStorage` for the tab only). It has no shortcut into the API:
calls are authorized exactly like ChatGPT's or Claude's. Write tools really
write.

Tests: `internal/httpapi/handlers_mcp_docs_test.go` (catalogue equals the
registry, roles equal `auth.Matrix`, the page embeds it) and
`internal/apitest/mcp_docs_test.go` (catalogue equals a real `tools/list`).
