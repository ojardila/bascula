// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"strings"
	"testing"
)

// A DSN that does not parse is refused by MigrateDown on its first connection,
// and by Migrate before it opens anything.
func TestMigrationsRefuseAMalformedDSN(t *testing.T) {
	ctx := context.Background()
	if err := MigrateDown(ctx, "postgres://%zz"); err == nil || !strings.Contains(err.Error(), "cannot parse") {
		t.Fatalf("MigrateDown = %v, want the parse failure", err)
	}
	if err := Migrate(ctx, "postgres://%zz"); err == nil || !strings.Contains(err.Error(), "parse admin connection") {
		t.Fatalf("Migrate = %v, want the parse refusal", err)
	}
}
