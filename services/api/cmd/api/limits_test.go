package main

import (
	"strings"
	"testing"
	"time"
)

func bootEnv(extra map[string]string) map[string]string {
	envs := map[string]string{
		"UPLOAD_DIR": "/srv/uploads",
		"JWT_SECRET": strings.Repeat("a", minSecretBytes),
	}
	for k, v := range extra {
		envs[k] = v
	}
	return envs
}

var limitKeys = []string{
	"SIGNUPS_PER_IP_PER_HOUR", "LOGIN_FAILURES_PER_EMAIL_PER_IP", "LOGIN_FAILURES_PER_IP",
	"LOGIN_FAILURE_WINDOW", "SIGNUPS_PER_EMAIL_PER_HOUR", "SIGNUPS_PER_HOUR", "FARM_LOOKUPS_PER_IP_PER_HOUR",
}

// limitsOf lists the tunable limits in limitKeys order, the window in minutes.
func limitsOf(rc resolved) []int {
	c := rc.http
	return []int{
		c.SignupsPerIPPerHour, c.LoginFailuresPerEmailPerIP, c.LoginFailuresPerIP,
		int(c.LoginFailureWindow / time.Minute), c.SignupsPerEmailPerHour, c.SignupsPerHour, c.FarmLookupsPerIPPerHour,
	}
}

// limitsEnv sets every tunable limit, in limitKeys order.
func limitsEnv(values ...string) map[string]string {
	envs := map[string]string{}
	for i, k := range limitKeys {
		envs[k] = values[i%len(values)]
	}
	return bootEnv(envs)
}

func assertLimits(t *testing.T, label string, envs map[string]string, want []int) {
	t.Helper()
	rc, err := resolveConfig(getenvFrom(envs))
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	for i, got := range limitsOf(rc) {
		if got != want[i] {
			t.Errorf("%s: %s is %d, want %d", label, limitKeys[i], got, want[i])
		}
	}
}

// The rate limits are tunable from the environment, and a value that is zero,
// negative or not a number keeps the default instead of switching the limit
// off: "0" in an environment file is far more often a mistake than a decision
// to remove the lock.
func TestResolveConfigRateLimitsFromTheEnvironment(t *testing.T) {
	defaults, err := resolveConfig(getenvFrom(bootEnv(nil)))
	if err != nil {
		t.Fatal(err)
	}
	if defaults.http.SignupsPerHour != 30 {
		t.Errorf("SignupsPerHour defaults to %d, want 30", defaults.http.SignupsPerHour)
	}
	assertLimits(t, "set", limitsEnv("7", "4", "40", "20m", "2", "300", "90"), []int{7, 4, 40, 20, 2, 300, 90})
	for _, bad := range []string{"0", "-3", "muchos"} {
		assertLimits(t, bad, limitsEnv(bad), limitsOf(defaults))
	}
}

// A dedicated stack serves one farm. It learns which from TENANT_SLUG or from
// its own public address, refuses to boot knowing neither, and drops the
// platform-only credentials it must never use.
func TestResolveConfigDedicatedStack(t *testing.T) {
	dedicated := func(k, v string) map[string]string {
		m := map[string]string{
			"TENANT_MODE":           "dedicated",
			"GITHUB_DISPATCH_TOKEN": "ghp-platform",
			"CF_SAAS_TOKEN":         "cf-platform",
		}
		if k != "" {
			m[k] = v
		}
		return bootEnv(m)
	}

	rc, err := resolveConfig(getenvFrom(dedicated("TENANT_SLUG", "la-palma")))
	if err != nil {
		t.Fatal(err)
	}
	if rc.http.TenantSlug != "la-palma" {
		t.Errorf("TenantSlug = %q, want la-palma", rc.http.TenantSlug)
	}
	if rc.http.GitHubDispatchToken != "" || rc.http.CloudflareSaaSToken != "" {
		t.Error("a farm's own stack kept a platform credential")
	}
	if rc.http.KubeClient != nil {
		t.Error("a farm's own stack reads the cluster")
	}

	rc, err = resolveConfig(getenvFrom(dedicated("PUBLIC_BASE_URL", "https://san-jose.bascula.engp.io/")))
	if err != nil {
		t.Fatal(err)
	}
	if rc.http.TenantSlug != "san-jose" {
		t.Errorf("slug from PUBLIC_BASE_URL = %q, want san-jose", rc.http.TenantSlug)
	}

	_, err = resolveConfig(getenvFrom(dedicated("", "")))
	if err == nil || !strings.Contains(err.Error(), "TENANT_MODE=dedicated needs TENANT_SLUG") {
		t.Fatalf("a dedicated stack that knows no farm booted: %v", err)
	}
}
