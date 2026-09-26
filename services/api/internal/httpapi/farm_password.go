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

func hasFarm(ms []store.Membership, farmID string) bool {
	for _, m := range ms {
		if m.FarmID == farmID {
			return true
		}
	}
	return false
}
