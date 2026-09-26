package httpapi

import (
	"net/http"
	"regexp"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// ---------------------------------------------------------------------------
// The farm's base price, effective-dated (migration 00030).
//
// "Precio del kilo, desde el lunes X": the onboarding tour's first step and
// the price screen both write here. A week with its own price keeps it, and a
// settled weighing keeps the price it was settled at — a new base price only
// moves unsettled work, which the impact route counts before the owner saves.
// ---------------------------------------------------------------------------

func basePriceJSON(st *store.BasePriceState) map[string]any {
	hist := make([]map[string]any, 0, len(st.History))
	for _, p := range st.History {
		hist = append(hist, map[string]any{
			"validFrom":  p.ValidFrom.Format("2006-01-02"),
			"priceCents": p.PriceMinor,
			"createdAt":  p.CreatedAt,
		})
	}
	return map[string]any{
		"currentCents": st.CurrentMinor,
		"confirmed":    st.Confirmed,
		"thisWeek":     st.ThisWeek.Format("2006-01-02"),
		"history":      hist,
	}
}

func (s *Server) handleGetBasePrice(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	st, err := store.GetBasePrice(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, basePriceJSON(st))
}

func (s *Server) handleBasePriceImpact(w http.ResponseWriter, r *http.Request) {
	monday, err := parseMonday(chi.URLParam(r, "monday"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	im, err := store.GetBasePriceImpact(r.Context(), tx, monday)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, im)
}

func (s *Server) handleSetBasePrice(w http.ResponseWriter, r *http.Request) {
	monday, err := parseMonday(chi.URLParam(r, "monday"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	var body struct {
		PriceCents int64 `json:"priceCents"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.PriceCents <= 0 {
		writeError(w, r, domain.BadRequest("priceCents must be positive"))
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farmID, err := tenant.FarmID(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	userID := ""
	if p, ok := auth.PrincipalFrom(r.Context()); ok {
		userID = p.UserID
	}
	if err := store.SetBasePrice(r.Context(), tx, farmID, userID, monday, body.PriceCents); err != nil {
		writeError(w, r, err)
		return
	}
	st, err := store.GetBasePrice(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, basePriceJSON(st))
}

// ---------------------------------------------------------------------------
// Guided tour progress, the caller's own.
// ---------------------------------------------------------------------------

var tourName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,39}$`)

func (s *Server) handleListTours(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	items, err := store.ListTours(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleSaveTour(w http.ResponseWriter, r *http.Request) {
	tour := chi.URLParam(r, "tour")
	if !tourName.MatchString(tour) {
		writeError(w, r, domain.BadRequest("tour must be a short lowercase name"))
		return
	}
	var body struct {
		Step   int    `json:"step"`
		Status string `json:"status"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	switch body.Status {
	case "active", "later", "dismissed", "done":
	default:
		writeError(w, r, domain.BadRequest("status must be active, later, dismissed or done"))
		return
	}
	if body.Step < 0 || body.Step > 100 {
		writeError(w, r, domain.BadRequest("step must be between 0 and 100"))
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	t, err := store.SaveTour(r.Context(), tx, tour, body.Step, body.Status)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}
