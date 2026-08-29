package domain

import (
	"math/big"
	"time"
)

// Role is a farm role. Four roles, hardcoded: owner, admin, weigher, plus the
// super-admin, who is a flag on the user and not a farm role at all.
type Role string

const (
	RoleOwner   Role = "owner"
	RoleAdmin   Role = "admin"
	RoleWeigher Role = "weigher"
)

func (r Role) Valid() bool {
	switch r {
	case RoleOwner, RoleAdmin, RoleWeigher:
		return true
	}
	return false
}

// PayScheme is how an activity pays. Spanish values because they are the
// values stored in the Postgres enum, which the design documents fixed.
type PayScheme string

const (
	PaySchemeContract PayScheme = "contrato"
	PaySchemeTime     PayScheme = "tiempo"
	PaySchemeWorkUnit PayScheme = "unidad_trabajo"
)

func (p PayScheme) Valid() bool {
	switch p {
	case PaySchemeContract, PaySchemeTime, PaySchemeWorkUnit:
		return true
	}
	return false
}

// RateSource says when the price freezes. See the comment on the Postgres type
// of the same name in migration 00001.
type RateSource string

const (
	RateExplicit      RateSource = "explicit"
	RateActivityDated RateSource = "activity_dated"
	RateWeeklyPrice   RateSource = "weekly_price"
)

// Derived reports whether the price comes from a date lookup rather than from
// the caller. Decision 4: a work record with a date-derived price must be a single
// day, because a range has no single validity period.
func (r RateSource) Derived() bool {
	return r == RateActivityDated || r == RateWeeklyPrice
}

// LedgerKind mirrors the Postgres enum. The ledger did not need generalising:
// these six describe a coffee pickup, a day's wage and a pruning contract
// equally well.
type LedgerKind string

const (
	KindEarning   LedgerKind = "devengo"
	KindPayment   LedgerKind = "pago"
	KindAdvance   LedgerKind = "anticipo"
	KindDeduction LedgerKind = "deduccion"
	KindAdjust    LedgerKind = "ajuste"
	KindReversal  LedgerKind = "reverso"
)

// PayMethod mirrors the Postgres enum.
type PayMethod string

const (
	MethodCash     PayMethod = "efectivo"
	MethodTransfer PayMethod = "transferencia"
	MethodOther    PayMethod = "otro"
)

func (m PayMethod) Valid() bool {
	switch m {
	case MethodCash, MethodTransfer, MethodOther:
		return true
	}
	return false
}

// MondayOf returns the Monday of the ISO week a local day falls in. It is the
// Go twin of week_start(date) in Postgres and of WEEK_OF() in
// apps/mobile/src/schema.ts. The week is the Monday's ISO date, never a
// "2026-W33" string.
func MondayOf(d time.Time) time.Time {
	d = time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC)
	// Go's Sunday is 0; ISO's Monday is 1.
	offset := (int(d.Weekday()) + 6) % 7
	return d.AddDate(0, 0, -offset)
}

// AmountMinor is the one money rule, and it is the same in all three pay
// schemes: amount = round(quantity * rate). It is the Go twin of
// Math.round(weight * costPerUnitCents) on the phone and of the
// `amount_minor = round(quantity * price_minor)::bigint` CHECK in Postgres.
//
// quantity arrives as a decimal with at most three places (the numeric(12,3)
// of the work_records table), so it is taken as a big.Rat rather than a float: a
// float64 multiplication is exactly where two languages start disagreeing in
// the third decimal and nobody notices until payday.
func AmountMinor(quantity *big.Rat, rateMinor int64) int64 {
	if quantity == nil {
		return 0
	}
	product := new(big.Rat).Mul(quantity, new(big.Rat).SetInt64(rateMinor))
	return roundHalfAwayFromZero(product)
}

// roundHalfAwayFromZero matches Postgres round(numeric) and, for the positive
// amounts this system deals in, Math.round on the phone.
func roundHalfAwayFromZero(r *big.Rat) int64 {
	neg := r.Sign() < 0
	abs := new(big.Rat).Abs(r)

	num, den := abs.Num(), abs.Denom()
	quo, rem := new(big.Int).QuoRem(num, den, new(big.Int))

	// rem/den >= 1/2  <=>  2*rem >= den
	twice := new(big.Int).Lsh(rem, 1)
	if twice.Cmp(den) >= 0 {
		quo.Add(quo, big.NewInt(1))
	}
	if neg {
		quo.Neg(quo)
	}
	return quo.Int64()
}

// Balance is one worker's position, straight from the ledger. Positive means
// the farm owes them, so a positive balance is their credit.
type Balance struct {
	EmployeeID     string     `json:"workerId"`
	EarnedMinor    int64      `json:"earnedCents"`
	PaidMinor      int64      `json:"paidCents"`
	DeductedMinor  int64      `json:"deductedCents"`
	BalanceMinor   int64      `json:"balanceCents"`
	LastMovementOn *time.Time `json:"lastMovementOn"`
	// Active is false for somebody who has been taken off the payroll. They
	// stay on the balances list all the same, because their debt does: a
	// deactivation that made money disappear from the only screen anybody
	// looks at would be a way to hide it. The caller renders the difference.
	Active bool `json:"active"`
}
