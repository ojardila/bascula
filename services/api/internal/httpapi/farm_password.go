package httpapi

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// farmsUnlockedBy returns the memberships a password opens.
//
// A farm registered with an address that already had an account has its own
// owner password (farm_owner_credentials), and only that password opens it.
// Every other membership opens with the account's global password; globalOK
// says whether the password matched it. The caller must have pinned the user
// with tenant.SetUser.
//
// Why: signup does not prove the address (there is no mail link yet), so
// the global password of an account belongs to whoever registered the address
// FIRST. When the address's real owner later registers their own farm, the
// farm is attached to that account. Letting the global password open it gave
// the first registrant owner access to a stranger's farm.
//
// The same table holds the password an administrator hands over with an
// invite (store.SetFarmCredential), and the rule is the same for any role: a
// membership with a row opens with that row's password and nothing else. The
// table keeps its "owner" name because renaming it buys nothing; read it as
// "farm credentials".
func farmsUnlockedBy(ctx context.Context, tx pgx.Tx, userID, password string, globalOK bool,
	memberships []store.Membership) ([]store.Membership, error) {
	own, err := store.OwnerCredentialHashes(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]store.Membership, 0, len(memberships))
	for _, m := range memberships {
		hash, locked := own[m.FarmID]
		if !locked {
			if globalOK {
				out = append(out, m)
			}
			continue
		}
		if ok, err := auth.VerifyPassword(password, hash); err == nil && ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// onlyFarmScoped keeps the memberships whose farm has its own password for
// this user, which are the only ones an account with no verified address may
// open.
//
// An invite to an address nobody has proved creates the account with a
// password nobody knows and puts the password the administrator hands over on
// the farm (handleInviteUser). The weigher who received it in person signs in
// to that farm and nowhere else; the account itself — its global password,
// every other farm, the main domain's "all my farms" — stays shut until
// somebody proves the mailbox (verify-email after a signup claim, or a reset).
// A password that opens a global-password farm on an unverified account is
// the old EMAIL_NOT_VERIFIED answer, unchanged.
func onlyFarmScoped(ctx context.Context, tx pgx.Tx, userID string,
	memberships []store.Membership) ([]store.Membership, error) {
	own, err := store.OwnerCredentialHashes(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]store.Membership, 0, len(memberships))
	for _, m := range memberships {
		if _, locked := own[m.FarmID]; locked {
			out = append(out, m)
		}
	}
	return out, nil
}

// farmScopedSession says whether the caller signed in to this farm with the
// farm's own password rather than the account's. Such a session speaks for
// the farm membership, not for the account: whoever handed that password over
// (an administrator, with an invite) knows it too.
func farmScopedSession(ctx context.Context, tx pgx.Tx, p *auth.Principal) (bool, error) {
	_, own, err := store.FarmOwnerCredentialHash(ctx, tx, p.FarmID, p.UserID)
	return own, err
}

func hasFarm(ms []store.Membership, farmID string) bool {
	for _, m := range ms {
		if m.FarmID == farmID {
			return true
		}
	}
	return false
}
