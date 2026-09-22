package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

type tenantProvision struct {
	Slug      string
	FarmName  string
	Email     string
	OwnerName string
	Phone     string
}

// kickTenantProvision asks GitHub Actions to commit a dedicated tenant into
// gitops. Argo then creates namespace, Postgres and API/web pods. Failures
// are logged: the farm already exists on the shared platform.
func (s *Server) kickTenantProvision(p tenantProvision) {
	token := strings.TrimSpace(s.cfg.GitHubDispatchToken)
	repo := strings.TrimSpace(s.cfg.GitHubDispatchRepo)
	if token == "" || repo == "" || p.Slug == "" {
		return
	}
	go func() {
		body, err := json.Marshal(map[string]any{
			"event_type": "provision-tenant",
			"client_payload": map[string]string{
				"slug":      p.Slug,
				"farmName":  p.FarmName,
				"email":     p.Email,
				"ownerName": p.OwnerName,
				"phone":     p.Phone,
				"mode":      "dedicated",
			},
		})
		if err != nil {
			return
		}
		req, err := http.NewRequest(http.MethodPost,
			"https://api.github.com/repos/"+repo+"/dispatches", bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 15 * time.Second}
		res, err := client.Do(req)
		if err != nil {
			slog.Error("tenant provision dispatch", "slug", p.Slug, "err", err)
			return
		}
		defer res.Body.Close()
		if res.StatusCode >= 300 {
			slog.Error("tenant provision dispatch", "slug", p.Slug, "status", res.StatusCode)
			return
		}
		slog.Info("tenant provision dispatched", "slug", p.Slug)
	}()
}
