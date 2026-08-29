package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

func (s *Server) handleListPlots(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := store.ListPlots(r.Context(), tx, r.URL.Query().Get("includeDeleted") == "true")
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (s *Server) handleGetPlot(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	p, err := store.GetPlot(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// handleCreatePlot takes the plot and its crops in one body, because the form
// the owner fills in is one form: identity and location, then what is planted.
func (s *Server) handleCreatePlot(w http.ResponseWriter, r *http.Request) {
	var body store.Plot
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Name == "" {
		writeError(w, r, domain.BadRequest("name is required"))
		return
	}
	if body.ID == "" {
		body.ID = newID()
	}
	for i := range body.Crops {
		if body.Crops[i].ID == "" {
			body.Crops[i].ID = newID()
		}
		if body.Crops[i].CropType == "" && body.Crops[i].CropTypeID == "" {
			writeError(w, r, domain.BadRequest("every crop needs cropTypeId or cropType"))
			return
		}
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
	if existing, err := store.GetPlot(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}

	created, err := store.CreatePlot(r.Context(), tx, farmID, body, newID)
	if err != nil {
		if store.IsUniqueViolation(err, "ux_plots_name") {
			writeError(w, r, domain.Conflict(domain.CodeDuplicateName,
				"this farm already has a plot with that name"))
			return
		}
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleUpdatePlot(w http.ResponseWriter, r *http.Request) {
	var body store.Plot
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	updated, err := store.UpdatePlot(r.Context(), tx, chi.URLParam(r, "id"), body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleDeletePlot is a logical delete, and it refuses while something is
// still planted: taking a plot out of service under a live crop would orphan
// the work records that point at that crop.
func (s *Server) handleDeletePlot(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	n, err := store.CountActiveCrops(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if n > 0 {
		writeError(w, r, domain.Conflict(domain.CodePlotHasActiveCrops,
			"remove the crops before taking the plot out of service").
			WithDetails(map[string]any{"activeCrops": n}))
		return
	}
	if err := store.SoftDeletePlot(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

func (s *Server) handleCreatePlotCrop(w http.ResponseWriter, r *http.Request) {
	var body store.PlotCrop
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.CropType == "" && body.CropTypeID == "" {
		writeError(w, r, domain.BadRequest("cropTypeId or cropType is required"))
		return
	}
	if body.ID == "" {
		body.ID = newID()
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
	created, err := store.CreatePlotCrop(r.Context(), tx, farmID, chi.URLParam(r, "id"), body, newID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleDeletePlotCrop(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	err = store.SoftDeletePlotCrop(r.Context(), tx,
		chi.URLParam(r, "id"), chi.URLParam(r, "cropId"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}
