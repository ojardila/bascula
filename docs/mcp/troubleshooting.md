# MCP troubleshooting

## Quick checks

- **Is the endpoint up?** Open `https://<host>/mcp` in a browser. You should
  see a Spanish page «Conector de Báscula para ChatGPT y Claude» saying the
  address works (served with status `401` on purpose). `https://<host>/mcp/docs`
  should list the tools.
- **Does a token work?** On `/mcp/docs`, paste a token (or «Use my Báscula
  session») and press «Check (me)». It shows the user, role and farm.
- **Ask something concrete.** In ChatGPT or Claude, "What's the price per kilo
  this week?" makes the model call a tool; "are you connected?" often doesn't.

## Connector logs

Every request to `/mcp`, `/mcp/…`, `/oauth/…` and `/.well-known/…` writes one
structured `connector request` line (method, path, host, status, ms, user
agent, IP; for `/mcp` also the JSON-RPC method and whether a bearer was sent —
never a token, code or password):

```bash
# a farm host: namespace bascula-<slug>
kubectl --context admin@k8 -n bascula-san-jose logs deploy/bascula-api --since=15m | grep "connector request"
```

(Use the production namespace for the main host.) Reading a connection
attempt in order: `GET /.well-known/…` → `POST /oauth/register` (`201`) →
`GET /oauth/authorize` → `POST /oauth/authorize` (`302`) →
`POST /oauth/token` (`200`) → `POST /mcp` with `rpc=initialize`,
`tools/list`, `tools/call`. Wherever it stops is the step that failed. The
sign-in page also logs `oauth sign-in page notice` with the reason it
re-rendered (wrong password, unknown client, …).

## Symptoms

| Symptom | Cause and fix |
|---|---|
| ChatGPT link opens the ChatGPT app on iPhone and there is no way to add a connector | Expected: the phone apps cannot create connectors. Create it once at chatgpt.com **from a computer**; it then works on the phone. In Báscula, «Enviarme estos pasos» (send me these steps) shares the instructions to yourself. |
| After «Autorizar», the Báscula web app (login screen) appears instead of going back to the assistant | The web app's service worker served the app shell for `/oauth/authorize`. Fixed in PR #86 (`navigateFallbackDenylist`). If a browser still has an old worker: reload the app once so the new worker installs, or clear site data for the host, and retry. |
| «Correo o contraseña incorrectos.» (wrong email or password) | Wrong credentials for that host. |
| «Verifique el correo antes de conectar un asistente.» | The account's email is not verified. Verify it from the email Báscula sent, then retry. |
| «Esa cuenta no pertenece a esta finca.» on a farm host | The account is not a member of that farm. Use the right farm host, or the main host `bascula.engp.io/mcp` and pick the farm. |
| «Esa finca está suspendida.» | The farm (or the membership) is suspended. |
| «Cliente OAuth desconocido. Vuelva a registrar el conector.» | The client_id is unknown on this host (e.g. connector created against another host). Delete and re-create the connector. |
| «redirect_uri no coincide con el cliente registrado.» | The client sent a redirect URI it did not register. Re-create the connector. |
| «Pasó demasiado tiempo. Entre de nuevo con su correo y contraseña.» | The farm-picker ticket (10 minutes) expired. Sign in again. |
| ChatGPT shows **"Awaiting approval"** on a tool call | ChatGPT is asking you to allow the call. Approve it in ChatGPT; it is not a Báscula prompt. |
| A tool answers `FORBIDDEN` / «Su rol (weigher) no puede usar …» | Working as intended: the signed-in role may not use that route (e.g. a weigher asking for balances). Connect with an owner or administrator account if appropriate. |
| A payment/advance/settlement/price change "didn't happen" | Money tools run in two steps. The first call only returns a summary and a `confirmationToken`; the assistant must call again with the same arguments and the token after you confirm. Tokens expire after 10 minutes and are bound to the exact arguments. |
| The connector worked, then stopped after ~15 minutes | The access token expired and the client did not refresh. `/mcp` answers `401` with `error="invalid_token"`; a proper client refreshes. If not, disconnect and reconnect. A connection revoked in «Conexiones» also stops at the next refresh. |
| `401` with a pasted token in scripts / «Try it» | Access tokens last 15 minutes. Get a new one (`POST /v1/auth/login` or `/v1/auth/refresh`), or reopen the web app and press «Use my Báscula session» again. Use the token on the host that issued it. |
| `400 Accept must contain both 'application/json' and 'text/event-stream'` | Send `Accept: application/json, text/event-stream` and `Content-Type: application/json` on `POST /mcp`. |
| `405` on `GET /mcp` from a client | The server is stateless: only `POST` is supported. |
| «Conectado ✓» never appears in «Conexiones» | Only OAuth sessions appear there, and only the signed-in user's own on this farm. A connector signed in as another user or on another host will not show. The card re-checks when you come back to the tab. |
| A new page (e.g. `/mcp/docs`) or app version does not show after a deploy | Cloudflare caches the app's HTML, `sw.js` and `version.json` on Báscula hosts. Purge the cache for the host (a `CF_TOKEN` with cache-purge permission is in the ops Mac's environment), then reload. |

## Revoking access

«Configuración» (settings) → «Conexiones» (connections) → «Administrar»
(manage) → «Revocar conexión» (revoke connection). Or, for a client,
`POST /oauth/revoke` with the refresh token. See [oauth.md](oauth.md).
