// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestLedgerResendMustMatch: a movement resent under the same id is a retry
// only when the day, the method and the receiver it states are the ones on
// file. A difference in any of them is a 409, not a second movement and not a
// silent 200.
func TestLedgerResendMustMatch(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca reenvíos", 250000)
	worker := h.createWorker(t, f, "Rosa", "73000001")

	with := func(body map[string]any, k string, v any) map[string]any {
		out := map[string]any{k: v}
		for kk, vv := range body {
			if kk != k {
				out[kk] = vv
			}
		}
		return out
	}
	advance := map[string]any{"id": uuid.NewString(), "workerId": worker, "amountCents": 100000,
		"method": "efectivo", "date": "2026-08-26"}
	h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, advance, http.StatusCreated)
	h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, advance, http.StatusOK)
	h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, with(advance, "date", "2026-08-27"), http.StatusConflict)
	h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, with(advance, "method", "transferencia"), http.StatusConflict)

	ana := h.createWorker(t, f, "Ana", "73000002")
	beto := h.createWorker(t, f, "Beto", "73000003")
	team := mustString(t, h.mustDo(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"name": "Ana y Beto", "kind": "equipo", "tag": "R-1", "memberIds": []string{ana, beto},
	}, http.StatusCreated).Body, "id")
	toTeam := map[string]any{"id": uuid.NewString(), "workerId": team, "amountCents": 50000,
		"method": "efectivo", "receivedBy": ana}
	h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, toTeam, http.StatusCreated)
	h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, with(toTeam, "receivedBy", beto), http.StatusConflict)
}
