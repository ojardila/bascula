// SPDX-License-Identifier: MIT

package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Only HS256 is accepted: a token signed with the same key under another
// algorithm, or under none, is a 401 with the expired-token code, refused
// before the key is ever handed out.
func TestParseRefusesEveryAlgorithmButHS256(t *testing.T) {
	s := testSigner()
	claims := Claims{
		FarmID: "farm-1", Role: domain.RoleOwner,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject: "user-1", Issuer: "bascula",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	}
	sign := func(m jwt.SigningMethod, key any) string {
		raw, err := jwt.NewWithClaims(m, claims).SignedString(key)
		if err != nil {
			t.Fatalf("sign %s: %v", m.Alg(), err)
		}
		return raw
	}
	if c, err := s.Parse(sign(jwt.SigningMethodHS256, []byte("test-signing-key"))); err != nil || c.Subject != "user-1" {
		t.Fatalf("HS256 control: %v, %v", c, err)
	}
	for name, raw := range map[string]string{
		"HS384": sign(jwt.SigningMethodHS384, []byte("test-signing-key")),
		"HS512": sign(jwt.SigningMethodHS512, []byte("test-signing-key")),
		// alg=none on purpose: the test checks that Parse refuses an unsigned token.
		// nosemgrep: go.jwt-go.security.jwt-none-alg.jwt-go-none-algorithm
		"none": sign(jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType),
	} {
		t.Run(name, func(t *testing.T) {
			c, err := s.Parse(raw)
			var de *domain.Error
			if c != nil || !errors.As(err, &de) || de.Status != http.StatusUnauthorized || de.Code != domain.CodeTokenExpired {
				t.Fatalf("Parse = %v, %v; want a 401 %s", c, err, domain.CodeTokenExpired)
			}
		})
	}
}

// An opaque token is 32 random bytes, URL-safe, and what is stored beside it
// is the sha256 of the text handed out, which HashToken finds again.
func TestNewOpaqueTokenShape(t *testing.T) {
	secret, hash, err := NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(secret)
	if err != nil || len(raw) != 32 {
		t.Fatalf("secret %q decodes to %d bytes (%v), want 32", secret, len(raw), err)
	}
	sum := sha256.Sum256([]byte(secret))
	if !bytes.Equal(hash, sum[:]) || !bytes.Equal(HashToken(secret), hash) {
		t.Fatal("the stored hash is not the sha256 of the secret")
	}
	other, _, _ := NewOpaqueToken()
	if other == secret {
		t.Fatal("two tokens came out equal")
	}
}

// Two hashes of the same password differ by their salt and both verify; the
// decoy is such a hash, of an input nobody holds.
func TestHashPasswordSaltsEveryHash(t *testing.T) {
	a, errA := HashPassword("correcto caballo batería grapa")
	b, errB := HashPassword("correcto caballo batería grapa")
	if errA != nil || errB != nil || a == b {
		t.Fatalf("hashes %q %q (%v, %v): want two different hashes", a, b, errA, errB)
	}
	for _, h := range []string{a, b} {
		if !strings.HasPrefix(h, "$argon2id$") {
			t.Fatalf("not a PHC argon2id hash: %q", h)
		}
		if ok, err := VerifyPassword("correcto caballo batería grapa", h); err != nil || !ok {
			t.Fatalf("VerifyPassword = %v, %v", ok, err)
		}
	}
	if d := DecoyHash(); !strings.HasPrefix(d, "$argon2id$") || d == a {
		t.Fatalf("decoy %q is not its own argon2id hash", d)
	}
}
