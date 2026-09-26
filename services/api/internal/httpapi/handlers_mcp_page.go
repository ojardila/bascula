package httpapi

import (
	"fmt"
	"html"
	"net/http"
	"strings"
)

// mcpBrowserPage answers a person who opened /mcp in a browser.
//
// /mcp is a machine endpoint. Without a token it answers 401 with a
// WWW-Authenticate challenge, which is exactly right for ChatGPT and Claude
// and exactly wrong for the owner who pastes the address into a tab to see if
// it "works": they got a line of JSON and concluded the connector was broken.
//
// So a GET with no Authorization header that asks for text/html gets a page
// in Spanish saying what the address is for and how to connect it. MCP
// clients never ask for text/html — their GET asks for text/event-stream and
// their POST for JSON — so nothing a client does can land here, and the 401
// with the challenge is untouched for them.
//
// The page is still a 401 carrying the same WWW-Authenticate challenge, on
// purpose. The bascula hosts sit behind a Cloudflare rule that caches
// aggressively and keys on the URL, not on Accept: a 200 HTML page stored
// for GET /mcp could be handed to a client that asked for an event stream.
// Cloudflare does not cache a 401, and if anything ever did, a client would
// still read the status and the challenge rather than the body. Browsers
// render the body of a Bearer 401 without prompting for anything.
func (s *Server) mcpBrowserPage(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || !strings.Contains(r.Header.Get("Accept"), "text/html") {
			next.ServeHTTP(w, r)
			return
		}
		url := html.EscapeString(s.mcpResource(r))
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		s.writeMCPChallenge(w, r, "")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprintf(w, `<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Conector de Báscula para asistentes</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:8vh auto;padding:0 1.25rem;color:#111}
  h1{font-size:1.35rem;margin:0 0 .5rem}
  h2{font-size:1.05rem;margin:1.5rem 0 .25rem}
  code{background:#f2f2f2;padding:.15rem .35rem;border-radius:4px;word-break:break-all}
  .ok{background:#eef9f1;border-left:4px solid #0a7;padding:.6rem .8rem;border-radius:4px}
  li{margin:.2rem 0}
</style>
<h1>Conector de Báscula para ChatGPT y Claude</h1>
<p class="ok">Esta dirección funciona. No se abre en el navegador: es la que se le da a un asistente para que consulte y registre la cosecha y la nómina de esta finca.</p>
<p>Dirección del conector:<br><code>%s</code></p>
<h2>ChatGPT</h2>
<ol>
  <li>Desde un computador, en chatgpt.com (la app del celular no deja crear conectores): Configuración → Seguridad e inicio de sesión → active el <strong>Modo desarrollador</strong>. Requiere plan Plus, Pro, Business o Enterprise.</li>
  <li>Abra <strong>Plugins</strong> (chatgpt.com/plugins), toque <strong>+</strong>, pegue la dirección de arriba y elija autenticación <strong>OAuth</strong>.</li>
  <li>Se abrirá una página de Báscula: entre con el correo y la contraseña de la finca. Después el conector funciona también en el celular.</li>
</ol>
<h2>Claude</h2>
<ol>
  <li>Configuración → Conectores → Agregar conector personalizado.</li>
  <li>Pegue la dirección de arriba y conecte; entre con el correo y la contraseña de la finca.</li>
</ol>
<h2>Qué puede hacer el asistente</h2>
<p>Lo mismo que su rol en Báscula. Pagos, anticipos, liquidaciones y cambios de precio siempre muestran un resumen y esperan su confirmación antes de hacerse.</p>
</html>
`, url)
	})
}
