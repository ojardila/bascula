# MCP security

How the MCP server (`/mcp`) and its OAuth authorization server (`/oauth/*`,
`/.well-known/*`) are protected, what was reviewed, and what is left. Code:
`services/api/internal/httpapi/handlers_mcp*.go`, `handlers_oauth.go`,
`server.go` (`authenticate`), `auth/perm.go`, `auth/jwt.go`. Tests:
`services/api/internal/apitest/mcp_security_test.go` plus the older
`oauth_*_test.go` and `mcp_*_test.go`.

## Model

- There are no API keys. An assistant (ChatGPT, Claude) gets a token through
  OAuth 2.1 (DCR + authorization code + PKCE S256), signed in with the same
  email and password as the web, for one farm.
- **A tool is a route.** Every tool builds an in-process request against the
  REST router *as the caller* (same bearer, same client address), so it walks
  the whole chain: authenticate → tenant transaction (`SET LOCAL app.farm_id`,
  membership and suspension re-read from the database) → permission table
  (`auth.Matrix`) → Postgres RLS. There is no second place a rule could be
  loosened. The farm always comes from the token, never from an argument.
- **Money is two-step.** `set_kilo_price`, `register_advance`,
  `register_payment`, `create_settlement`, `void_settlement` first answer a
  preview and a confirmation token; only a second call with that token writes.

## Controls

### Tokens

| Control | Where |
|---|---|
| Access token: HS256 JWT, 15 min, issuer checked, `alg` pinned | `auth/jwt.go` |
| Assistant token audience `["mcp", "<base>/mcp"]` (RFC 8707); `/mcp` refuses a token for another resource; `resource` validated at authorize and token | `server.go` `authenticate`, `handlers_oauth.go` `resourceIsThisServer` |
| Assistant token opens `/mcp` only; REST only through the tools | `server.go` `authenticate` |
| `cid` claim names the OAuth client | `auth.IssueMCP` |
| Refresh token: opaque, SHA-256 at rest, 60 days, rotated and single use; replay revokes the family; concurrent refresh yields one session | `handlers_auth.go` `rotateRefresh`, `store.MarkRefreshRotated` |
| Refresh token bound to its client (RFC 6749 §6); OAuth endpoint rotates only OAuth families; `/v1/auth/refresh` refuses assistant families | `handleOAuthToken`, `handleRefresh` |
| Revocation (RFC 7009) scoped to the asking client; never touches web/handset sessions | `handleOAuthRevoke` |
| Authorization code: 256-bit, 10 min, single use (`DELETE … RETURNING`), stored hashed, carries a purpose-bound proof (not a JWT) | `handleOAuthAuthorize`, `oauthExchangeCode` |

### Authorization endpoint and consent page

- PKCE required, `S256` only; `client_id` + exact `redirect_uri` match are
  checked before anything is sent to the redirect (no open redirect).
- `redirect_uri`: `https`, or `http` on loopback; no fragment, no userinfo.
- The page names the client (escaped, invisible characters stripped at
  registration) and the host the code goes to, and warns to stop if the site
  is unknown.
- The page is `X-Frame-Options: DENY`, `frame-ancestors 'none'`,
  `form-action 'self'`, `Referrer-Policy: no-referrer`. The form posts a
  password (or, in the farm-pick step, a short-lived signed ticket bound to
  the user), so a cross-site post cannot complete a consent by itself.
- `state` is passed through untouched; `iss` is added (RFC 9207).
- Sign-in attempts share the login limiter with `/v1/auth/login`.

### Dynamic client registration

Anonymous by design (ChatGPT and Claude use it). 30/address/hour per process
and 200/hour platform-wide (Postgres count); 64 KiB body; 10 redirect URIs of
≤ 2 KiB; `client_name` ≤ 80 characters; stored metadata ≤ 8 KiB. Nothing a
client registers except its name and redirect host is shown to a person.

### Tools

- Role and farm isolation: the permission table and RLS, per inner request.
  `TestMCPToolsCannotReachAnotherFarm` calls every id-taking tool with another
  farm's ids (reads, previews and writes) and expects not-found and no change.
- Write tools check the role before previewing anything.
- Confirmation tokens: sealed by the server, bound to tool, user, farm, a hash
  of the exact arguments, 10-minute expiry and a nonce; the nonce becomes the
  written row's id, so a token replayed writes nothing new. The price and the
  settlement also bind the state the preview showed (current price; gross and
  lines), so a stale confirmation is refused.
- Arguments: unknown keys refused, integers must be integers, amounts and
  prices must be positive, kilos validated by the routes; `?limit=` capped at
  500 (reports and settlements have their own lower caps).
- Rate limits per user (per API process): 120 tool calls/min, 30 write-tool
  calls/min (`MCPCallsPerUserPerMinute`, `MCPWritesPerUserPerMinute`).
- Tool names, descriptions and instructions are constants in the binary;
  nothing a farm or a client writes becomes a tool description.

### Transport and DoS

- `/mcp` body ≤ 1 MiB; JSON-RPC batches refused (they left the protocol in
  2025-06-18 and are N calls behind one request).
- `/oauth/*` bodies ≤ 64 KiB.
- The `/mcp` request releases its database transaction before the tools run,
  so a tool call holds one pool connection at a time (it used to hold two, and
  a burst of concurrent calls deadlocked the pool —
  `TestMCPToolCallsDoNotStarveThePool`).
- Stateless transport: no sessions to exhaust.

### CORS

`Access-Control-Allow-Origin: *` on `/mcp`, `/oauth/*` and the discovery
documents. Safe because nothing there uses cookies: every credential is an
explicit bearer token, client secret, PKCE verifier or password typed into the
first-party page. `/v1/*` sends no CORS headers.

### Prompt injection

Free text a farm writes (worker names, notes, plot names) comes back to the
model inside tool results. The server instructions tell the model that such
text is data, never instructions, and that it must never confirm a money
operation on its own. The real guard is structural: nothing moves money
without a second call carrying a token the model can only get by showing a
preview, and hosts (ChatGPT, Claude) ask the person before write tools
(`readOnlyHint: false`, `destructiveHint` on the destructive ones).

### Logging

The connector log (`edge_log.go`, `connector request …`) records the step
(path, status, client id, redirect host, whether a code was returned, the
JSON-RPC method and the tool name) and never a token, code, verifier, secret,
password or tool argument. The registration log records the registered
client name and redirect URIs, which are public metadata.

### Errors

Internal errors answer `{"error":{"code":"INTERNAL","message":"unexpected
error"}}`; causes are logged server-side only.

## Known limits

- The per-address registration limit and the per-user MCP limits are in
  memory, per API process (every stack runs one replica today). The
  platform-wide registration cap is shared.
- A confirmation token is not bound to the OAuth client: another assistant of
  the same user on the same farm could use it within its 10 minutes. It
  cannot change what is written (arguments are bound).
- govulncheck (September 2026) reports standard-library advisories against
  the toolchain pinned in `go.mod` (1.26.4; fixed in 1.26.6) and none in
  third-party code the server calls. The production image builds with the
  newer `golang:1.27-alpine` toolchain; CI and `go.mod` should move to a
  patched 1.26.x or 1.27.x.
