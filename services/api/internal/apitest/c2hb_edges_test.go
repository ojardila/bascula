// SPDX-License-Identifier: MIT

package apitest

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// Coverage round 2, batch B: answers that depend on what the database holds
// or refuses, reached by putting exactly that in the database.

func (h *harness) c2hbExec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := h.admin.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

// c2hbCheckFault makes UPDATEs of one row of table fail with a CHECK
// violation of the named constraint, the way the real constraint would, and
// removes the trigger when the test ends.
func (h *harness) c2hbCheckFault(t *testing.T, table, constraint, id string) {
	t.Helper()
	fn := "c2hb_fault_" + table
	h.c2hbExec(t, `CREATE OR REPLACE FUNCTION `+fn+`() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
		  RAISE EXCEPTION 'c2hb injected' USING ERRCODE = '23514', CONSTRAINT = '`+constraint+`';
		END $$`)
	h.c2hbExec(t, `CREATE TRIGGER `+fn+` BEFORE UPDATE ON `+table+
		` FOR EACH ROW WHEN (OLD.id = '`+id+`'::uuid) EXECUTE FUNCTION `+fn+`()`)
	t.Cleanup(func() {
		_, _ = h.admin.Exec(context.Background(), `DROP TRIGGER IF EXISTS `+fn+` ON `+table)
		_, _ = h.admin.Exec(context.Background(), `DROP FUNCTION IF EXISTS `+fn+`()`)
	})
}

// A session opened before sign-in methods were recorded is listed as
// "unknown", not as an empty string.
func TestC2hbSessionWithoutAMethod(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca c2hb sesiones", 250000)
	h.c2hbExec(t, `UPDATE refresh_tokens SET sign_in_method = NULL WHERE user_id = $1 AND farm_id = $2`,
		f.OwnerUserID, f.FarmID)
	items := sessionItems(t, h.do(t, http.MethodGet, "/v1/me/sessions", f.OwnerToken, nil))
	if len(items) == 0 {
		t.Fatal("no sessions listed")
	}
	for id, it := range items {
		if it["method"] != "unknown" {
			t.Fatalf("session %s: method %v, want unknown", id, it["method"])
		}
	}
}

// A connection whose client registered no name, that was granted read only
// and whose token has run out is listed as such: «Asistente», read, expired.
func TestC2hbMCPConnectionExpiredReadOnlyUnnamed(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca c2hb conexiones", 250000)
	g := h.oauthGrant(t, f, "ChatGPT")
	client := g["client_id"].(string)
	h.c2hbExec(t, `UPDATE oauth_clients SET name = '' WHERE id = $1`, client)
	h.c2hbExec(t, `UPDATE refresh_tokens SET expires_at = now() - interval '1 hour', scope = 'mcp:read'
	                WHERE oauth_client_id = $1`, client)
	res := h.mustDo(t, http.MethodGet, "/v1/mcp/connections", f.OwnerToken, nil, http.StatusOK)
	items := connectionItems(t, res)
	if len(items) != 1 {
		t.Fatalf("connections: %s", res.Raw)
	}
	it := items[0]
	if it["clientName"] != "Asistente" || it["status"] != "expired" || it["access"] != "read" {
		t.Fatalf("connection: %v", it)
	}
}

// The database's own size CHECK firing on confirmation answers 413, like the
// counting does, and the bytes already written are removed.
func TestC2hbUploadRefusedByTheSizeCheck(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca c2hb adjuntos", 250000)
	u := uploadLimitFixture{h: h, f: f}
	id, uploadURL := u.newTicket(t, 2048)
	h.c2hbCheckFault(t, "attachments", "attachments_size", id)

	// A server of its own, so its upload directory holds only this upload.
	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	srv := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)
	req := httptest.NewRequest(http.MethodPut, uploadURL, bytes.NewReader(pngOf(2048)))
	req.RemoteAddr = "10.0.0.1:12345"
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge ||
		!strings.Contains(rec.Body.String(), string(domain.CodeUploadTooLarge)) {
		t.Fatalf("got %d %s, want 413 UPLOAD_TOO_LARGE", rec.Code, rec.Body.String())
	}
	got := h.mustDo(t, http.MethodGet, "/v1/uploads/"+id, f.OwnerToken, nil, http.StatusOK)
	if got.Body["status"] == "ready" {
		t.Fatalf("the refused upload is ready: %s", got.Raw)
	}
	var left []string
	_ = filepath.WalkDir(cfg.UploadDir, func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			left = append(left, path)
		}
		return nil
	})
	if len(left) != 0 {
		t.Fatalf("the refused bytes are still on disk: %v", left)
	}
}

// A timezone the pre-check accepted and the table's CHECK then refused is
// still a form error, not a 500.
func TestC2hbFarmTimezoneRefusedByTheCheck(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca c2hb zona", 250000)
	h.c2hbCheckFault(t, "farms", "farms_tz_valid", f.FarmID)
	res := h.do(t, http.MethodPut, "/v1/farm", f.OwnerToken, map[string]any{"name": "Finca c2hb zona"})
	if res.Status != http.StatusBadRequest || !strings.Contains(res.Raw, "IANA timezone") {
		t.Fatalf("got %d %s, want 400 invalid timezone", res.Status, res.Raw)
	}
}

// Refused writes are audited with what was asked: never the confirmation
// token, and only the parameter names when the arguments are too big to keep.
func TestC2hbMCPRefusalAuditArguments(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca c2hb auditoria", 250000)
	// A weigher may not create workers: refused by role, after the arguments
	// were read, so the refusal is audited with them.
	wsess := h.mcpClient(t, f.WeigherToken)
	huge := strings.Repeat("n", 9000)
	if res := callTool(t, wsess, "create_worker", map[string]any{"name": huge, "tag": "C2-1"}); !res.IsError {
		t.Fatal("a weigher created a worker")
	}
	price := map[string]any{"scope": "week", "monday": "2026-08-24", "priceCents": 300000,
		"confirmationToken": "c2hb-token"}
	if res := callTool(t, wsess, "set_kilo_price", price); !res.IsError {
		t.Fatal("a weigher set the price")
	}

	got := h.mustDo(t, http.MethodGet, "/v1/mcp/activity?limit=500", f.OwnerToken, nil, http.StatusOK)
	var body struct {
		Items []struct {
			Tool, Outcome string
			Args          map[string]any
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(got.Raw), &body); err != nil {
		t.Fatal(err)
	}
	var sawTruncated, sawPrice bool
	for _, it := range body.Items {
		if strings.Contains(got.Raw, "c2hb-token") {
			t.Fatalf("the confirmation token was stored: %s", got.Raw)
		}
		switch it.Tool + "/" + it.Outcome {
		case "create_worker/refused":
			keys, _ := it.Args["keys"].([]any)
			if it.Args["truncated"] != true || len(keys) != 2 || strings.Contains(got.Raw, huge) {
				t.Fatalf("oversized arguments: %v", it.Args)
			}
			sawTruncated = true
		case "set_kilo_price/refused":
			if _, ok := it.Args["confirmationToken"]; ok || it.Args["priceCents"] == nil {
				t.Fatalf("refused price arguments: %v", it.Args)
			}
			sawPrice = true
		}
	}
	if !sawTruncated || !sawPrice {
		t.Fatalf("audit rows: %s", got.Raw)
	}
}
