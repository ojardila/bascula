# OAuth 2.1 for the MCP server — developer reference

ChatGPT's connector UI will not take a pasted bearer token, and Claude's
custom connectors use OAuth too. So Báscula runs a small OAuth 2.1
authorization server on every host. The access token it issues is a Báscula
session JWT like the one `POST /v1/auth/login` issues (one user, one farm, one
role, HS256, 15 minutes) with one difference: it carries **`aud: "mcp"`**, and
the API accepts such a token **only on `/mcp`** (PR #103). Sent straight to
`/v1/…` it gets `401` «this token is for the MCP endpoint (/mcp) only»; the MCP
tools still reach the REST routes in-process, where the two-step money
confirmation lives. Code: `services/api/internal/httpapi/handlers_oauth.go`;
tests: `internal/apitest/oauth_test.go`, `oauth_dcr_test.go`,
`oauth_chatgpt_test.go`, `oauth_farm_pick_test.go`,
`oauth_hardening_test.go`.

`<base>` below is the host the client talks to (`https://bascula.engp.io` or
`https://<slug>.bascula.engp.io`), or `PUBLIC_BASE_URL` when configured. It
is both the issuer and the prefix of every endpoint.

## Flow

```mermaid
sequenceDiagram
    autonumber
    participant C as MCP client (ChatGPT / Claude)
    participant U as User's browser
    participant B as Báscula API (<base>)

    C->>B: POST /mcp (no token)
    B-->>C: 401 + WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource", scope="mcp"
    C->>B: GET /.well-known/oauth-protected-resource[/mcp]
    B-->>C: resource=<base>/mcp, authorization_servers=[<base>]
    C->>B: GET /.well-known/oauth-authorization-server[/mcp] (or openid-configuration)
    B-->>C: endpoints, S256, grant types, auth methods
    C->>B: POST /oauth/register (RFC 7591: redirect_uris, client_name, …)
    B-->>C: 201 client_id (+ client_secret if confidential)
    C->>U: open /oauth/authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256&scope&resource
    U->>B: GET /oauth/authorize
    B-->>U: Sign-in page «Conectar Báscula a un asistente»: client name, destination host, (farm host: «Finca: San José»)
    U->>B: POST /oauth/authorize (email, password)
    alt main host and several farms
        B-->>U: Farm picker (radio buttons, signed ticket, 10 min)
        U->>B: POST /oauth/authorize (ticket, farm_id)
    end
    B-->>U: 302 redirect_uri?code=…&state=…&iss=<base>
    U->>C: code
    C->>B: POST /oauth/token grant_type=authorization_code, code, code_verifier, redirect_uri, client_id
    B-->>C: access_token (JWT, aud=mcp, 900 s), refresh_token, token_type=Bearer, scope
    C->>B: POST /mcp  Authorization: Bearer access_token  (tools/list, tools/call)
    B-->>C: JSON-RPC result (as the user's role, on the chosen farm)
    C->>B: POST /oauth/token grant_type=refresh_token (bound to the client, rotated, single use)
    B-->>C: new access_token + refresh_token
    C->>B: POST /oauth/revoke token=refresh_token (optional)
```

## Discovery

| URL | Document |
|---|---|
| `<base>/.well-known/oauth-protected-resource` and `…/oauth-protected-resource/mcp` | RFC 9728 protected-resource metadata |
| `<base>/.well-known/oauth-authorization-server` and `…/oauth-authorization-server/mcp` | RFC 8414 metadata |
| `<base>/.well-known/openid-configuration` and `…/openid-configuration/mcp` | The same RFC 8414 document (clients probe both; path-suffixed variants exist for issuers with a path) |
| `<base>/.well-known/jwks.json` | `{"keys":[]}` — tokens are HMAC-signed and only verified by Báscula; the empty set satisfies strict OIDC parsers |

Protected-resource metadata: `resource` = `<base>/mcp`,
`authorization_servers` = `[<base>]`, `scopes_supported` = `["mcp"]`,
`bearer_methods_supported` = `["header"]`, `resource_name` = `Báscula`.

Authorization-server metadata (abridged):

```json
{
  "issuer": "<base>",
  "authorization_endpoint": "<base>/oauth/authorize",
  "token_endpoint": "<base>/oauth/token",
  "registration_endpoint": "<base>/oauth/register",
  "revocation_endpoint": "<base>/oauth/revoke",
  "jwks_uri": "<base>/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
  "revocation_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
  "scopes_supported": ["mcp", "offline_access"],
  "authorization_response_iss_parameter_supported": true,
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"]
}
```

`openid` is not offered and no ID token is ever issued; the OIDC-only fields
exist so strict discovery parsers accept the document. All discovery and OAuth
endpoints send permissive CORS headers and answer `OPTIONS` preflights.

## Dynamic client registration — `POST /oauth/register`

RFC 7591. The JSON body is decoded **leniently** and unknown metadata is
ignored (a strict decoder once rejected ChatGPT's registration). Registration
is open (no initial access token), so it is bounded: body at most 64 KB, at
most 10 `redirect_uris` of at most 2 KB each, `client_name` truncated to 80
characters, and 30 registrations per client IP per hour per API process
(beyond that: `429` with `Retry-After: 3600` and
`error=invalid_client_metadata`).

- `redirect_uris` (required): each must be `https`, or `http` only on
  `localhost` / `127.0.0.1` / `::1`; no fragment and no `user:pass@`.
  Otherwise `400 invalid_redirect_uri`.
- `response_types`: only `code` (else `400 invalid_client_metadata`).
- `token_endpoint_auth_method`: `none` (default; public client + PKCE),
  `client_secret_post` or `client_secret_basic`. Anything else
  (`private_key_jwt`, …) is registered as `none`.
- `grant_types`: normalized to `authorization_code` + `refresh_token`.
- `scope`: echoed; defaults to `mcp offline_access`.
- `client_name`: shown on the sign-in page and in «Conexiones»; control,
  bidi-override and zero-width characters are stripped, whitespace collapsed,
  80 characters at most; defaults to `mcp-client`.

Registration is anonymous, so it is capped: 30 per address per hour (per API
process) and 200 per hour platform-wide (counted in Postgres, shared by every
replica); past either, `429`. The request body is limited to 64 KiB and the
metadata kept in the database to 8 KiB.

Answer: `201` with `client_id`, `client_id_issued_at`, the registered
metadata, and — for the two secret methods — `client_secret` with
`client_secret_expires_at: 0` (never expires). Other client fields are echoed
back verbatim, except secret-shaped ones.

## Authorization — `GET/POST /oauth/authorize`

Query (GET) or form (POST): `response_type=code`, `client_id`,
`redirect_uri`, `state`, `code_challenge`, `code_challenge_method`,
`scope`, `resource`.

- `client_id` and `redirect_uri` are required; the client must exist and
  `redirect_uri` must exactly match one it registered. These are checked
  **before** anything is sent to `redirect_uri` (no open redirect). Failures
  render the page with a Spanish message (e.g. «Cliente OAuth desconocido.
  Vuelva a registrar el conector.» — unknown OAuth client, register the
  connector again).
- **PKCE S256 is mandatory.** A missing `code_challenge` or a method other
  than `S256` (the method defaults to `S256` when omitted) redirects to the
  registered client with `error=invalid_request`,
  `error_description=PKCE S256 is required`, `state` and `iss`.
- `GET` renders the sign-in page (Spanish, phone-friendly). Because anyone can
  register a client, it names the client and where the code goes:
  «Aplicación: <client_name>» (application) and «Le devolverá el acceso a:
  <redirect host>» (access will be returned to), with «Si no reconoce ese
  sitio, no escriba su contraseña.» (if you don't recognize that site, don't
  type your password). Then «Correo» (email), «Contraseña» (password),
  «Autorizar» (authorize). The page is sent with `X-Frame-Options: DENY`, a
  CSP with `frame-ancestors 'none'`, and `Referrer-Policy: no-referrer`.
- `POST` checks the password (constant work for unknown emails) under the
  **same failed-login limiter as `/v1/auth/login`** (per email+IP and per IP;
  when exceeded: «Demasiados intentos fallidos. Espere unos minutos e intente
  de nuevo.» — too many failed attempts, wait a few minutes), requires a
  **verified email**, resolves the farm (below), and redirects to
  `redirect_uri?code=…&state=…&iss=<base>` (RFC 9207 `iss` on every
  response). The code is single-use and valid **10 minutes**; expired,
  unexchanged codes are swept.

### Farm selection

A token is always for one farm. The farm is resolved at sign-in:

1. **Farm host** (`<slug>.bascula.engp.io`): the host names the farm. The
   page shows «Finca: <display name>» and never asks. A membership in that farm
   is used; a suspended one fails with «Esa finca está suspendida.» (that farm
   is suspended); no membership fails with «Esa cuenta no pertenece a esta
   finca.» (that account does not belong to this farm). A dedicated farm stack
   whose account has exactly one active membership uses it.
2. **Main host**, with `farm_id` in the form: that membership, if active.
3. **Main host**, one active membership: that farm.
4. **Main host**, several: a second page «Su cuenta tiene varias fincas. Elija
   cuál va a usar el asistente.» (your account has several farms; choose which
   one the assistant will use) with one radio button per farm (`farm_id`) and a
   signed `ticket` proving the password was checked (valid 10 minutes, so the
   password is not re-sent). The user never types a farm UUID.

The role in the token is the user's role on that farm.

## Token — `POST /oauth/token`

Form-encoded. Client authentication: HTTP Basic (`client_secret_basic`, both
halves form-urlencoded) or `client_id` + `client_secret` in the form
(`client_secret_post`), or just `client_id` for a public client. A client
registered with a secret must present it; a wrong secret is always refused
(`401 invalid_client`, with a `Basic` challenge if Basic was tried).

**`grant_type=authorization_code`**: `code`, `code_verifier`,
`redirect_uri`, `client_id` (all required). Codes live 10 minutes and are
stored only as their SHA-256, next to a purpose-bound signed proof of who
signed in (never a bearer token). The code is deleted on first use
**even if PKCE then fails**. `code`/`client_id`/`redirect_uri` must match the
authorization; `SHA256(code_verifier)` must equal the challenge. The
membership is re-checked (suspended or removed → `invalid_grant`). Answer:

```json
{ "access_token": "<JWT, aud=[mcp, <base>/mcp], cid=<client_id>>", "refresh_token": "<opaque>", "token_type": "Bearer",
  "expires_in": 900, "scope": "mcp offline_access" }
```

The session is recorded with the client's id, which is what makes it appear in
«Conexiones» (`GET /v1/mcp/connections`).

**`grant_type=refresh_token`**: `refresh_token`. The refresh token is
**bound to the client it was issued to** (RFC 6749 §6): a `client_id` naming
another client gets `400 invalid_grant` («the refresh token was issued to
another client»), and a confidential client must authenticate even if it omits
`client_id`. Refresh tokens are **rotated and single-use**, with the same
family rules as the mobile app: replaying a used refresh token revokes the
whole family, and two concurrent refreshes of the same token yield exactly
one new session. Only families issued through OAuth are rotated here (a web
or handset refresh token → `invalid_grant`), and an assistant's refresh token
is not accepted by `/v1/auth/refresh`. Refresh tokens live 60 days; the new
access token keeps the same audience. `scope` is omitted from the answer (RFC 6749 §5.1: unchanged). A
bad token → `400 invalid_grant`.

Errors follow RFC 6749 §5.2: `{"error": "...", "error_description": "..."}`.

## Revocation — `POST /oauth/revoke`

RFC 7009. Form: `token`, optional `token_type_hint`, client identification
(`client_id` for a public client; a confidential client must authenticate).
An assistant's refresh token revokes its whole family (the connection
disappears from «Conexiones») — but only when the asking client is the one it
was issued to (another client → `400 unauthorized_client`). A web or handset
session's refresh token presented here is left alone (its door is
`/v1/auth/logout`). An access token is stateless and simply lapses within
15 minutes. `200` for unknown tokens.

Users can also revoke from the app: «Configuración» → «Conexiones» →
«Administrar» → «Revocar conexión» (`DELETE /v1/mcp/connections/{id}`).

## Scopes

`mcp` is the only real scope; `offline_access` is advertised because clients
ask for it to get a refresh token (which is issued regardless). Any requested
scope is accepted and echoed, and **grants nothing extra**: what a token can do
is decided by the user's role on the farm, through `auth.Matrix`, on every
tool call.

## Resource indicators and audience (RFC 8707)

`resource`, when sent to `/oauth/authorize` or `/oauth/token`, must name this
server: `<base>/mcp` or `<base>` (also accepted with the host the request came
to). Anything else → `invalid_target` (on authorize, as a redirect to the
registered `redirect_uri`). Every access token issued through OAuth carries
`aud = ["mcp", "<base>/mcp"]` and `/mcp` refuses a token whose resource is not
itself (`401` + `WWW-Authenticate … error="invalid_token"`): a token obtained
from one farm's address does not open another's. Tokens minted before this
binding (audience `mcp` only) are accepted until they expire.

## Using the token

`POST <base>/mcp` with `Authorization: Bearer <access_token>`. The OAuth
token opens `/mcp` only; everything else answers `401`. An expired or invalid
token on `/mcp` gets `401` with
`WWW-Authenticate: Bearer realm="bascula", resource_metadata="…", scope="mcp", error="invalid_token", …`
so the client knows to refresh or sign in again.

## Service worker rule

The web app is a PWA on the same hosts. Its Workbox service worker answers
navigations with the app shell (`navigateFallback`) — which once swallowed
`/oauth/authorize`: in a browser that had opened the app, the sign-in page
never reached the API and the connector hung (fixed in PR #86). The rule, in
`apps/web/src/pwa/navigateFallbackDenylist.ts`, is that the worker must never
answer these with the shell:

```
/v1/   /health   /landing/   /oauth/   /mcp  (/mcp, /mcp/…, /mcp?…)   /.well-known/
```

`/mcp/docs` and `/mcp/tools.json` are covered by the `/mcp` rule and tested in
`navigateFallbackDenylist.test.ts`. Any new API-served page must be added
there, and links to it from the app must be plain `<a href>` (not router
links).

## Caching

The API marks `/v1/`, `/health`, `/oauth/`, `/mcp…` and `/.well-known/`
answers `Cache-Control: no-store`. The browser help page at `GET /mcp` is
served as a `401` on purpose, because Cloudflare keys its cache on the URL and
does not cache a `401`.
