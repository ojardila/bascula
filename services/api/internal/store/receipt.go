// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ReceiptDeduction is one withholding named on a pay slip.
type ReceiptDeduction struct {
	Concept     string
	AmountCents int64
	Date        time.Time
}

// PaymentReceipt is the four figures a farm receipt names, derived from the
// ledger around one `pago`. ChatGPT and the paper both read this.
type PaymentReceipt struct {
	Entry                LedgerEntry
	PreviousBalanceCents int64
	CurrentWeekCents     int64
	CurrentWeekFrom      *time.Time
	CurrentWeekTo        *time.Time
	Deductions           []ReceiptDeduction
	DeductionsCents      int64
	PaidCents            int64
	RemainingCents       int64
	SettlementID         *string
	// SettlementIDs is every live settlement whose devengo makes up
	// CurrentWeekCents, oldest first. Their frozen lines ARE the week on the
	// receipt: summed, they give CurrentWeekCents exactly, because each
	// devengo is its settlement's gross.
	SettlementIDs []string
	// Reversed is true when the movement was later cancelled by a reverso.
	// The receipt is still rebuilt as it stood the day it was written.
	Reversed bool
}

// PaymentReceiptOf rebuilds the slip for one payment. The identity is:
//
//	saldo anterior + semana actual − descuentos − pago = queda
//
// It also rebuilds the slip of an `anticipo` or a `deduccion`, which is the
// same identity with no week and no discounts of its own: the movement IS the
// amount, and saldo anterior − monto = queda. The worker's history opens all
// three, and each has to come out exactly as it stood that day — which is why
// everything here is read from the ledger in the order it was written and
// nothing is recomputed from today's prices.
func PaymentReceiptOf(ctx context.Context, tx pgx.Tx, paymentID string) (*PaymentReceipt, error) {
	pago, err := FindLedgerEntry(ctx, tx, paymentID)
	if err != nil {
		return nil, err
	}
	if pago == nil {
		return nil, pgx.ErrNoRows
	}
	if !hasReceipt(pago.Kind) {
		return nil, pgx.ErrNoRows
	}

	all, err := employeeLedgerInOrder(ctx, tx, pago.EmployeeID)
	if err != nil {
		return nil, err
	}

	// Two readings of "reversed", and the receipt needs both.
	//
	//   reversed        — cancelled at any time, up to today. Only used to say
	//                     so on the slip.
	//   reversedBefore  — cancelled BEFORE this movement was written. That is
	//                     the ledger as it stood the day of the receipt, and it
	//                     is the only reading the figures may use: a settlement
	//                     voided a month after the payment must not change what
	//                     the payment's receipt says the week was.
	pagoAt := ledgerIndexOf(all, pago.ID)
	if pagoAt < 0 {
		return nil, pgx.ErrNoRows
	}
	reversed, reversedBefore := receiptReversals(all, pagoAt)
	live := func(e LedgerEntry) bool {
		return e.ReversesID == nil && !reversedBefore[e.ID]
	}

	// all[pagoAt] is the first entry with pago's id, so the running balance
	// stops there, and the previous payment is the last live one before it.
	remaining, prevPagoAt, prevPagoID := receiptBalance(all[:pagoAt+1], live)

	w := receiptWeek{deductions: []ReceiptDeduction{}, settlementIDs: []string{}}
	// An advance or a deduction is its own amount and nothing else.
	if pago.Kind == domain.KindPayment {
		w.addSince(all[:pagoAt], live, prevPagoAt, prevPagoID)
	}

	weekFrom, weekTo, err := settlementsSpan(ctx, tx, w.settlementIDs)
	if err != nil {
		return nil, err
	}

	paid := absMinor(pago.AmountMinor)
	return &PaymentReceipt{
		Entry:                *pago,
		PreviousBalanceCents: remaining - w.week + w.disc + paid,
		CurrentWeekCents:     w.week,
		CurrentWeekFrom:      weekFrom,
		CurrentWeekTo:        weekTo,
		Deductions:           w.deductions,
		DeductionsCents:      w.disc,
		PaidCents:            paid,
		RemainingCents:       remaining,
		SettlementID:         w.settlementID,
		SettlementIDs:        w.settlementIDs,
		Reversed:             reversed[pago.ID],
	}, nil
}

// employeeLedgerInOrder reads every ledger entry of one worker in the order
// it was written.
func employeeLedgerInOrder(ctx context.Context, tx pgx.Tx, employeeID string) ([]LedgerEntry, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+ledgerCols+`
		  FROM ledger WHERE employee_id = $1
		 ORDER BY created_at ASC, id ASC`, employeeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var all []LedgerEntry
	for rows.Next() {
		e, err := scanLedgerEntry(rows)
		if err != nil {
			return nil, err
		}
		all = append(all, *e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return all, nil
}

// receiptReversals returns the ids cancelled at any time (reversed) and those
// cancelled by an entry written before index pagoAt (reversedBefore).
func receiptReversals(all []LedgerEntry, pagoAt int) (reversed, reversedBefore map[string]bool) {
	reversed = map[string]bool{}
	reversedBefore = map[string]bool{}
	for i, e := range all {
		if e.ReversesID == nil {
			continue
		}
		reversed[*e.ReversesID] = true
		if i < pagoAt {
			reversedBefore[*e.ReversesID] = true
		}
	}
	return reversed, reversedBefore
}

// receiptBalance sums the live entries of upTo (which ends at the receipt's
// own movement) and finds the last live payment before that movement.
func receiptBalance(upTo []LedgerEntry, live func(LedgerEntry) bool) (remaining int64, prevPagoAt time.Time, prevPagoID string) {
	last := len(upTo) - 1
	for i, e := range upTo {
		if live(e) {
			remaining += e.AmountMinor
		}
		if i == last {
			break
		}
		if live(e) && e.Kind == domain.KindPayment {
			prevPagoAt = e.CreatedAt
			prevPagoID = e.ID
		}
	}
	return remaining, prevPagoAt, prevPagoID
}

// hasReceipt reports whether a movement of this kind has a slip of its own:
// a payment, an advance or a deduction.
func hasReceipt(kind domain.LedgerKind) bool {
	switch kind {
	case domain.KindPayment, domain.KindAdvance, domain.KindDeduction:
		return true
	default:
		return false
	}
}

// ledgerIndexOf is the position of the first entry with this id, or -1.
func ledgerIndexOf(all []LedgerEntry, id string) int {
	for i, e := range all {
		if e.ID == id {
			return i
		}
	}
	return -1
}

// receiptWeek accumulates what a payment's slip names between the previous
// payment and this one.
type receiptWeek struct {
	week          int64
	disc          int64
	deductions    []ReceiptDeduction
	settlementID  *string
	settlementIDs []string
}

// addSince adds every live entry written after the previous payment (all of
// them when there is none). Entries are compared by (created_at, id), the
// order the ledger was written in.
func (w *receiptWeek) addSince(entries []LedgerEntry, live func(LedgerEntry) bool, prevPagoAt time.Time, prevPagoID string) {
	for _, e := range entries {
		if !live(e) {
			continue
		}
		if prevPagoID != "" && (e.CreatedAt.Before(prevPagoAt) || (e.CreatedAt.Equal(prevPagoAt) && e.ID <= prevPagoID)) {
			continue
		}
		w.add(e)
	}
}

func (w *receiptWeek) add(e LedgerEntry) {
	switch e.Kind {
	case domain.KindEarning:
		w.week += e.AmountMinor
		if e.SettlementID != nil {
			w.settlementID = e.SettlementID
			w.settlementIDs = append(w.settlementIDs, *e.SettlementID)
		}
	case domain.KindDeduction:
		amt := absMinor(e.AmountMinor)
		concept := "Descuento"
		if e.Note != nil && *e.Note != "" {
			concept = *e.Note
		}
		w.deductions = append(w.deductions, ReceiptDeduction{
			Concept: concept, AmountCents: amt, Date: e.LocalDay,
		})
		w.disc += amt
	}
}

// settlementsSpan is the earliest start and latest end across the given
// settlements. One that no longer exists is skipped.
func settlementsSpan(ctx context.Context, tx pgx.Tx, ids []string) (weekFrom, weekTo *time.Time, err error) {
	for _, id := range ids {
		st, err := GetSettlement(ctx, tx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		if weekFrom == nil || st.PeriodStart.Before(*weekFrom) {
			from := st.PeriodStart
			weekFrom = &from
		}
		if weekTo == nil || st.PeriodEnd.After(*weekTo) {
			to := st.PeriodEnd
			weekTo = &to
		}
	}
	return weekFrom, weekTo, nil
}

// absMinor is |amount|: payments and deductions are stored negative.
func absMinor(amount int64) int64 {
	if amount < 0 {
		return -amount
	}
	return amount
}
