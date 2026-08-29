package httpapi

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/blob"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// File uploads. RSP-004 wants a photo of the employee, RSP-027 a photo of the
// sale receipt, both "hasta 5 MB".
//
// # The shape
//
// Two steps, in the shape a presigned URL takes, because that is what this
// will be as soon as there is a bucket:
//
//	POST /v1/uploads              reserves a row and answers where to PUT
//	PUT  /v1/uploads/{id}/content sends the bytes
//
// There is no object storage in this environment, so `uploadUrl` points back
// at this same service and internal/blob writes to disk. The seam is the point:
// swapping in S3 is one file in internal/blob and a different `uploadUrl`, and
// no handler here changes. That is said plainly rather than hidden — a disk on
// one box does not replicate, and two API processes need a shared volume.
//
// # The limit
//
// THE 5 MB IS ENFORCED WHEN THE BYTES ARRIVE, not when the URL is handed out.
// A limit checked at step one is a limit checked against a number the client
// typed, and a client that lies gets to store whatever it likes. So:
//
//   - step one records no size at all, however loudly the client declares one;
//   - step two reads limit+1 bytes and refuses at limit+1 — reading exactly
//     limit and stopping would accept a 6 MB file silently truncated to 5;
//   - the row is confirmed with the byte count the SERVER measured;
//   - and a CHECK on attachments refuses anything over 5 MB whatever wrote it.
//
// The declared Content-Type is treated the same way: advisory at step one,
// sniffed from the actual bytes at step two. Taking the client's word for the
// media type is how a .exe becomes a "photo".

// allowedUploadTypes is what a farm photo or a receipt can be. Sniffed, never
// declared. PDF is in because a cooperativa's receipt often is one.
var allowedUploadTypes = map[string]bool{
	"image/jpeg":      true,
	"image/png":       true,
	"image/webp":      true,
	"image/gif":       true,
	"application/pdf": true,
}

// handleCreateUpload is step one: a pending row and somewhere to put the bytes.
func (s *Server) handleCreateUpload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
		// Purpose is a label for the operator ("worker-photo",
		// "sale-receipt"); it constrains nothing, because what an attachment
		// may be hung on is decided by the foreign keys, not by a string.
		Purpose      string `json:"purpose"`
		OriginalName string `json:"filename"`
		// ContentType and Bytes are accepted and deliberately NOT stored. They
		// let a client render a progress bar. They decide nothing: the server
		// measures both when the bytes land.
		ContentType string `json:"contentType"`
		Bytes       int64  `json:"bytes"`
	}
	if err := decodeOptional(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Bytes > store.MaxUploadBytes {
		// A courtesy, not the guarantee: it saves the client uploading five
		// megabytes it is about to be refused. The refusal that counts happens
		// when the bytes arrive.
		writeError(w, r, domain.Coded(http.StatusRequestEntityTooLarge,
			domain.CodeUploadTooLarge, "the limit is 5 MB").
			WithDetails(map[string]any{"maxBytes": store.MaxUploadBytes}))
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
	if existing, err := store.GetAttachment(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, uploadResponse(existing))
		return
	}
	a, err := store.CreatePendingAttachment(r.Context(), tx, farmID, body.ID,
		blob.Key(farmID, body.ID), body.Purpose, body.OriginalName, principalID(r))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, uploadResponse(a))
}

func uploadResponse(a *store.Attachment) map[string]any {
	return map[string]any{
		"attachment": a,
		// Relative, because the client already knows the host it is talking
		// to and a server that guesses its own public URL guesses wrong behind
		// the first proxy it meets.
		"uploadUrl":     "/v1/uploads/" + a.ID + "/content",
		"uploadMethod":  http.MethodPut,
		"maxBytes":      store.MaxUploadBytes,
		"acceptedTypes": sortedTypes(),
	}
}

func sortedTypes() []string {
	out := make([]string, 0, len(allowedUploadTypes))
	for t := range allowedUploadTypes {
		out = append(out, t)
	}
	// Stable order so the response is diffable.
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

// handlePutUploadContent is step two, and the only place in this service that
// reads a request body that is not JSON.
func (s *Server) handlePutUploadContent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	// The attachment has to be ours before a single byte is written to disk.
	// Without this, a stranger's id would create a file on our filesystem on
	// the way to a 404.
	a, err := store.GetAttachment(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if a.Status == "ready" {
		// Idempotent by (farm_id, id) like every other write: resending the
		// bytes after a timeout answers with the attachment, not a conflict.
		writeJSON(w, http.StatusOK, a)
		return
	}

	// Content-Length is a hint and is checked because it is free, but it is
	// not the check. A chunked request has no Content-Length at all, and a
	// lying one is exactly the case the counting below exists for.
	if r.ContentLength > store.MaxUploadBytes {
		writeError(w, r, tooLarge())
		return
	}

	res, err := s.blobs.Put(r.Context(), a.ObjectKey, r.Body, store.MaxUploadBytes)
	if err != nil {
		if errors.Is(err, blob.ErrTooLarge) {
			writeError(w, r, tooLarge())
			return
		}
		writeError(w, r, domain.BadRequest("could not store the upload").WithCause(err))
		return
	}

	// The media type comes from the bytes, never from the header.
	mime := http.DetectContentType(res.Head)
	if i := strings.Index(mime, ";"); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	if !allowedUploadTypes[mime] {
		// Nothing that is refused stays on disk.
		_ = s.blobs.Delete(r.Context(), a.ObjectKey)
		writeError(w, r, domain.Coded(http.StatusUnsupportedMediaType,
			domain.CodeUnsupportedMediaType,
			"that file is a "+mime+"; a photo or a PDF is expected").
			WithDetails(map[string]any{"detected": mime, "accepted": sortedTypes()}))
		return
	}

	confirmed, err := store.ConfirmAttachment(r.Context(), tx, id, mime, res.Bytes, res.SHA256)
	if err != nil {
		_ = s.blobs.Delete(r.Context(), a.ObjectKey)
		if store.IsCheckViolation(err, "attachments_size") {
			// The CHECK, catching what the counting somehow did not. Belt and
			// braces on the one number that decides how much disk a stranger
			// can spend.
			writeError(w, r, tooLarge())
			return
		}
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, confirmed)
}

func tooLarge() *domain.Error {
	return domain.Coded(http.StatusRequestEntityTooLarge, domain.CodeUploadTooLarge,
		"the file is larger than 5 MB").
		WithDetails(map[string]any{"maxBytes": store.MaxUploadBytes})
}

func (s *Server) handleGetUpload(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	a, err := store.GetAttachment(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// handleGetUploadContent streams the bytes back. It goes through the same
// tenant transaction as everything else, so an attachment of another farm is
// a 404 before the filesystem is touched — the object key is never the thing
// that grants access.
func (s *Server) handleGetUploadContent(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	a, err := store.GetAttachment(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	if a.Status != "ready" {
		writeError(w, r, domain.Conflict(domain.CodeUploadNotReady,
			"that upload has no bytes yet"))
		return
	}
	rc, size, err := s.blobs.Open(r.Context(), a.ObjectKey)
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) {
			// The row says ready and the object is gone. That is a real
			// inconsistency and it is logged as one rather than dressed up as
			// a 404, which would send somebody looking for a deleted photo.
			writeError(w, r, domain.Internal("the stored object is missing").WithCause(err))
			return
		}
		writeError(w, r, err)
		return
	}
	defer func() { _ = rc.Close() }()

	if a.Mime != nil {
		w.Header().Set("Content-Type", *a.Mime)
	}
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	// The bytes are a farm's private photograph. No shared cache gets a copy.
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, rc)
}
