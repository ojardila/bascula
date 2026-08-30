package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"golang.org/x/crypto/argon2"
)

// MaxPasswordLength is the length past which a password is refused rather than
// hashed.
//
// It is not a strength rule and it does not truncate — OWASP's Authentication
// Cheat Sheet is explicit that truncating silently is worse than refusing, and
// that the maximum exists for one reason: the hash is the expensive part, its
// cost grows with the input, and an unauthenticated caller who chooses the
// input chooses how much CPU and memory the server spends on them. 128 is the
// number that sheet suggests, and it is far above any passphrase a person
// types on a phone in a coffee field.
//
// https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#maximum-password-lengths
const MaxPasswordLength = 128

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

// verifyCalls counts how many times VerifyPassword has been entered.
//
// It exists for one assertion, and the assertion is about a timing side channel
// that cannot be tested by timing anything. handleLogin has to spend the same
// work on an address that does not exist as on one that does; measuring that
// with a clock means a threshold, and a threshold on a shared CI runner is a
// test that fails on a noisy afternoon and gets deleted a week later. The
// property underneath the timing is discrete and exact — the verification runs
// on BOTH branches — so that is what gets asserted, and this is what makes it
// observable. An atomic add beside a 19 MiB hash costs nothing measurable.
var verifyCalls atomic.Int64

// VerifyCallsForTests reports how many times VerifyPassword has run in this
// process. Only the test suite reads it, in the same spirit as
// UseFastHashingForTests: a seam opened for a test rather than a test bent
// around the absence of one.
func VerifyCallsForTests() int64 { return verifyCalls.Load() }

// decoyInput is what the decoy hash is built over: thirty-two bytes of system
// entropy, drawn once per process and never written down.
//
// A constant string in this file would do the same job — what the decoy
// protects is the SHAPE of the reply, not its content, so there is nothing to
// keep secret — but a literal beside the word "password" is a hardcoded
// credential to every scanner that reads this repository, and an exception in a
// scanner's ignore list is a worse thing to own than four lines of rand.Read.
// Random also makes the property true rather than merely intended: no caller
// can hold this input, because nothing outside this process has ever seen it.
func decoyInput() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(buf), nil
}

var (
	decoyMu     sync.Mutex
	decoyCached string
	decoyParams argonParams
)

// DecoyHash returns a real argon2id hash for a password nobody holds, so a
// branch with no account to check against can spend the same work as a branch
// that has one. See handleLogin, which is the only caller.
//
// It is derived from activeArgon rather than from defaultArgon, and cached
// against the parameters it was built with, so UseFastHashingForTests makes the
// decoy cheap exactly as it makes every other hash cheap. A decoy pinned to the
// production cost would put a 19 MiB hash in the middle of every unit test that
// mistypes an address — and, worse, would leave the test suite unable to tell
// whether the two branches cost the same, because they would not.
//
// Computed lazily and kept, because a hash whose cost is the point cannot be
// recomputed per request: that would spend the work twice on the branch that
// has no user and once on the branch that does, which is the same oracle
// running backwards.
func DecoyHash() string {
	decoyMu.Lock()
	defer decoyMu.Unlock()
	if decoyCached != "" && decoyParams == activeArgon {
		return decoyCached
	}
	in, err := decoyInput()
	if err != nil {
		// Same failure and the same answer as below: no entropy, no decoy.
		return ""
	}
	h, err := HashPassword(in)
	if err != nil {
		// HashPassword fails only when the system entropy source does, which
		// is a machine that cannot serve a login at all. Returning the empty
		// string makes VerifyPassword answer errBadHash, which the caller
		// already treats as "not a match" — the reply is still correct, only
		// its timing is not, and there is nothing here worth failing a login
		// over that a working /dev/urandom does not fix.
		return ""
	}
	decoyCached, decoyParams = h, activeArgon
	return decoyCached
}

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
	verifyCalls.Add(1)
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
