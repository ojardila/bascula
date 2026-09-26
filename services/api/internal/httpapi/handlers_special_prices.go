package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// ---------------------------------------------------------------------------
// Special kilo prices per lote and per person (migration 00034).
//
// Fixed prices from a Monday on. Precedence, first match wins:
// persona > lote > semana > finca (kilo_price() in the migration). A settled
// weighing keeps the price it was settled at; the impact route counts what a
// new entry would move before the owner saves it.
// ---------------------------------------------------------------------------

func specialPricesJSON(items []store.SpecialPrice) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		hist := make([]map[string]any, 0, len(it.History))
		for _, h := range it.History {
			hist = append(hist, map[string]any{
				"validFrom":  h.ValidFrom.Format("2006-01-02"),
				"priceCents": h.PriceMinor,
				"createdAt":  h.CreatedAt,
			})
		}
		out = append(out, map[string]any{
			"kind":         it.Kind,
			"targetId":     it.TargetID,
			"targetName":   it.TargetName,
			"currentCents": it.CurrentMinor,
			"history":      hist,
		})
	}
	return out
}

func (s *Server) handleListSpecialPrices(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	items, err := store.ListSpecialPrices(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": specialPricesJSON(items)})
}

// specialTarget parses {kind}/{id}/{monday} and checks the lote or person is
// on this farm.
func specialTarget(r *http.Request) (store.SpecialKind, string, error) {
	kind, err := store.ParseSpecialKind(chi.URLParam(r, "kind"))
	if err != nil {
		return "", "", err
	}
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		return "", "", domain.NotFound("no such lote or person")
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		return "", "", err
	}
	ok, err := store.SpecialTargetExists(r.Context(), tx, kind, id)
	if err != nil {
		return "", "", err
	}
	if !ok {
		return "", "", domain.NotFound("no such lote or person")
	}
	return kind, id, nil
}

func (s *Server) handleSpecialPriceImpact(w http.ResponseWriter, r *http.Request) {
	monday, err := parseMonday(chi.URLParam(r, "monday"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	kind, id, err := specialTarget(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, _ := tenant.Tx(r.Context())
	im, err := store.GetSpecialPriceImpact(r.Context(), tx, kind, id, monday)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, im)
}

func (s *Server) handleSetSpecialPrice(w http.ResponseWriter, r *http.Request) {
	monday, err := parseMonday(chi.URLParam(r, "monday"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	var body struct {
		PriceCents json.RawMessage `json:"priceCents"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	// priceCents is required: a positive integer, or null to end the
	// exception from that Monday. Absent is a mistake, not "end it".
	if len(body.PriceCents) == 0 {
		writeError(w, r, domain.BadRequest("priceCents is required (a positive integer, or null to end the special price)"))
		return
	}
	var price *int64
	if string(body.PriceCents) != "null" {
		var v int64
		if err := json.Unmarshal(body.PriceCents, &v); err != nil || v <= 0 {
			writeError(w, r, domain.BadRequest("priceCents must be a positive integer or null"))
			return
		}
		price = &v
	}
	kind, id, err := specialTarget(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, _ := tenant.Tx(r.Context())
	farmID, err := tenant.FarmID(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	userID := ""
	if p, ok := auth.PrincipalFrom(r.Context()); ok {
		userID = p.UserID
	}
	if err := store.SetSpecialPrice(r.Context(), tx, farmID, userID, kind, id, monday, price); err != nil {
		writeError(w, r, err)
		return
	}
	s.handleListSpecialPrices(w, r)
}

func (s *Server) handleDeleteSpecialPrice(w http.ResponseWriter, r *http.Request) {
	monday, err := parseMonday(chi.URLParam(r, "monday"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	kind, id, err := specialTarget(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, _ := tenant.Tx(r.Context())
	if err := store.DeleteSpecialPrice(r.Context(), tx, kind, id, monday); err != nil {
		writeError(w, r, err)
		return
	}
	s.handleListSpecialPrices(w, r)
}
