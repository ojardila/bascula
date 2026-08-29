package domain

import (
	"math/big"
	"strconv"
	"strings"
)

// Fixed-scale numbers, and the rule that a column's shape is part of the
// contract rather than a detail of storage.
//
// `quantity` is declared numeric(12, 3). Postgres does not refuse a fourth
// decimal place — it ROUNDS it, silently, on the way in. So a handset that
// weighed 1,0005 kg at $75 computed 7504 and this server stored 1,001 and
// charged 7508. Nobody is told: not the response, not the foreman, not the
// picker. The two databases then hold different weights and different money
// for the same act, permanently, and there is no later moment at which the
// disagreement announces itself.
//
// A rounding the caller did not ask for is not a convenience. It is the server
// agreeing to a number and storing a different one, which is the same failure
// as the silent zero and costs the same thing — a person's pay, off by an
// amount nobody can trace. So the scale is CHECKED, and a value that does not
// fit is a 400 that names the field and says what the limit is. The client can
// then round deliberately, in front of the person whose kilos they are.
//
// The precision half of the same declaration is checked here too, for a plainer
// reason: 1e30 into numeric(12, 3) is a database error, and a database error is
// a 500. A number too large for the column is a bad request and has been one
// since before it was sent.
//
// The constants below are the column declarations. When one moves, this moves
// with it — they are named after what they store so the pairing survives.
const (
	// work_records.quantity and settlement_items.quantity: numeric(12, 3).
	QuantityPrecision, QuantityScale = 12, 3
	// plots.area_ha, plot_crops.area_ha, farms.area_ha: numeric(10, 3).
	AreaPrecision, AreaScale = 10, 3
	// stock_moves.qty and sale_lines.qty: numeric(14, 3).
	StockQtyPrecision, StockQtyScale = 14, 3
	// activity_rates.custom_qty: numeric(8, 2).
	CustomQtyPrecision, CustomQtyScale = 8, 2
	// work_units.kg_factor: numeric(10, 4).
	KgFactorPrecision, KgFactorScale = 10, 4
)

// CheckNumeric refuses a decimal the column cannot hold exactly.
//
// It works on the TEXT the caller sent, through big.Rat, so 1e-7 and 0.0000001
// are the same refusal and neither becomes a float on the way. Exponent
// notation is accepted as input and reported back in plain decimal, because
// "1e-7 has more than 3 decimal places" is a sentence somebody has to decode.
func CheckNumeric(field, value string, precision, scale int) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return BadRequest(field + " is required")
	}
	r, ok := new(big.Rat).SetString(value)
	if !ok {
		return BadRequest(field + " must be a decimal number")
	}
	return checkRat(field, r, precision, scale)
}

// CheckNumericFloat is CheckNumeric for the fields that arrive as a JSON
// number decoded into float64.
//
// The value is rendered with strconv.FormatFloat(-1), the shortest decimal that
// round-trips — which for anything a person typed is the decimal they typed.
// This is weaker than the text path and it is why `quantity`, the field that
// decides money, does not use it.
func CheckNumericFloat(field string, value float64, precision, scale int) error {
	text := strconv.FormatFloat(value, 'f', -1, 64)
	r, ok := new(big.Rat).SetString(text)
	if !ok {
		return BadRequest(field + " must be a decimal number")
	}
	return checkRat(field, r, precision, scale)
}

func checkRat(field string, r *big.Rat, precision, scale int) error {
	pow := func(n int) *big.Int {
		return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
	}

	// Scale: the value times 10^scale has to land on an integer, or there is a
	// decimal place the column would round away.
	shifted := new(big.Rat).Mul(r, new(big.Rat).SetInt(pow(scale)))
	if !shifted.IsInt() {
		return BadRequest(field + " has more than " + strconv.Itoa(scale) +
			" decimal places (" + r.FloatString(scale+4) + "); round it before sending it, " +
			"because this server will not round it for you")
	}

	// Precision: numeric(p, s) holds p-s digits before the point.
	limit := new(big.Rat).SetInt(pow(precision - scale))
	abs := new(big.Rat).Abs(r)
	if abs.Cmp(limit) >= 0 {
		return BadRequest(field + " is too large: at most " +
			strconv.Itoa(precision-scale) + " digits before the decimal point")
	}
	return nil
}
