package apitest

import (
	"time"

	"github.com/ojardila/bascula/services/api/internal/auth"
)

// The platforms in this suite sign with "test-signing-key"; so does this, so a
// test can hold the provision ticket signup hands the browser.
var testSigner = auth.NewSigner([]byte("test-signing-key"), "bascula")

func provisionTicketFor(slug string) string {
	return testSigner.SignTicket("provision-status", slug, time.Hour)
}

// provisionStatusPath is the waiting screen's request, ticket included.
func provisionStatusPath(slug string) string {
	return "/v1/farms/" + slug + "/provision-status?ticket=" + provisionTicketFor(slug)
}

func readyEmailPath(slug string) string {
	return "/v1/farms/" + slug + "/ready-email?ticket=" + provisionTicketFor(slug)
}

// provisionRunRef is the opaque title the platform gives a farm's
// provision-tenant run (httpapi.provisionRunRef).
func provisionRunRef(slug string) string {
	return testSigner.OpaqueRef("provision-run", slug)
}
