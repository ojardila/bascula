// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// TestMovementIDsAreNeverReusedForSomethingElse: a client-chosen id names one
// movement, forever. Another farm's id, or one already naming a different
// movement, is refused without saying anything about what it names.
func TestMovementIDsAreNeverReusedForSomethingElse(t *testing.T) {
	h := requireDB(t)
	a := h.signupFarm(t, "Finca ids propios", 80000)
	b := h.signupFarm(t, "Finca ids ajenos", 80000)
	workerA := h.createWorker(t, a, "Ana", "5101")
	workerB := h.createWorker(t, b, "Beto", "5102")

	deduction := h.mustDo(t, http.MethodPost, "/v1/deductions", a.OwnerToken, map[string]any{
		"id": uuid.NewString(), "workerId": workerA, "amountCents": 50_000,
	}, http.StatusCreated)
	deductionID := mustString(t, deduction.Body, "id")
	advance := h.mustDo(t, http.MethodPost, "/v1/advances", a.OwnerToken, map[string]any{
		"id": uuid.NewString(), "workerId": workerA, "amountCents": 70_000,
	}, http.StatusCreated)
	advanceID := mustString(t, advance.Body, "id")

	t.Run("another farm's movement id, for an advance", func(t *testing.T) {
		wantIDReused(t, "advance", h.do(t, http.MethodPost, "/v1/advances", b.OwnerToken, map[string]any{
			"id": deductionID, "workerId": workerB, "amountCents": 70_000,
		}))
	})

	t.Run("another farm's movement id, for a reversal", func(t *testing.T) {
		own := h.mustDo(t, http.MethodPost, "/v1/deductions", b.OwnerToken, map[string]any{
			"id": uuid.NewString(), "workerId": workerB, "amountCents": 10_000,
		}, http.StatusCreated)
		wantIDReused(t, "reversal", h.do(t, http.MethodPost, "/v1/ledger/"+mustString(t, own.Body, "id")+"/reverse",
			b.OwnerToken, map[string]any{"id": deductionID}))
	})

	t.Run("a reversal id that already names an advance", func(t *testing.T) {
		wantIDReused(t, "reversal", h.do(t, http.MethodPost, "/v1/ledger/"+deductionID+"/reverse",
			a.OwnerToken, map[string]any{"id": advanceID}))
	})

	t.Run("a reversal cannot itself be reversed", func(t *testing.T) {
		revID := uuid.NewString()
		h.mustDo(t, http.MethodPost, "/v1/ledger/"+deductionID+"/reverse", a.OwnerToken,
			map[string]any{"id": revID}, http.StatusCreated)
		res := h.do(t, http.MethodPost, "/v1/ledger/"+revID+"/reverse", a.OwnerToken,
			map[string]any{"id": uuid.NewString()})
		if res.code() != string(domain.CodeAlreadyReversed) {
			t.Fatalf("got %d %s, want ALREADY_REVERSED", res.Status, res.Raw)
		}
	})

	t.Run("the store holds the line when the handler's check is bypassed", func(t *testing.T) {
		storeRefusesAReusedLedgerID(t, h, a, workerA, advanceID)
	})

	t.Run("listings fall back to their default page size", func(t *testing.T) {
		storeListsWithDefaultPageSize(t, h, a, workerA)
	})
}

func wantIDReused(t *testing.T, what string, res response) {
	t.Helper()
	if res.Status != http.StatusConflict || res.code() != string(domain.CodeIdempotencyKeyReused) {
		t.Fatalf("%s: got %d %s, want 409 IDEMPOTENCY_KEY_REUSED", what, res.Status, res.Raw)
	}
}

// storeRefusesAReusedLedgerID is the race the handler cannot see: two
// identical requests both past its pre-check. The insert itself must sort
// them out.
func storeRefusesAReusedLedgerID(t *testing.T, h *harness, a *farmFixture, workerA, advanceID string) {
	h.withTenant(t, a.FarmID, a.OwnerUserID, domain.RoleOwner, func(ctx context.Context, tx pgx.Tx) {
		same := store.NewLedgerEntry{ID: advanceID, EmployeeID: workerA, Kind: domain.KindAdvance,
			AmountMinor: -70_000, CreatedBy: a.OwnerUserID}
		got, created, err := store.AddLedgerEntry(ctx, tx, a.FarmID, same)
		if err != nil || created || got == nil || got.ID != advanceID {
			t.Fatalf("the identical twin: got %v created=%v err=%v, want the existing row", got, created, err)
		}
		other := same
		other.AmountMinor = -80_000
		_, _, err = store.AddLedgerEntry(ctx, tx, a.FarmID, other)
		var de *domain.Error
		if !errors.As(err, &de) || de.Code != domain.CodeIdempotencyKeyReused {
			t.Fatalf("a different movement under the same id: got %v, want IDEMPOTENCY_KEY_REUSED", err)
		}
	})
}

func storeListsWithDefaultPageSize(t *testing.T, h *harness, a *farmFixture, workerA string) {
	h.withTenant(t, a.FarmID, a.OwnerUserID, domain.RoleOwner, func(ctx context.Context, tx pgx.Tx) {
		rows, err := store.ListLedger(ctx, tx, workerA, 0)
		if err != nil || len(rows) < 3 {
			t.Fatalf("ListLedger(limit 0): %d rows, %v", len(rows), err)
		}
		if _, _, err := store.ListSettlements(ctx, tx, store.SettlementFilter{}); err != nil {
			t.Fatalf("ListSettlements(no limit): %v", err)
		}
	})
}
