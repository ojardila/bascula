package apitest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
	"github.com/ojardila/bascula/services/api/internal/mailer"
)

type recordingMailer struct {
	mu   sync.Mutex
	sent []mailer.Message
	fail atomic.Bool
}

func (m *recordingMailer) Send(_ context.Context, msg mailer.Message) error {
	if m.fail.Load() {
		return context.DeadlineExceeded
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, msg)
	return nil
}

func (m *recordingMailer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sent)
}

// TestReadyEmailIsOfferedOnlyWithAMailer: the shared harness has no mailer,
// so the status says so and the endpoint does not exist in any useful sense.
func TestReadyEmailIsOfferedOnlyWithAMailer(t *testing.T) {
	h := requireDB(t)
	slug := "sin-correo-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")
	signupWithSlug(t, h.server, "Sin correo", slug)
	st := h.do(t, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
	if st.Status != http.StatusOK || st.Body["notifyAvailable"] != false || st.Body["notifyRequested"] != false {
		t.Fatalf("status without a mailer: %d %s", st.Status, st.Raw)
	}
	res := h.do(t, http.MethodPost, "/v1/farms/"+slug+"/ready-email", "", nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("ready-email without a mailer: %d %s", res.Status, res.Raw)
	}
}

// TestReadyEmailGoesToTheOwnerOnceWhenTheFarmIsReady walks the whole thing:
// ask while the address is not up, the address comes up, exactly one email
// to the owner with the farm's link, and asking again sends nothing more.
func TestReadyEmailGoesToTheOwnerOnceWhenTheFarmIsReady(t *testing.T) {
	h := requireDB(t)
	slug := "con-correo-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")

	var up atomic.Bool
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" && up.Load() {
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		http.Error(w, "not yet", http.StatusServiceUnavailable)
	}))
	defer public.Close()

	uploads, _ := os.MkdirTemp("", "bascula-mail-uploads-")
	defer os.RemoveAll(uploads)
	mail := &recordingMailer{}
	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = uploads
	cfg.SignupsPerIPPerHour = 1000
	cfg.SignupsPerEmailPerHour = 1000
	cfg.TenantPublicURL = public.URL
	cfg.ProvisionPollEvery = 50 * time.Millisecond
	cfg.ProvisionWatchFor = 30 * time.Second
	cfg.Mailer = mail
	platform := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)

	ownerEmail := signupWithSlug(t, platform, "La Ceiba", slug)

	st := call(t, platform, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
	if st.Body["notifyAvailable"] != true || st.Body["notifyRequested"] != false || st.Body["ready"] != false {
		t.Fatalf("status before asking: %s", st.Raw)
	}

	// The first send fails; the claim is released and the next check retries.
	mail.fail.Store(true)
	req := call(t, platform, http.MethodPost, "/v1/farms/"+slug+"/ready-email", "", nil)
	if req.Status != http.StatusAccepted || req.Body["requested"] != true {
		t.Fatalf("ready-email: %d %s", req.Status, req.Raw)
	}
	if _, leaked := req.Body["email"]; leaked {
		t.Fatalf("ready-email must not reveal the owner's address: %s", req.Raw)
	}
	st = call(t, platform, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
	if st.Body["notifyRequested"] != true {
		t.Fatalf("status after asking: %s", st.Raw)
	}

	time.Sleep(200 * time.Millisecond)
	if mail.count() != 0 {
		t.Fatalf("sent %d emails before the farm was ready", mail.count())
	}
	up.Store(true)
	time.Sleep(300 * time.Millisecond) // a failed attempt or two
	mail.fail.Store(false)

	// The watcher gave up on the failed send's claim; a polling screen (or a
	// restarted process) picks it up again.
	waitFor(t, 10*time.Second, "ready email", func() bool {
		if mail.count() > 0 {
			return true
		}
		call(t, platform, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
		platform.ResumeReadyEmails(context.Background())
		return false
	})
	time.Sleep(300 * time.Millisecond)
	if n := mail.count(); n != 1 {
		t.Fatalf("sent %d emails, want exactly 1", n)
	}
	msg := mail.sent[0]
	if !strings.EqualFold(msg.To, ownerEmail) {
		t.Fatalf("email to %q, want the owner %q", msg.To, ownerEmail)
	}
	if msg.Subject != "Su finca ya está lista" || !strings.Contains(msg.Body, public.URL+"/entrar") ||
		!strings.Contains(msg.Body, "La Ceiba") {
		t.Fatalf("email = %+v", msg)
	}

	// Asking again, polling again, resuming again: still one email.
	call(t, platform, http.MethodPost, "/v1/farms/"+slug+"/ready-email", "", nil)
	call(t, platform, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
	platform.ResumeReadyEmails(context.Background())
	time.Sleep(400 * time.Millisecond)
	if n := mail.count(); n != 1 {
		t.Fatalf("sent %d emails after asking twice, want 1", n)
	}

	// Unknown farm.
	missing := call(t, platform, http.MethodPost, "/v1/farms/no-existe-"+uuid.NewString()[:6]+"/ready-email", "", nil)
	if missing.Status != http.StatusNotFound {
		t.Fatalf("unknown farm: %d %s", missing.Status, missing.Raw)
	}
}
