// Package migrations embeds the SQL migrations in the binary so `make migrate`
// and the test harness run exactly the files that shipped.
//
// Numbering is sequential and not by timestamp: the team is small, and a
// clashing number is a visible git conflict, which beats two migrations that
// apply in a different order in every environment.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
