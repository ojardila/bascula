package auth

import (
	"context"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Principal is who is making the request, taken from the access token and from
// nowhere else. In particular the farm is never read from a path parameter.
type Principal struct {
	UserID     string
	FarmID     string
	Role       domain.Role
	DeviceID   string
	Superadmin bool
	Email      string
}

type ctxKey int

const principalKey ctxKey = iota

// WithPrincipal stores the caller on the request context.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalKey, p)
}

// PrincipalFrom returns the caller, if the request was authenticated.
func PrincipalFrom(ctx context.Context) (*Principal, bool) {
	p, ok := ctx.Value(principalKey).(*Principal)
	return p, ok && p != nil
}
