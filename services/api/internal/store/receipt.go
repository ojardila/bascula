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
	switch pago.Kind {
	case domain.KindPayment, domain.KindAdvance, domain.KindDeduction:
	default:
		return nil, pgx.ErrNoRows
	}

	rows, err := tx.Query(ctx, `
		SELECT `+ledgerCols+`
		  FROM ledger WHERE employee_id = $1
		 ORDER BY created_at ASC, id ASC`, pago.EmployeeID)
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

	// Two readings of "reversed", and the receipt needs both.
	//
	//   reversed        — cancelled at any time, up to today. Only used to say
	//                     so on the slip.
	//   reversedBefore  — cancelled BEFORE this movement was written. That is
	//                     the ledger as it stood the day of the receipt, and it
	//                     is the only reading the figures may use: a settlement
	//                     voided a month after the payment must not change what
	//                     the payment's receipt says the week was.
	pagoAt := -1
	for i, e := range all {
		if e.ID == pago.ID {
			pagoAt = i
			break
		}
	}
	if pagoAt < 0 {
		return nil, pgx.ErrNoRows
	}
	reversed := map[string]bool{}
	reversedBefore := map[string]bool{}
	for i, e := range all {
		if e.ReversesID != nil {
			reversed[*e.ReversesID] = true
			if i < pagoAt {
				reversedBefore[*e.ReversesID] = true
			}
		}
	}
	live := func(e LedgerEntry) bool {
		return e.ReversesID == nil && !reversedBefore[e.ID]
	}

	var remaining int64
	var prevPagoAt time.Time
	var prevPagoID string
	var found bool
	var pagoIndex int
	for i, e := range all {
		if live(e) {
			remaining += e.AmountMinor
		}
		if e.ID == pago.ID {
			found = true
			pagoIndex = i
			break
		}
		if live(e) && e.Kind == domain.KindPayment {
			prevPagoAt = e.CreatedAt
			prevPagoID = e.ID
		}
	}
	if !found {
		return nil, pgx.ErrNoRows
	}

	var week int64
	deductions := []ReceiptDeduction{}
	settlementIDs := []string{}
	var disc int64
	var settlementID *string
	var weekFrom, weekTo *time.Time
	for i := 0; i < pagoIndex; i++ {
		if pago.Kind != domain.KindPayment {
			// An advance or a deduction is its own amount and nothing else.
			break
		}
		e := all[i]
		if !live(e) {
			continue
		}
		if prevPagoID != "" && (e.CreatedAt.Before(prevPagoAt) || (e.CreatedAt.Equal(prevPagoAt) && e.ID <= prevPagoID)) {
			continue
		}
		switch e.Kind {
		case domain.KindEarning:
			week += e.AmountMinor
			if e.SettlementID != nil {
				settlementID = e.SettlementID
				settlementIDs = append(settlementIDs, *e.SettlementID)
			}
		case domain.KindDeduction:
			amt := -e.AmountMinor
			if amt < 0 {
				amt = -amt
			}
			concept := "Descuento"
			if e.Note != nil && *e.Note != "" {
				concept = *e.Note
			}
			deductions = append(deductions, ReceiptDeduction{
				Concept: concept, AmountCents: amt, Date: e.LocalDay,
			})
			disc += amt
		}
	}

	for _, id := range settlementIDs {
		st, err := GetSettlement(ctx, tx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
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

	paid := -pago.AmountMinor
	if paid < 0 {
		paid = -paid
	}
	return &PaymentReceipt{
		Entry:                *pago,
		PreviousBalanceCents: remaining - week + disc + paid,
		CurrentWeekCents:     week,
		CurrentWeekFrom:      weekFrom,
		CurrentWeekTo:        weekTo,
		Deductions:           deductions,
		DeductionsCents:      disc,
		PaidCents:            paid,
		RemainingCents:       remaining,
		SettlementID:         settlementID,
		SettlementIDs:        settlementIDs,
		Reversed:             reversed[pago.ID],
	}, nil
}
