package main

import (
	"bytes"
	"strings"
	"testing"
)

// The boot is a security decision, so it gets a test.
//
// What is guarded here is the case that has no test anywhere else in this
// repository, because it is not a request: the process starting up with an
// environment that does not say what it is. It used to start in development
// mode — signing tokens with a constant published in this repository, echoing
// the email verification token out of signup, and writing uploads to the
// system temp directory — because APP_ENV defaulted to "development" and the
// guard that was supposed to demand a real JWT_SECRET was itself conditioned
// on that same default. The guard could never fire on the machine that needed
// it.
//
// Each row below is a way that used to boot and must not.
func TestResolveConfigRefusesToBootUnconfigured(t *testing.T) {
	const good = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // 32 bytes

	for _, tc := range []struct {
		name string
		envs map[string]string
		// wantErr is a fragment of the refusal, empty when it must boot.
		wantErr string
	}{{
		// THE BUG. No environment at all: the old code read this as
		// development and signed the payroll with a public constant.
		name:    "nothing set at all",
		envs:    map[string]string{},
		wantErr: "JWT_SECRET is required",
	}, {
		// A typo in APP_ENV is not a development environment either. It is
		// the same missing value with a different spelling, and the safe
		// reading of "I do not know what this is" is production.
		name:    "APP_ENV misspelt",
		envs:    map[string]string{"APP_ENV": "develop"},
		wantErr: "JWT_SECRET is required",
	}, {
		name:    "production without a signing key",
		envs:    map[string]string{"APP_ENV": "production", "UPLOAD_DIR": "/srv/uploads"},
		wantErr: "JWT_SECRET is required",
	}, {
		// 31 bytes. RFC 7518 §3.2 requires at least the size of the hash
		// output for HS256, and an HS256 token can be attacked offline.
		name: "production with a short signing key",
		envs: map[string]string{
			"APP_ENV": "production", "UPLOAD_DIR": "/srv/uploads",
			"JWT_SECRET": strings.Repeat("a", minSecretBytes-1),
		},
		wantErr: "HS256 needs at least",
	}, {
		// The string is in the git history of a public repository. Setting it
		// deliberately is the shortcut somebody takes when a boot fails and
		// the error asks for a key, so it is refused everywhere.
		name: "the old built-in development key, in production",
		envs: map[string]string{
			"APP_ENV": "production", "UPLOAD_DIR": "/srv/uploads",
			"JWT_SECRET": leakedDevSigningKey,
		},
		wantErr: "old built-in development key",
	}, {
		name: "the old built-in development key, in development",
		envs: map[string]string{
			"APP_ENV": appEnvDevelopment, "JWT_SECRET": leakedDevSigningKey,
		},
		wantErr: "old built-in development key",
	}, {
		// UPLOAD_DIR hung off the same default, so an unconfigured server also
		// put receipt photos somewhere the next reboot deletes.
		name:    "production with a key but nowhere to put uploads",
		envs:    map[string]string{"APP_ENV": "production", "JWT_SECRET": good},
		wantErr: "UPLOAD_DIR is required",
	}, {
		// And the flip side: development is still one variable away, so the
		// laptop, `make dev` and the e2e suite are unaffected.
		name: "development, asked for explicitly",
		envs: map[string]string{"APP_ENV": appEnvDevelopment},
	}, {
		name: "production, fully configured",
		envs: map[string]string{
			"APP_ENV": "production", "UPLOAD_DIR": "/srv/uploads", "JWT_SECRET": good,
		},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			rc, err := resolveConfig(getenvFrom(tc.envs))
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("booted with %v; want a refusal mentioning %q", tc.envs, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("refused with %q; want it to mention %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("refused to boot a valid configuration: %v", err)
			}
			if len(rc.secret) < minSecretBytes {
				t.Errorf("signing key is %d bytes; want at least %d", len(rc.secret), minSecretBytes)
			}
			if string(rc.secret) == leakedDevSigningKey {
				t.Error("signing key is the public one from the repository")
			}
		})
	}
}

// DevEcho follows APP_ENV and nothing else. internal/httpapi says of it: "It
// must be off in production and the server refuses to start otherwise", and
// that sentence was false while the default was development — a server with no
// environment returned the email verification token in the signup body, which
// is the whole of the address check.
func TestResolveConfigDevEchoIsOffUnlessAskedFor(t *testing.T) {
	for _, appEnv := range []string{"", "production", "staging", "Development", "dev"} {
		envs := map[string]string{
			"UPLOAD_DIR": "/srv/uploads",
			"JWT_SECRET": strings.Repeat("a", minSecretBytes),
		}
		if appEnv != "" {
			envs["APP_ENV"] = appEnv
		}
		rc, err := resolveConfig(getenvFrom(envs))
		if err != nil {
			t.Fatalf("APP_ENV=%q: %v", appEnv, err)
		}
		if rc.http.DevEcho {
			t.Errorf("APP_ENV=%q echoes the email verification token", appEnv)
		}
	}
}

// The development key is worth nothing outside the process that minted it.
//
// A constant was worse than the missing variable it covered for: one forged
// token worked against every laptop and every deployment that had ever started
// without APP_ENV, and a value that ships in the source cannot be rotated.
func TestDevelopmentSigningKeyIsNotSharedBetweenBoots(t *testing.T) {
	envs := map[string]string{"APP_ENV": appEnvDevelopment}
	first, err := resolveConfig(getenvFrom(envs))
	if err != nil {
		t.Fatal(err)
	}
	second, err := resolveConfig(getenvFrom(envs))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first.secret, second.secret) {
		t.Fatal("two boots share a signing key, so a token forged against one works against all")
	}
}

func getenvFrom(envs map[string]string) func(string) string {
	return func(key string) string { return envs[key] }
}

// TRUSTED_PROXY_CIDRS decides whether an X-Forwarded-For can move the address
// the signup rate limit counts, so the parse of it is a security decision and
// gets a test of its own.
//
// The default is the interesting row. Unset must mean an EMPTY list, not a
// convenient guess like "the private ranges": httpapi reads the header only
// for a peer inside this list, so an empty list is what makes a service
// reachable directly immune to the header, and a guess would hand it to
// anything on the same network.
func TestResolveConfigTrustedProxyCIDRs(t *testing.T) {
	base := func(extra map[string]string) map[string]string {
		envs := map[string]string{
			"UPLOAD_DIR": "/srv/uploads",
			"JWT_SECRET": strings.Repeat("a", minSecretBytes),
		}
		for k, v := range extra {
			envs[k] = v
		}
		return envs
	}

	for _, tc := range []struct {
		name string
		raw  string
		want []string
		// wantErr is a fragment of the refusal, empty when it must boot.
		wantErr string
	}{{
		name: "unset trusts nobody",
		raw:  "",
		want: nil,
	}, {
		name: "one range",
		raw:  "10.0.0.0/8",
		want: []string{"10.0.0.0/8"},
	}, {
		name: "several, with the whitespace a human leaves behind",
		raw:  " 10.0.0.0/8 , 2001:db8::/32 ",
		want: []string{"10.0.0.0/8", "2001:db8::/32"},
	}, {
		// A bare address is the commonest way to write this wrong, and it
		// must not quietly become "trust nothing" — that is a rate limit that
		// looks configured and counts the proxy.
		name:    "a bare address is not a prefix",
		raw:     "10.0.0.1",
		wantErr: "is not a CIDR prefix",
	}, {
		name:    "one good range and one typo still refuses",
		raw:     "10.0.0.0/8,10.0.0.0/64",
		wantErr: "is not a CIDR prefix",
	}} {
		t.Run(tc.name, func(t *testing.T) {
			rc, err := resolveConfig(getenvFrom(base(map[string]string{
				"TRUSTED_PROXY_CIDRS": tc.raw,
			})))
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("booted with TRUSTED_PROXY_CIDRS=%q and trusted %v",
						tc.raw, rc.http.TrustedProxyCIDRs)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("refused with %q, want something about %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("refused a valid TRUSTED_PROXY_CIDRS=%q: %v", tc.raw, err)
			}
			if len(rc.http.TrustedProxyCIDRs) != len(tc.want) {
				t.Fatalf("trusts %v, want %v", rc.http.TrustedProxyCIDRs, tc.want)
			}
			for i, want := range tc.want {
				if rc.http.TrustedProxyCIDRs[i] != want {
					t.Fatalf("trusts %v, want %v", rc.http.TrustedProxyCIDRs, tc.want)
				}
			}
		})
	}
}
