# Connect Claude to Báscula

> **About API keys.** Báscula does not issue API keys today: nothing in the
> API creates, lists or accepts a personal long-lived key, and there is no
> screen for one in the app. Claude connects the same way ChatGPT does — a
> custom connector with **OAuth**, signing in with your Báscula email and
> password on a Báscula page. For scripts, a short-lived bearer token works
> (below).

## Claude (claude.ai, desktop and mobile apps)

What you need: a Claude plan that allows custom connectors (see Anthropic's
current plan limits), a Báscula account with a verified email, and the farm's
MCP address — `https://<slug>.bascula.engp.io/mcp` (e.g.
`https://san-jose.bascula.engp.io/mcp`) or `https://bascula.engp.io/mcp`.
In the web app it is on «Configuración» (settings) → «Conexiones»
(connections): in the «Datos para ChatGPT» (details for ChatGPT) box while no
assistant is connected, or under «Administrar» (manage) → «Dirección del
conector (MCP)» (connector address) once one is. It is always the farm's web
address followed by `/mcp`.

1. In Claude open **Settings → Connectors → Add custom connector**.
2. Name `Báscula`, paste the MCP address, and add it. Leave the OAuth client
   ID/secret fields empty: Báscula supports dynamic client registration.
3. Click **Connect**. A Báscula page opens: «Conectar Báscula a un asistente»,
   naming the application («Aplicación») and the site access returns to
   («Le devolverá el acceso a», e.g. `claude.ai`).
   Enter «Correo» (email) and «Contraseña» (password), press «Autorizar»
   (authorize). On the main host, an account with several farms chooses one
   under «Finca» and presses «Continuar» (continue). A farm host shows
   «Finca: <name>» and never asks.
4. Back in Claude, enable the connector in a chat and ask something concrete,
   e.g. "What's the kilo price this week in Báscula?".

The session appears in Báscula under «Conexiones» with the client name
Claude registered, and can be revoked there («Revocar conexión»).

## Claude Code

```bash
claude mcp add --transport http bascula https://san-jose.bascula.engp.io/mcp
```

Then run `/mcp` inside Claude Code and choose to authenticate: it runs the
same OAuth flow in your browser.

## Scripts, MCP Inspector, and the «Try it» panel (bearer token)

Any MCP client can send `Authorization: Bearer <access token>`. Get a token by
signing in:

```bash
TOKEN=$(curl -s https://san-jose.bascula.engp.io/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}' | jq -r .accessToken)
```

(On the main host, an account with several farms can add `"farmSlug":"…"` or
`"farmId":"…"`.) The access token **expires after 15 minutes**; renew it with
`POST /v1/auth/refresh` and the `refreshToken`, or sign in again. Because of
that lifetime a pasted token is fine for testing but not for a connector you
want to keep — use OAuth for that.

On `https://<host>/mcp/docs`, paste the token in «Try it — your token», or
press «Use my Báscula session» to reuse the web app's session in the same
browser on the same host.

What Claude may do is exactly what the signed-in role may do; see
[README.md#roles](README.md#roles). Problems? See
[troubleshooting.md](troubleshooting.md).
