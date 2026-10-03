// SPDX-License-Identifier: MIT

package httpapi

import "testing"

func TestRegisteredRedirect(t *testing.T) {
	registered := []string{
		"https://chatgpt.com/connector_platform_oauth_redirect",
		"http://localhost:6274/oauth/callback",
		"http://evil.example/cb", // not allowed at registration; refused here too
	}
	cases := []struct {
		requested string
		ok        bool
	}{
		{"https://chatgpt.com/connector_platform_oauth_redirect", true},
		{"http://localhost:6274/oauth/callback", true},
		// Exact match only: no prefix, case, trailing-slash or query variants.
		{"https://chatgpt.com/connector_platform_oauth_redirect/", false},
		{"https://chatgpt.com/connector_platform_oauth_redirect?x=1", false},
		{"https://CHATGPT.com/connector_platform_oauth_redirect", false},
		{"https://chatgpt.com.evil.example/connector_platform_oauth_redirect", false},
		{"https://evil.example/", false},
		{"//evil.example/", false},
		{"", false},
		{"http://evil.example/cb", false},
	}
	for _, c := range cases {
		u, err := registeredRedirect(registered, c.requested)
		if (err == nil) != c.ok {
			t.Errorf("%q: err=%v, want ok=%v", c.requested, err, c.ok)
			continue
		}
		if c.ok && u.String() != c.requested {
			t.Errorf("%q: got %q", c.requested, u.String())
		}
	}
}
