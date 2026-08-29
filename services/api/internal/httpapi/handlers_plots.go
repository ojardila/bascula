package httpapi

import (
	"encoding/json"
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
	list, err := store.ListPlots(r.Context(), tx, listFilter(r))
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
	// plots.area_ha and plot_crops.area_ha are numeric(10, 3).
	if err := checkFixedScale("areaHa", body.AreaHa,
		domain.AreaPrecision, domain.AreaScale); err != nil {
		writeError(w, r, err)
		return
	}
	for i := range body.Crops {
		if body.Crops[i].ID == "" {
			body.Crops[i].ID = newID()
		}
		if body.Crops[i].CropType == "" && body.Crops[i].CropTypeID == "" {
			writeError(w, r, domain.BadRequest("every crop needs cropTypeId or cropType"))
			return
		}
		if err := checkFixedScale("crops[].areaHa", body.Crops[i].AreaHa,
			domain.AreaPrecision, domain.AreaScale); err != nil {
			writeError(w, r, err)
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
	// The form is one form: identity, location, what is planted, and the
	// shape drawn on the map. A boundary sent here is stored here rather than
	// quietly dropped — an ignored field in an accepted request is the worst
	// of both answers.
	if hasBoundary(body.Boundary) {
		withShape, err := store.SetPlotBoundary(r.Context(), tx, created.ID, body.Boundary)
		if err != nil {
			writeError(w, r, err)
			return
		}
		withShape.Crops = created.Crops
		created = withShape
	}
	writeJSON(w, http.StatusCreated, created)
}

type updatePlotRequest struct {
	store.Plot
	Status string `json:"status"`
}

func (s *Server) handleUpdatePlot(w http.ResponseWriter, r *http.Request) {
	var body updatePlotRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if err := validStatus(body.Status); err != nil {
		writeError(w, r, err)
		return
	}
	if err := checkFixedScale("areaHa", body.AreaHa,
		domain.AreaPrecision, domain.AreaScale); err != nil {
		writeError(w, r, err)
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	switch body.Status {
	case "inactive":
		// The same refusal DELETE makes, for the same reason: a plot taken out
		// of service under a live crop orphans the work records pointing at
		// that crop.
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
		if err := store.SoftDeletePlot(r.Context(), tx, id); err != nil && err != store.NoRows {
			writeError(w, r, err)
			return
		}
	case "active":
		if _, err := store.RestorePlot(r.Context(), tx, id); err != nil {
			writeError(w, r, err)
			return
		}
	}

	updated, err := store.UpdatePlot(r.Context(), tx, id, body.Plot)
	if err != nil {
		if body.Status == "inactive" {
			if p, getErr := store.GetPlot(r.Context(), tx, id); getErr == nil {
				writeJSON(w, http.StatusOK, p)
				return
			}
		}
		writeError(w, r, err)
		return
	}
	if hasBoundary(body.Boundary) {
		withShape, err := store.SetPlotBoundary(r.Context(), tx, id, body.Boundary)
		if err != nil {
			writeError(w, r, err)
			return
		}
		withShape.Crops = updated.Crops
		updated = withShape
	}
	writeJSON(w, http.StatusOK, updated)
}

func hasBoundary(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null"
}

// handleSetPlotBoundary stores the polygon the owner drew, as GeoJSON in and
// GeoJSON out. PostGIS never crosses this boundary — literally the point of
// keeping the wire format GeoJSON: the web and the phone never see a geography
// type, and swapping the engine stays possible.
//
// The response carries both hectare figures and a list of the plots this one
// now overlaps. The overlap is a warning and never a refusal: two plots that
// touch on the map are usually a drawing that wants a second look, and
// sometimes they are a terrace above a coffee lot. The server does not get to
// decide which, so it says what it sees and stores what it was given.
func (s *Server) handleSetPlotBoundary(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Boundary json.RawMessage `json:"boundary"`
		GeoJSON  json.RawMessage `json:"geojson"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	geo := body.Boundary
	if len(geo) == 0 {
		geo = body.GeoJSON
	}
	if len(geo) == 0 || string(geo) == "null" {
		writeError(w, r, domain.BadRequest("boundary is required, as a GeoJSON geometry"))
		return
	}

	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	// The plot has to be ours before ST_GeomFromGeoJSON is allowed to raise:
	// the UPDATE below would touch no row for a plot of another farm and come
	// back as a bare 404 anyway, but doing it in this order keeps the
	// geometry error from masking the tenant one.
	if _, err := store.GetPlot(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}

	plot, err := store.SetPlotBoundary(r.Context(), tx, id, geo)
	if err != nil {
		writeError(w, r, err)
		return
	}
	overlaps, err := store.OverlappingPlots(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"plot": plot, "overlaps": overlaps,
	})
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
	if err := checkFixedScale("areaHa", body.AreaHa,
		domain.AreaPrecision, domain.AreaScale); err != nil {
		writeError(w, r, err)
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
