// SPDX-License-Identifier: MIT

package auth

import (
	"strings"
	"testing"
)

func TestVerifyPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("una-clave-larga-1")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := VerifyPassword("una-clave-larga-1", hash); err != nil || !ok {
		t.Fatalf("the right password: ok=%v err=%v", ok, err)
	}
	if ok, err := VerifyPassword("una-clave-larga-2", hash); err != nil || ok {
		t.Fatalf("a wrong password: ok=%v err=%v; want a clean false", ok, err)
	}
}

// TestVerifyPasswordRefusesMalformedHashes: a stored hash that cannot be read
// is a failure, never a pass, whichever of its six fields is broken.
func TestVerifyPasswordRefusesMalformedHashes(t *testing.T) {
	good, err := HashPassword("una-clave-larga-1")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(good, "$")
	with := func(i int, v string) string {
		p := append([]string(nil), parts...)
		p[i] = v
		return strings.Join(p, "$")
	}
	cases := map[string]string{
		"empty":            "",
		"too few fields":   "$argon2id$v=19$m=65536",
		"other algorithm":  with(1, "bcrypt"),
		"unreadable ver":   with(2, "v=x"),
		"other version":    with(2, "v=18"),
		"unreadable costs": with(3, "m=lots"),
		"salt not base64":  with(4, "!!!"),
		"key not base64":   with(5, "!!!"),
	}
	for name, encoded := range cases {
		t.Run(name, func(t *testing.T) {
			ok, err := VerifyPassword("una-clave-larga-1", encoded)
			if ok || err == nil {
				t.Fatalf("got ok=%v err=%v, want false and errBadHash", ok, err)
			}
		})
	}
}

func TestDecoyHashIsARealHash(t *testing.T) {
	d := DecoyHash()
	if d == "" {
		t.Fatal("no decoy hash")
	}
	// It must be checked like any other: same work, and never a match.
	if ok, err := VerifyPassword("anything", d); err != nil || ok {
		t.Fatalf("decoy: ok=%v err=%v", ok, err)
	}
}
