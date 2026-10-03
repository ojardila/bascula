package httpapi

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/mailer"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Security notices: one plain-text email when something about an account
// changes that its owner would want to know about even if they did not do it.
//
//   - the password changed (either door, handlers_password.go)
//   - a passkey was added to or removed from the account (handlers_passkeys.go)
//   - an assistant (ChatGPT, …) was connected to a farm (oauthExchangeCode)
//   - somebody was made owner or administrator of a farm (handlers_users.go),
//     told to the farm's other owners
//
// Each one goes only where a mailer is configured; without one nothing here
// does anything, and nothing that depends on it fails.
//
// # Why after the request, and in a goroutine
//
// tenant.AfterRequest runs the send once the request's transaction is over,
// so an email never describes a change that was rolled back, and the request
// never holds its pool connection while an SMTP server thinks. The goroutine
// is for the response: AfterRequest still runs before the handler's return
// reaches the client, and a reply that waited for the mail would take longer
// for an address that has an account than for one that does not, which on the
// reset request is exactly what must not be told.

// mailLater sends m after this request, if there is a mailer. A failed send
// is logged and nothing else: the change it describes has already happened.
func (s *Server) mailLater(r *http.Request, m mailer.Message) {
	if s.cfg.Mailer == nil || strings.TrimSpace(m.To) == "" {
		return
	}
	send := s.cfg.Mailer
	tenant.AfterRequest(r.Context(), func(context.Context) {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			if err := send.Send(ctx, m); err != nil {
				slog.Error("notice email", "subject", sanitizeLog(m.Subject), "err", sanitizeLogErr(err))
			}
		}()
	})
}

// revokeSessionsElsewhere closes the user's sessions on every farm but this
// one, after this request, on a connection with no farm pinned: the row policy
// on refresh_tokens lets a request pinned to one farm reach only that farm's.
func (s *Server) revokeSessionsElsewhere(r *http.Request, userID, farmID string) {
	pool := s.pool
	tenant.AfterRequest(r.Context(), func(ctx context.Context) {
		if _, err := pool.Exec(context.WithoutCancel(ctx), `
			UPDATE refresh_tokens SET revoked_at = now()
			 WHERE user_id = $1 AND farm_id <> $2 AND revoked_at IS NULL`, userID, farmID); err != nil {
			slog.Error("revoke sessions on other farms", "user", userID, "err", err)
		}
	})
}

func greeting(name string) string {
	if n := strings.TrimSpace(name); n != "" {
		return "Hola, " + n + ":"
	}
	return "Hola,"
}

const noticeSignature = "\nBáscula\n"

// passwordResetMessage carries the link. It says what to do with it and what
// to do if the person did not ask, in that order.
func passwordResetMessage(to, name, link string) mailer.Message {
	body := fmt.Sprintf(`%s

Alguien pidió cambiar la clave de Báscula de este correo. Para poner una clave nueva, abra este enlace:

%s

El enlace sirve una sola vez y vence en 30 minutos.

Si usted no lo pidió, no haga nada: su clave sigue igual y nadie puede cambiarla sin este enlace.
%s`, greeting(name), link, noticeSignature)
	return mailer.Message{To: to, Subject: "Cambiar su clave de Báscula", Body: body}
}

// verifyEmailMessage carries the link that proves the address at signup. The
// page it opens also asks for the password chosen there.
func verifyEmailMessage(to, name, farmName, link string) mailer.Message {
	body := fmt.Sprintf(`%s

Para terminar de crear la finca «%s» en Báscula, confirme que este correo es suyo abriendo este enlace:

%s

La página le pedirá la clave que eligió al registrarse. Apenas confirme, empezamos a preparar la dirección de su finca.

El enlace vence en 48 horas. Si usted no registró esa finca, no haga nada: sin este enlace nadie puede usar su correo en Báscula.
%s`, greeting(name), farmName, link, noticeSignature)
	return mailer.Message{To: to, Subject: "Confirme su correo para crear su finca", Body: body}
}

// farmRegisteredNoticeMessage goes to an address that already has a verified
// account when somebody registers another farm with it: nothing to confirm,
// but its owner should know.
func farmRegisteredNoticeMessage(to, name, farmName string) mailer.Message {
	body := fmt.Sprintf(`%s

Se registró la finca «%s» en Báscula con este correo. Se entra a ella con la clave que se eligió al registrarla.

Si fue usted, no tiene que hacer nada.

Si no fue usted, nadie puede entrar a sus otras fincas con eso: cada una sigue con su propia clave. Puede ignorar este mensaje.
%s`, greeting(name), farmName, noticeSignature)
	return mailer.Message{To: to, Subject: "Se registró una finca con su correo", Body: body}
}

// passwordChangedMessage is the notice after either door. farmName is empty
// after an email reset, which changes the password for every farm.
func passwordChangedMessage(to, name, farmName string) mailer.Message {
	where := "Su clave de Báscula cambió."
	if f := strings.TrimSpace(farmName); f != "" {
		where = fmt.Sprintf("Su clave para entrar a %s cambió.", f)
	}
	body := fmt.Sprintf(`%s

%s Las sesiones abiertas en otros celulares y computadores se cerraron.

Si fue usted, no tiene que hacer nada.

Si no fue usted, alguien conoce su clave: en la pantalla de entrada use «¿Olvidó su clave?» para poner una nueva, y avísele al dueño de la finca.
%s`, greeting(name), where, noticeSignature)
	return mailer.Message{To: to, Subject: "Su clave cambió", Body: body}
}

// assistantConnectedMessage: an assistant can read the farm (and, with the
// full scope, write to it) for as long as the connection lives, so the person
// hears about it the moment it exists.
func assistantConnectedMessage(to, name, clientName, farmName string, readOnly bool) mailer.Message {
	client := strings.TrimSpace(clientName)
	if client == "" {
		client = "Un asistente"
	}
	access := "puede consultar y registrar datos"
	if readOnly {
		access = "puede consultar datos"
	}
	body := fmt.Sprintf(`%s

%s se conectó a la finca %s con su cuenta y %s en su nombre.

Si fue usted, no tiene que hacer nada.

Si no fue usted, entre a Báscula, abra Conexiones y desconéctelo. Después cambie su clave.
%s`, greeting(name), client, farmName, access, noticeSignature)
	return mailer.Message{To: to, Subject: client + " se conectó a su finca", Body: body}
}

// roleRaisedMessage goes to the farm's other owners when somebody becomes an
// owner or an administrator: both can see the payroll and add people.
func roleRaisedMessage(to, farmName, who string, role domain.Role, by string) mailer.Message {
	label := "administrador"
	if role == domain.RoleOwner {
		label = "dueño"
	}
	body := fmt.Sprintf(`Hola,

%s ahora es %s de la finca %s. Lo hizo %s.

Si está bien, no tiene que hacer nada.

Si no lo reconoce, entre a Báscula, abra Configuración → Usuarios y quítele el acceso.
%s`, who, label, farmName, by, noticeSignature)
	return mailer.Message{To: to, Subject: fmt.Sprintf("%s ahora es %s de %s", who, label, farmName), Body: body}
}

// noticeRoleRaised tells the farm's other owners that somebody now holds a
// role that sees the payroll and can add people. Called once the change is
// written; a failure to work out who to tell is logged, never answered — the
// role change already happened.
func (s *Server) noticeRoleRaised(r *http.Request, tx pgx.Tx, who, whoName string, role domain.Role) {
	if s.cfg.Mailer == nil || (role != domain.RoleOwner && role != domain.RoleAdmin) {
		return
	}
	caller, _ := auth.PrincipalFrom(r.Context())
	if caller == nil {
		return
	}
	by, err := store.FindUserByID(r.Context(), tx, caller.UserID)
	if err != nil {
		slog.Warn("role notice: caller", "err", err)
		return
	}
	m, err := store.GetMembership(r.Context(), tx, caller.FarmID, caller.UserID)
	if err != nil {
		slog.Warn("role notice: farm", "err", err)
		return
	}
	owners, err := store.FarmOwnerEmails(r.Context(), tx, caller.UserID)
	if err != nil {
		slog.Warn("role notice: owners", "err", err)
		return
	}
	person := who
	if n := strings.TrimSpace(whoName); n != "" {
		person = n + " (" + who + ")"
	}
	actor := by.Email
	if n := strings.TrimSpace(by.Name); n != "" {
		actor = n + " (" + by.Email + ")"
	}
	for _, to := range owners {
		if strings.EqualFold(to, who) {
			continue
		}
		s.mailLater(r, roleRaisedMessage(to, m.FarmName, person, role, actor))
	}
}

// passkeyAddedMessage: a passkey opens the account without the password and
// survives a password change, so a new one is worth hearing about.
func passkeyAddedMessage(to, name, passkeyName string) mailer.Message {
	body := fmt.Sprintf(`%s

Se agregó una llave de acceso a su cuenta de Báscula: «%s». Con ella se puede entrar con la huella o la cara del celular, sin escribir la clave.

Si fue usted, no tiene que hacer nada.

Si no fue usted, entre a Báscula, abra Conexiones → Llaves de acceso y quítela. Después cambie su clave.
%s`, greeting(name), passkeyName, noticeSignature)
	return mailer.Message{To: to, Subject: "Se agregó una llave de acceso", Body: body}
}

// passkeyRemovedMessage: removing one is less dangerous than adding one, but
// the owner should still know their way in changed.
func passkeyRemovedMessage(to, name string) mailer.Message {
	body := fmt.Sprintf(`%s

Se quitó una llave de acceso de su cuenta de Báscula. Su clave sigue sirviendo igual.

Si fue usted, no tiene que hacer nada.

Si no fue usted, cambie su clave y avísele al dueño de la finca.
%s`, greeting(name), noticeSignature)
	return mailer.Message{To: to, Subject: "Se quitó una llave de acceso", Body: body}
}
