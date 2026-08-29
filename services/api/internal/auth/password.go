package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters. Deliberately on the cheap side of OWASP's 2024 advice
// (19 MiB, 2 passes) so a phone-facing login on a small box stays under a
// tenth of a second; the memory cost, not the time cost, is what defeats a GPU.
type argonParams struct {
	memoryKiB uint32
	time      uint32
	threads   uint8
	saltLen   uint32
	keyLen    uint32
}

var defaultArgon = argonParams{memoryKiB: 19 * 1024, time: 2, threads: 1, saltLen: 16, keyLen: 32}

// testArgon keeps the test suite from spending its whole budget hashing.
var testArgon = argonParams{memoryKiB: 8 * 1024, time: 1, threads: 1, saltLen: 16, keyLen: 32}

var activeArgon = defaultArgon

// UseFastHashingForTests lowers the Argon2 cost. Only the test harness calls
// it; production never does.
func UseFastHashingForTests() { activeArgon = testArgon }

// HashPassword returns a PHC-formatted argon2id hash, parameters included, so
// the cost can be raised later without invalidating existing passwords.
func HashPassword(plain string) (string, error) {
	p := activeArgon
	salt := make([]byte, p.saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("read salt: %w", err)
	}
	key := argon2.IDKey([]byte(plain), salt, p.time, p.memoryKiB, p.threads, p.keyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.memoryKiB, p.time, p.threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

var errBadHash = errors.New("malformed password hash")

// VerifyPassword compares in constant time. A malformed stored hash is a
// failure, never a pass.
func VerifyPassword(plain, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errBadHash
	}
	var memory, timeCost uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &timeCost, &threads); err != nil {
		return false, errBadHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, errBadHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, errBadHash
	}
	got := argon2.IDKey([]byte(plain), salt, timeCost, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
