package auth

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

func testSigner() *Signer { return NewSigner([]byte("test-signing-key"), "bascula") }

func TestOpenRefusesEveryBrokenSeal(t *testing.T) {
	s := testSigner()
	good := s.Seal("mcp-confirm", []byte(`{"v":1}`))
	body, sig, _ := strings.Cut(good, ".")

	if got, err := s.Open("mcp-confirm", " "+good+" "); err != nil || string(got) != `{"v":1}` {
		t.Fatalf("a good seal, padded: %q, %v", got, err)
	}
	for name, sealed := range map[string]string{
		"no separator":         body + sig,
		"payload not base64":   "!!." + sig,
		"mac not base64":       body + ".!!",
		"another purpose":      s.Seal("password-reset", []byte(`{"v":1}`)),
		"payload swapped":      s.Seal("mcp-confirm", []byte(`{"v":2}`))[:len(body)] + "." + sig,
		"another server's key": NewSigner([]byte("other-key"), "bascula").Seal("mcp-confirm", []byte(`{"v":1}`)),
	} {
		if _, err := s.Open("mcp-confirm", sealed); !errors.Is(err, ErrBadSeal) {
			t.Errorf("%s: got %v, want ErrBadSeal", name, err)
		}
	}
}

func TestVerifyTicketRefusals(t *testing.T) {
	s := testSigner()
	if sub, err := s.VerifyTicket("oauth", s.SignTicket("oauth", "user-1", time.Minute)); err != nil || sub != "user-1" {
		t.Fatalf("a fresh ticket: %q, %v", sub, err)
	}
	for name, raw := range map[string]string{
		"two fields":     "a.b",
		"other purpose":  s.SignTicket("reset", "user-1", time.Minute),
		"expired":        s.SignTicket("oauth", "user-1", -time.Minute),
		"empty subject":  s.SignTicket("oauth", "", time.Minute),
		"forged subject": "dXNlci0y." + strings.SplitN(s.SignTicket("oauth", "user-1", time.Minute), ".", 2)[1],
	} {
		if sub, err := s.VerifyTicket("oauth", raw); err == nil {
			t.Errorf("%s: accepted as %q", name, sub)
		}
	}
}

func TestParseRefusesATokenWithNoSubject(t *testing.T) {
	s := testSigner()
	raw, err := s.Issue("", "farm-1", domain.RoleOwner, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Parse(raw); err == nil {
		t.Fatal("a token naming nobody was accepted")
	}
	other := NewSigner([]byte("test-signing-key"), "someone-else")
	raw, _ = other.Issue("user-1", "farm-1", domain.RoleOwner, "", false)
	if _, err := s.Parse(raw); err == nil {
		t.Fatal("a token from another issuer was accepted")
	}
}

func TestAllowedForUnknownAndPublicActions(t *testing.T) {
	if AllowedFor(domain.RoleOwner, true, Action("no.such.action")) {
		t.Error("an unknown action must be a closed door, even for a super-admin owner")
	}
	if !AllowedFor(domain.RoleWeigher, false, ActionHealth) {
		t.Error("a public action is open to every role")
	}
}
