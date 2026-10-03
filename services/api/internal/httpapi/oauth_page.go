// SPDX-License-Identifier: MIT

package httpapi

import "html/template"

// oauthPageTmpl is the OAuth sign-in page (and its second step, the farm
// pick). It is an html/template so every value that came from the request,
// the database or a registered client is escaped for the exact place it
// lands in (text, attribute, ...), instead of trusting hand-built strings.
var oauthPageTmpl = template.Must(template.New("oauth").Parse(`
{{- define "hidden"}}{{range .}}<input type="hidden" name="{{.Name}}" value="{{.Value}}">{{end}}{{end}}
{{- define "msg"}}{{with .Client}}<p class="who">Aplicación: <strong>{{.Name}}</strong><br>Le devolverá el acceso a: <strong>{{.Dest}}</strong></p><p class="warn">Si no reconoce ese sitio, no escriba su contraseña.</p>{{end}}{{with .Notice}}<p class="err">{{.}}</p>{{end}}{{end -}}
<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Conectar Báscula</title>
` + oauthFormStyle + `
<h1>Conectar Báscula a un asistente</h1>
{{if .Pick -}}
<p>Su cuenta tiene varias fincas. Elija cuál va a usar el asistente.</p>
{{template "msg" .}}
<form method="post" action="/oauth/authorize">
  {{template "hidden" .Hidden}}<input type="hidden" name="ticket" value="{{.Ticket}}">
  <fieldset>
    <legend>Finca</legend>
    {{range .Farms}}<label class="opt"><input type="radio" name="farm_id" value="{{.ID}}"{{if .Checked}} checked{{end}}><span>{{.Name}}{{with .Slug}}<span class="slug">{{.}}.bascula.engp.io</span>{{end}}</span></label>
{{end}}
  </fieldset>
  <button type="submit">Continuar</button>
</form>
{{else -}}
<p>Entre con la misma cuenta de la finca. El asistente trabaja con los permisos de su rol.</p>
{{with .FarmName}}<p class="farm">Finca: <strong>{{.}}</strong></p>{{end}}{{template "msg" .}}
<form method="post" action="/oauth/authorize">
  {{template "hidden" .Hidden}}
  <fieldset>
    <legend>¿Qué podrá hacer el asistente?</legend>
    <label class="opt"><input type="radio" name="access" value="write"{{if not .ReadOnly}} checked{{end}}><span>Consultar y registrar<span class="slug">Trabajadores, lotes y pesadas. Pagos, anticipos, liquidaciones y precios siempre le piden su confirmación antes de hacerse.</span></span></label>
    <label class="opt"><input type="radio" name="access" value="read"{{if .ReadOnly}} checked{{end}}><span>Solo consultar<span class="slug">No cambia ni borra nada de la finca.</span></span></label>
  </fieldset>
  <label class="f" for="email">Correo</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="{{.Email}}">
  <label class="f" for="password">Contraseña</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Autorizar</button>
  <input type="hidden" name="passkey_challenge" value="">
  <input type="hidden" name="passkey_credential" value="">
  <button type="button" id="passkey" class="alt" hidden>Entrar con llave de acceso</button>
</form>
<script nonce="{{.Nonce}}">` + oauthPasskeyScript + `</script>
{{end}}`))

type oauthPageField struct{ Name, Value string }

type oauthPageClient struct{ Name, Dest string }

type oauthPageFarm struct {
	ID, Name, Slug string
	Checked        bool
}

// oauthPageData is everything the sign-in page shows. All of it is plain
// strings: the template escapes them.
type oauthPageData struct {
	Hidden   []oauthPageField
	Client   *oauthPageClient
	Notice   string
	Nonce    string
	Pick     bool
	Ticket   string
	Farms    []oauthPageFarm
	FarmName string
	ReadOnly bool
	Email    string
}
