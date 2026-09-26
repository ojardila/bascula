package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

// SignTicket mints a short-lived, purpose-bound proof that subject already
// passed a check (for example, the password on the connector sign-in page) so
// a second step can carry it without carrying the password. It is not a
// token: no route accepts it as a bearer, and the purpose is part of the MAC
// so a ticket for one step cannot be replayed at another.
func (s *Signer) SignTicket(purpose, subject string, ttl time.Duration) string {
	exp := strconv.FormatInt(s.now().Add(ttl).Unix(), 10)
	payload := base64.RawURLEncoding.EncodeToString([]byte(subject)) + "." + exp
	return payload + "." + s.ticketMAC(purpose, payload)
}

// VerifyTicket returns the subject of a ticket minted for purpose, or an
// error if it was forged, is for another purpose, or has expired.
func (s *Signer) VerifyTicket(purpose, raw string) (string, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return "", errors.New("malformed ticket")
	}
	payload := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(s.ticketMAC(purpose, payload))) {
		return "", errors.New("ticket signature mismatch")
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || s.now().Unix() > exp {
		return "", errors.New("ticket expired")
	}
	sub, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(sub) == 0 {
		return "", errors.New("malformed ticket")
	}
	return string(sub), nil
}

func (s *Signer) ticketMAC(purpose, payload string) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte("bascula-ticket\x00" + purpose + "\x00" + payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
