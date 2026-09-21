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
}

// PaymentReceiptOf rebuilds the slip for one payment. The identity is:
//
//	saldo anterior + semana actual − descuentos − pago = queda
func PaymentReceiptOf(ctx context.Context, tx pgx.Tx, paymentID string) (*PaymentReceipt, error) {
	pago, err := FindLedgerEntry(ctx, tx, paymentID)
	if err != nil {
		return nil, err
	}
	if pago == nil || pago.Kind != domain.KindPayment {
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

	reversed := map[string]bool{}
	for _, e := range all {
		if e.ReversesID != nil {
			reversed[*e.ReversesID] = true
		}
	}
	live := func(e LedgerEntry) bool {
		return e.ReversesID == nil && !reversed[e.ID]
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
	var deductions []ReceiptDeduction
	var disc int64
	var settlementID *string
	var weekFrom, weekTo *time.Time
	for i := 0; i < pagoIndex; i++ {
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

	if settlementID != nil {
		s, err := GetSettlement(ctx, tx, *settlementID)
		if err == nil {
			weekFrom, weekTo = &s.PeriodStart, &s.PeriodEnd
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
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
	}, nil
}
