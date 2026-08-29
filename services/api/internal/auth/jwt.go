package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// AccessTTL is short on purpose: the access token carries the tenant, so a
// stale one must stop working quickly. Sessions survive through the refresh
// token, which lives in Postgres and can be killed from the web.
const AccessTTL = 15 * time.Minute

// RefreshTTL is long because a phone can be days without signal in the middle
// of a harvest.
const RefreshTTL = 60 * 24 * time.Hour

// Claims is the access token. The tenant travels in the token and never in the
// path: a farmId in the URL invites somebody to trust it.
type Claims struct {
	FarmID     string      `json:"farm_id"`
	Role       domain.Role `json:"role"`
	DeviceID   string      `json:"device_id,omitempty"`
	Superadmin bool        `json:"superadmin,omitempty"`
	jwt.RegisteredClaims
}

// Signer issues and verifies access tokens.
type Signer struct {
	key    []byte
	issuer string
	now    func() time.Time
}

func NewSigner(key []byte, issuer string) *Signer {
	return &Signer{key: key, issuer: issuer, now: time.Now}
}

// Issue mints an access token carrying sub, farm_id and role.
func (s *Signer) Issue(userID, farmID string, role domain.Role, deviceID string, superadmin bool) (string, error) {
	now := s.now()
	c := Claims{
		FarmID:     farmID,
		Role:       role,
		DeviceID:   deviceID,
		Superadmin: superadmin,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			Issuer:    s.issuer,
			ID:        uuid.NewString(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(AccessTTL)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	return tok.SignedString(s.key)
}

// Parse verifies signature, method and expiry.
func (s *Signer) Parse(raw string) (*Claims, error) {
	var c Claims
	_, err := jwt.ParseWithClaims(raw, &c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		return s.key, nil
	}, jwt.WithIssuer(s.issuer), jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return nil, domain.Coded(http.StatusUnauthorized, domain.CodeTokenExpired,
			"access token is not valid").WithCause(err)
	}
	if c.Subject == "" {
		return nil, domain.Unauthorized("access token has no subject")
	}
	return &c, nil
}

// NewOpaqueToken returns a 32-byte secret and the sha256 stored beside it. The
// database never holds anything that can be replayed.
func NewOpaqueToken() (secret string, hash []byte, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, fmt.Errorf("read random: %w", err)
	}
	secret = base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(secret))
	return secret, sum[:], nil
}

// HashToken is the lookup key for an opaque token.
func HashToken(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}
