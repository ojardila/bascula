package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Products and inventory — RSP-018 … RSP-025.
//
// One rule runs through every handler below and is worth stating once: the
// quantity on hand is never read from a column, because there is no column. It
// is a SUM over stock_moves, computed on the way out. That is the same
// discipline the balance gets from the ledger and it is there for the same
// reason: a stored total is a total that some day disagrees with the facts
// underneath it, and when it does, nothing can say which of the two is lying.

func (s *Server) handleListProducts(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := store.ListProducts(r.Context(), tx, listFilter(r),
		r.URL.Query().Get("categoryId"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (s *Server) handleGetProduct(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	p, err := store.GetProduct(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleCreateProduct(w http.ResponseWriter, r *http.Request) {
	var body store.NewProduct
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Name == "" {
		writeError(w, r, domain.BadRequest("name is required"))
		return
	}
	if (body.StorageUnitID == nil || *body.StorageUnitID == "") && body.StorageUnit == "" {
		writeError(w, r, domain.BadRequest("storageUnitId or storageUnit is required"))
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
	// Idempotent by (farm_id, id): retrying after a timeout returns the
	// resource, not a conflict.
	if existing, err := store.GetProduct(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}
	created, err := store.CreateProduct(r.Context(), tx, farmID, body, newID)
	if err != nil {
		if store.IsUniqueViolation(err, "ux_products_name") {
			writeError(w, r, domain.Conflict(domain.CodeDuplicateName,
				"this farm already has a product with that name"))
			return
		}
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

type updateProductRequest struct {
	store.NewProduct
	Status string `json:"status"`
}

func (s *Server) handleUpdateProduct(w http.ResponseWriter, r *http.Request) {
	var body updateProductRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if err := validStatus(body.Status); err != nil {
		writeError(w, r, err)
		return
	}
	id := chi.URLParam(r, "id")
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
	// The product has to be ours before anything is written, and before a
	// catalogue row is created on its behalf: resolving "Materia prima" into
	// a new category for a product of another farm would leave a row behind
	// on the way to a 404.
	if _, err := store.GetProduct(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	switch body.Status {
	case "inactive":
		if err := store.SoftDeleteProduct(r.Context(), tx, id); err != nil && err != store.NoRows {
			writeError(w, r, err)
			return
		}
	case "active":
		if err := store.RestoreProduct(r.Context(), tx, id); err != nil {
			writeError(w, r, err)
			return
		}
	}
	updated, err := store.UpdateProduct(r.Context(), tx, farmID, id, body.NewProduct, newID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleDeleteProduct is RSP-021: eliminar deja el producto inactivo. Its
// movements stay exactly where they are — they are facts, and a product
// leaving the catalogue does not un-harvest last week's coffee.
func (s *Server) handleDeleteProduct(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.SoftDeleteProduct(r.Context(), tx, chi.URLParam(r, "id")); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

func (s *Server) handleListCustomers(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := store.ListCustomers(r.Context(), tx, listFilter(r))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

// handleCreateCustomer is idempotent by (farm_id, lower(name)) and answers
// 200, like every other picker in this service: the sales screen must not be
// able to produce two "Cooperativa" that are different rows.
func (s *Server) handleCreateCustomer(w http.ResponseWriter, r *http.Request) {
	var body store.Customer
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
	c, err := store.EnsureCustomer(r.Context(), tx, farmID, body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// principalID is the caller's user id, for the created_by columns.
func principalID(r *http.Request) string {
	if p, ok := auth.PrincipalFrom(r.Context()); ok {
		return p.UserID
	}
	return ""
}
