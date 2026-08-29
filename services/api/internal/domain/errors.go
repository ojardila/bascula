// Package domain holds the vocabulary the whole service agrees on: the error
// codes that are part of the REST contract, the money rules, and the pure
// helpers the ported SQL leans on.
package domain

import (
	"errors"
	"fmt"
	"net/http"
)

// Code is the machine-readable half of an error response. The client branches
// on the code; the translation lives in the client. Adding one here is a
// contract change.
type Code string

const (
	// Transport and shape.
	CodeBadRequest   Code = "BAD_REQUEST"
	CodeUnauthorized Code = "UNAUTHORIZED"
	CodeForbidden    Code = "FORBIDDEN"
	CodeNotFound     Code = "NOT_FOUND"
	CodeConflict     Code = "CONFLICT"
	CodeInternal     Code = "INTERNAL"

	// The tenant context was never established. RLS answers a query with zero
	// rows and no error when app.farm_id is unset, and that silence is
	// dangerous: an empty worker list reads exactly like a new farm. So a
	// missing tenant is a loud 500, never an empty 200.
	CodeTenantNotSet Code = "TENANT_NOT_SET"

	// Auth.
	CodeInvalidCredentials Code = "INVALID_CREDENTIALS"
	CodeEmailNotVerified   Code = "EMAIL_NOT_VERIFIED"
	CodeEmailTaken         Code = "EMAIL_TAKEN"
	CodeTokenExpired       Code = "TOKEN_EXPIRED"
	CodeTokenReused        Code = "TOKEN_REUSED"
	CodeRateLimited        Code = "RATE_LIMITED"
	CodeFarmLimitReached   Code = "FARM_LIMIT_REACHED"
	CodeFarmSuspended      Code = "FARM_SUSPENDED"

	// Business conflicts. These are 409 with a code of their own and they are
	// part of the contract, not an implementation detail.
	CodeWorkRecordSettled     Code = "WORK_RECORD_SETTLED"
	CodePayableAlreadyClaimed Code = "PAYABLE_ALREADY_CLAIMED"
	CodeSettlementAlreadyVoid Code = "SETTLEMENT_ALREADY_VOID"
	CodeAlreadyReversed       Code = "ALREADY_REVERSED"
	CodeNothingToSettle       Code = "NOTHING_TO_SETTLE"
	CodeAmountExceedsBalance  Code = "AMOUNT_EXCEEDS_BALANCE"
	CodeInvalidGeometry       Code = "INVALID_GEOMETRY"
	CodePlotHasActiveCrops    Code = "PLOT_HAS_ACTIVE_CROPS"
	CodeNoRateInForce         Code = "NO_RATE_IN_FORCE"
	CodeRangeNeedsFrozenRate  Code = "RANGE_NEEDS_FROZEN_RATE"
	CodeDuplicateDocument     Code = "DUPLICATE_DOCUMENT"
	CodeDuplicateName         Code = "DUPLICATE_NAME"
)

// Error is an error that already knows what it looks like on the wire.
type Error struct {
	Status  int
	Code    Code
	Message string
	Details map[string]any
	cause   error
}

func (e *Error) Error() string {
	if e.cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.cause }

// WithDetails attaches the structured payload the client needs to recover. The
// canonical case is PAYABLE_ALREADY_CLAIMED, where the phone re-derives its
// state from details.winningSettlement.
func (e *Error) WithDetails(d map[string]any) *Error {
	e.Details = d
	return e
}

// WithCause keeps the underlying error for the logs without leaking it to the
// client.
func (e *Error) WithCause(err error) *Error {
	e.cause = err
	return e
}

func newErr(status int, code Code, msg string) *Error {
	return &Error{Status: status, Code: code, Message: msg}
}

func BadRequest(msg string) *Error   { return newErr(http.StatusBadRequest, CodeBadRequest, msg) }
func Unauthorized(msg string) *Error { return newErr(http.StatusUnauthorized, CodeUnauthorized, msg) }
func Forbidden(msg string) *Error    { return newErr(http.StatusForbidden, CodeForbidden, msg) }
func NotFound(msg string) *Error     { return newErr(http.StatusNotFound, CodeNotFound, msg) }
func Internal(msg string) *Error {
	return newErr(http.StatusInternalServerError, CodeInternal, msg)
}

// Conflict builds a 409 with a business code. Every value passed here must be
// one of the documented conflict codes.
func Conflict(code Code, msg string) *Error {
	return newErr(http.StatusConflict, code, msg)
}

// Coded builds an error with an explicit status and code, for the auth codes
// that are not plain 400/403.
func Coded(status int, code Code, msg string) *Error {
	return newErr(status, code, msg)
}

// TenantNotSet is the loud failure described on CodeTenantNotSet.
func TenantNotSet() *Error {
	return newErr(http.StatusInternalServerError, CodeTenantNotSet,
		"tenant context was not established for this request")
}

// AsError digs an *Error out of a wrapped chain, so handlers can return
// whatever they like and the renderer still finds the contract error.
func AsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}
