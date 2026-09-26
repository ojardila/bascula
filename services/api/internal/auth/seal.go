package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// Seal signs payload for one purpose with the same key the access tokens use,
// and returns "payload.mac" in base64url. It is a signature, not encryption:
// the payload is readable by whoever holds the string, so it must never carry
// a secret. The purpose is part of the MAC, so a string sealed for one use can
// never be replayed as another (or as an access token, which is a JWT and is
// verified by a different routine entirely).
func (s *Signer) Seal(purpose string, payload []byte) string {
	enc := base64.RawURLEncoding
	return enc.EncodeToString(payload) + "." + enc.EncodeToString(s.mac(purpose, payload))
}

// ErrBadSeal is every way an unsealed string can be wrong. The caller does
// not learn which, on purpose.
var ErrBadSeal = errors.New("the sealed value is not valid")

// Open verifies a string made by Seal for the same purpose and returns the
// payload. Expiry and binding are the caller's: this only proves the server
// wrote it.
func (s *Signer) Open(purpose, sealed string) ([]byte, error) {
	enc := base64.RawURLEncoding
	body, sig, ok := strings.Cut(strings.TrimSpace(sealed), ".")
	if !ok {
		return nil, ErrBadSeal
	}
	payload, err := enc.DecodeString(body)
	if err != nil {
		return nil, ErrBadSeal
	}
	mac, err := enc.DecodeString(sig)
	if err != nil {
		return nil, ErrBadSeal
	}
	if !hmac.Equal(mac, s.mac(purpose, payload)) {
		return nil, ErrBadSeal
	}
	return payload, nil
}

func (s *Signer) mac(purpose string, payload []byte) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte("bascula-seal\x00" + purpose + "\x00"))
	m.Write(payload)
	return m.Sum(nil)
}
