package domain

import (
	"fmt"
	"strings"
	"time"
)

// Day is a business date: the day something happened in the farm's timezone,
// with no time of day attached. It exists because openapi.yaml declares these
// fields `format: date` and Go's time.Time only decodes RFC 3339, so a client
// that sent the plain `2026-08-25` the contract asked for got back a 400 that
// named no field. Sending an instant for a day is also a lie: 2026-08-25 in
// Pitalito is not an instant, it is a day, and which instant you pick decides
// which week a picker gets paid in.
//
// A time of day is still accepted, so anything already sending RFC 3339 keeps
// working, but it is discarded rather than silently deciding the day.
type Day struct{ time.Time }

const dayLayout = "2006-01-02"

func (d *Day) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		return nil
	}
	if t, err := time.Parse(dayLayout, s); err == nil {
		d.Time = t
		return nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return fmt.Errorf("localDay must be a date like 2026-08-25, got %q", s)
	}
	// Keep the calendar day the caller wrote, not the instant.
	d.Time = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	return nil
}

func (d Day) MarshalJSON() ([]byte, error) {
	return []byte(`"` + d.Format(dayLayout) + `"`), nil
}

// Ptr is the *time.Time the store layer still speaks.
func (d *Day) Ptr() *time.Time {
	if d == nil || d.IsZero() {
		return nil
	}
	t := d.Time
	return &t
}
