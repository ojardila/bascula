# Connect ChatGPT to Báscula

ChatGPT connects to Báscula as a custom MCP connector ("app") and signs in
with OAuth: you type your Báscula email and password on a Báscula page, never
in ChatGPT. The assistant then sees exactly what your role allows.

> **Do this once, from a computer, at chatgpt.com.** ChatGPT's iPhone and
> Android apps cannot create connectors, and on an iPhone a chatgpt.com link
> opens the ChatGPT app. Once created on the web, the connector also works in
> the phone app.

## What you need

- A ChatGPT plan with developer mode (Plus, Pro, Business or Enterprise, per
  OpenAI at the time of writing).
- A Báscula account with a **verified email** on the farm.
- The farm's MCP address:
  - a farm host: `https://<slug>.bascula.engp.io/mcp`, e.g.
    `https://san-jose.bascula.engp.io/mcp` — always that farm;
  - or the main host `https://bascula.engp.io/mcp` — if your account has
    several farms you will pick one while signing in.

In the web app the address is on «Configuración» (settings) → «Conexiones»
(connections), with a «Copiar» (copy) button, a «Conectar con ChatGPT»
(connect with ChatGPT) button that opens ChatGPT, and a «Ver herramientas
disponibles» (see available tools) link to the [tool reference](README.md#the-reference-page-mcpdocs).
«Configuración» is available to the owner and administrator roles.

## Steps

1. At chatgpt.com open **Settings → Security and login** («Configuración →
   Seguridad e inicio de sesión» in Spanish) and turn on **Developer mode**.
2. Go to **Plugins** — `https://chatgpt.com/plugins` — and click **+**.
3. Name: `Báscula`. MCP server URL: paste the farm's address (above).
4. Authentication: **OAuth**. Create the connector.
5. ChatGPT opens a Báscula page, «Conectar Báscula a un asistente» (connect
   Báscula to an assistant):
   - it names the application and where access goes: «Aplicación: …»
     (application) and «Le devolverá el acceso a: chatgpt.com» (access will
     be returned to). If you don't recognize them, stop;
   - on a farm host it shows «Finca: San José» (farm: San José);
   - enter your «Correo» (email) and «Contraseña» (password) and press
     «Autorizar» (authorize);
   - on the main host, if your account has several farms, choose one of the
     radio buttons under «Finca» and press «Continuar» (continue).
6. You are sent back to ChatGPT. In Báscula, the «Conexiones» card now shows
   «Conectado ✓» (connected).

Behind the scenes ChatGPT discovers the OAuth server, registers itself
(dynamic client registration) and runs authorization code + PKCE; see
[oauth.md](oauth.md).

## Using it

- Enable the Báscula connector in the chat (tools / developer mode menu).
- Ask something concrete. "What is the price per kilo this week?" or "How
  many kilos did the crew pick last week?" works better than "are you
  connected?", which gives the model no reason to call a tool.
- ChatGPT may show **"Awaiting approval"** before a tool call. Approve it in
  ChatGPT; Báscula does not send that prompt.
- Payments, advances, settlements, voiding a settlement and price changes
  always come back first as a summary with a confirmation token. Nothing is
  recorded until you tell the assistant to go ahead and it calls the tool a
  second time.

## Disconnecting

- In Báscula: «Configuración» → «Conexiones» → «Administrar» (manage) →
  «Revocar conexión» (revoke connection). The refresh token stops working at
  once; an access token already issued lapses within 15 minutes.
- In ChatGPT you can also delete the connector; that does not revoke the
  Báscula session by itself unless ChatGPT calls `/oauth/revoke`.

Problems? See [troubleshooting.md](troubleshooting.md).
