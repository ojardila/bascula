package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
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
	// ClientID is the OAuth client an assistant's token was issued to (the
	// "cid" claim). Empty on an ordinary session token. It is what the MCP
	// audit trail records as "which assistant".
	ClientID string `json:"cid,omitempty"`
	// Scope is the OAuth scope an assistant was granted (space-separated).
	// Empty means full access for the role: every token from before scopes,
	// and every ordinary session token.
	Scope string `json:"scope,omitempty"`
	// SessionID is the refresh-token family the token was minted for (the
	// "sid" claim), so «Sesiones abiertas» can tell the caller which session
	// is theirs. Empty on tokens from before it, and on assistants' tokens.
	SessionID string `json:"sid,omitempty"`
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

// AudienceMCP marks an access token issued to an assistant through OAuth. It
// opens /mcp, and the REST API only through the MCP tools (which add the
// two-step confirmation on anything that moves money), never directly.
const AudienceMCP = "mcp"

// TokenSubject is who an access token speaks for: the claims every token
// carries whatever its audience.
type TokenSubject struct {
	UserID     string
	FarmID     string
	Role       domain.Role
	DeviceID   string
	Superadmin bool
	// SessionID is the refresh-token family the token is minted for, the
	// "sid" claim. Empty for tokens that do not come from a session.
	SessionID string
}

// Issue mints an access token carrying sub, farm_id and role.
func (s *Signer) Issue(userID, farmID string, role domain.Role, deviceID string, superadmin bool) (string, error) {
	return s.IssueFor("", userID, farmID, role, deviceID, superadmin)
}

// IssueFor is Issue with an audience; "" issues an ordinary session token.
func (s *Signer) IssueFor(audience, userID, farmID string, role domain.Role, deviceID string, superadmin bool) (string, error) {
	sub := TokenSubject{UserID: userID, FarmID: farmID, Role: role, DeviceID: deviceID, Superadmin: superadmin}
	if audience == "" {
		return s.issue(nil, "", "", sub)
	}
	return s.issue([]string{audience}, "", "", sub)
}

// IssueSession is Issue for a token minted from a session: sub.SessionID
// is the refresh-token family, carried as the "sid" claim.
func (s *Signer) IssueSession(sub TokenSubject) (string, error) {
	return s.issue(nil, "", "", sub)
}

// IssueMCP mints an assistant's access token. Its audience is AudienceMCP
// plus the MCP resource it was issued for (RFC 8707: https://<host>/mcp), so a
// token obtained from one farm's address is refused on another's; clientID is
// the OAuth client that holds the grant.
func (s *Signer) IssueMCP(resource, clientID, scope string, sub TokenSubject) (string, error) {
	aud := []string{AudienceMCP}
	if resource != "" {
		aud = append(aud, resource)
	}
	return s.issue(aud, clientID, scope, sub)
}

func (s *Signer) issue(audience []string, clientID, scope string, sub TokenSubject) (string, error) {
	now := s.now()
	c := Claims{
		FarmID:     sub.FarmID,
		Role:       sub.Role,
		DeviceID:   sub.DeviceID,
		Superadmin: sub.Superadmin,
		ClientID:   clientID,
		Scope:      scope,
		SessionID:  sub.SessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub.UserID,
			Issuer:    s.issuer,
			ID:        uuid.NewString(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(AccessTTL)),
		},
	}
	if len(audience) > 0 {
		c.Audience = jwt.ClaimStrings(audience)
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

// ForMCPOnly reports whether the token was issued to an assistant.
func (c *Claims) ForMCPOnly() bool {
	for _, a := range c.Audience {
		if a == AudienceMCP {
			return true
		}
	}
	return false
}

// MCPResource is the resource an assistant's token is bound to (the audience
// entry that is not AudienceMCP), or "" for a token minted before audience
// binding existed, which carried AudienceMCP alone.
func (c *Claims) MCPResource() string {
	for _, a := range c.Audience {
		if a != AudienceMCP {
			return a
		}
	}
	return ""
}

// OAuth scopes an assistant can be granted. ScopeMCP consults and registers,
// within the member's role; ScopeMCPRead only consults.
const (
	ScopeMCP     = "mcp"
	ScopeMCPRead = "mcp:read"
)

// ReadOnly reports whether the token was granted consultation only: an
// assistant's token whose scope names mcp:read and not mcp.
func (c *Claims) ReadOnly() bool {
	return ScopeIsReadOnly(c.Scope)
}

// ScopeIsReadOnly is ReadOnly for a scope string.
func ScopeIsReadOnly(scope string) bool {
	read, full := false, false
	for _, s := range strings.Fields(scope) {
		switch s {
		case ScopeMCPRead:
			read = true
		case ScopeMCP:
			full = true
		}
	}
	return read && !full
}
