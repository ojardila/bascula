// SPDX-License-Identifier: MIT

package httpapi

import "testing"

// A malformed Origin used to pass the suffix check and reach WebAuthn as the
// relying party id, whose error came back as a 500.
func TestValidDNSName(t *testing.T) {
	for host, want := range map[string]bool{
		"localhost":              true,
		"cafin3.bascula.engp.io": true,
		"a..localhost":           false,
		"x..bascula.engp.io":     false,
		".bascula.engp.io":       false,
		"bascula.engp.io.":       false,
		"-x.bascula.engp.io":     false,
		"x_y.bascula.engp.io":    false,
	} {
		if got := validDNSName(host); got != want {
			t.Errorf("validDNSName(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestPasskeyHostAllowedRefusesMalformedNames(t *testing.T) {
	s := &Server{}
	if err := s.passkeyHostAllowed("a..localhost"); err == nil {
		t.Fatal("a..localhost was accepted as a relying party")
	}
	if err := s.passkeyHostAllowed("app.localhost"); err != nil {
		t.Fatalf("app.localhost refused: %v", err)
	}
}
