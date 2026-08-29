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

	// LAST_OWNER refuses the change that would leave a farm with nobody who
	// can administer it. A farm with no owner cannot be repaired from inside
	// the product: nobody left may write the farm record, set a price or
	// promote anybody, and the fix is somebody with a psql prompt. It is a
	// code of its own rather than a plain 409 because the screen has to say
	// something specific — name another owner first — and branching on a
	// message is not branching.
	CodeLastOwner Code = "LAST_OWNER"

	// GROSS_CHANGED is the answer to §5.5 of docs/sincronizacion.md: the
	// settlement would not add up to the figure the caller was shown by
	// /v1/settlements/preview, so nothing is written.
	//
	// It is not a nicety. Between reading a screen and pressing a button, the
	// owner can reprice the week from the web and a late weighing can arrive,
	// and the person pressing the button is about to count that number out in
	// cash. `details` carries what moved it — added and removed payables, and
	// the weeks whose price no longer matches — so the screen can say "entraron
	// dos pesadas más" instead of showing a mute error.
	CodeGrossChanged Code = "GROSS_CHANGED"

	// EMPLOYEE_EXISTS_DELETED closes §5.6's real danger. ux_employees_doc is
	// partial on deleted_at IS NULL, so after Juan is taken off the payroll the
	// web can create a SECOND Juan with the same cédula — and then one person's
	// balance is split across two files with nothing warning anybody. Merging
	// them afterwards is manual surgery on the ledger.
	CodeEmployeeExistsDeleted Code = "EMPLOYEE_EXISTS_DELETED"

	// The two sync preconditions of §8 phase 0.
	//
	// CURSOR_TOO_OLD: the phone's cursor is older than the oldest change still
	// retained, so the feed can no longer tell it what it missed. It re-pulls
	// from cursor 0, which is a full bootstrap.
	//
	// SCHEMA_TOO_OLD: the handset is on a local schema that predates the UUID
	// columns. It must update before it pushes a single byte.
	CodeCursorTooOld Code = "CURSOR_TOO_OLD"
	CodeSchemaTooOld Code = "SCHEMA_TOO_OLD"

	// IMPORT_MISMATCH aborts a season import whose reconciliation did not come
	// out to the cent (§8 phase 3). Half an imported payroll is worse than no
	// imported payroll: the numbers look plausible and nobody goes looking.
	CodeImportMismatch Code = "IMPORT_MISMATCH"

	// IDEMPOTENCY_KEY_REUSED is the other half of the promise openapi.yaml
	// makes at the top of the file: "every write accepts a client-generated id
	// and is idempotent by (farm_id, id)".
	//
	// Idempotent means resending the SAME write is safe. It does not mean the
	// id is a slot to be overwritten. If the same id arrives carrying a
	// different worker or a different amount, that is a client bug, and
	// answering 200 with the first row would tell the foreman his second
	// payment went through when nothing was written at all. So it is a 409
	// with a name of its own — never a silent success, and never a second row.
	CodeIdempotencyKeyReused Code = "IDEMPOTENCY_KEY_REUSED"

	// Products, inventory, sales and expenses.
	CodeInsufficientStock    Code = "INSUFFICIENT_STOCK"
	CodeSaleAlreadyVoid      Code = "SALE_ALREADY_VOID"
	CodeExpenseTargetInvalid Code = "EXPENSE_TARGET_INVALID"

	// Uploads.
	CodeUploadTooLarge       Code = "UPLOAD_TOO_LARGE"
	CodeUploadNotReady       Code = "UPLOAD_NOT_READY"
	CodeUnsupportedMediaType Code = "UNSUPPORTED_MEDIA_TYPE"
)

// AllCodes is every code this service can put on the wire, in the order they
// are declared above.
//
// It exists so openapi.yaml cannot quietly fall behind: a test asserts that
// this list and the spec's ErrorCode enum are the same set, which makes adding
// a code without documenting it a build failure rather than a surprise the
// client discovers in production. The client branches on these; an
// undocumented one is a branch nobody wrote.
func AllCodes() []Code {
	return []Code{
		CodeBadRequest, CodeUnauthorized, CodeForbidden, CodeNotFound,
		CodeConflict, CodeInternal, CodeTenantNotSet,

		CodeInvalidCredentials, CodeEmailNotVerified, CodeEmailTaken,
		CodeTokenExpired, CodeTokenReused, CodeRateLimited,
		CodeFarmLimitReached, CodeFarmSuspended,

		CodeWorkRecordSettled, CodePayableAlreadyClaimed, CodeSettlementAlreadyVoid,
		CodeAlreadyReversed, CodeNothingToSettle, CodeAmountExceedsBalance,
		CodeInvalidGeometry, CodePlotHasActiveCrops, CodeNoRateInForce,
		CodeRangeNeedsFrozenRate, CodeDuplicateDocument, CodeDuplicateName,
		CodeLastOwner,
		CodeGrossChanged, CodeEmployeeExistsDeleted,
		CodeCursorTooOld, CodeSchemaTooOld, CodeImportMismatch,
		CodeIdempotencyKeyReused,

		CodeInsufficientStock, CodeSaleAlreadyVoid, CodeExpenseTargetInvalid,
		CodeUploadTooLarge, CodeUploadNotReady, CodeUnsupportedMediaType,
	}
}

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
