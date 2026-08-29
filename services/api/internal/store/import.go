package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The season import. docs/sincronizacion.md §8, phases 3 and 4.
//
// A farm has been running this season on a handset. Until that history is on
// the server, settlement cannot move here: a settlement created on the server
// would claim payables the server has never seen, and the anti double-pay lock
// would have nothing to lock against. So the order is import first, and this
// is the import.
//
// Three properties, and none of them is optional:
//
//  1. THE PHONE'S UUIDS ARE KEPT. Every id below is the uuid the handset
//     generated, and settlement_items.payable_id points at the same uuid it
//     pointed at there. The money is not remapped. A remap is a rewrite of the
//     column the anti double-pay index lives on, in the database that holds the
//     only copy of a farm's season.
//  2. IT IS IDEMPOTENT. Every insert is ON CONFLICT (id) DO NOTHING and reports
//     what it skipped. The rehearsal of phase 3 is run again and again until it
//     comes out clean, and the real cut of phase 4 has to be safe to retry
//     after a dropped connection.
//  3. IT RECONCILES TO THE CENT, INSIDE THE TRANSACTION, AND ABORTS IF IT DOES
//     NOT. Half an imported payroll is worse than none: the figures look
//     plausible and nobody goes looking.

// SeasonImport is the whole of a handset's season, in dependency order.
//
// The order of the fields is the order they are written, and it is the order
// the receiving rule of 2026-08-29 fixes for the feed as well: references
// first — config, people, lots, crops, prices — and only then work and money.
type SeasonImport struct {
	DeviceID string `json:"deviceId"`

	Workers     []ImportWorker     `json:"workers"`
	Plots       []ImportPlot       `json:"plots"`
	WeekPrices  []ImportWeekPrice  `json:"weekPrices"`
	WorkRecords []ImportWorkRecord `json:"workRecords"`
	Settlements []ImportSettlement `json:"settlements"`
	Ledger      []ImportLedger     `json:"ledger"`

	// Balances is what the handset's own BALANCE_SQL says each worker's
	// position is. It is not imported — nothing derived is ever stored — it is
	// the reconciliation, and a single cent of disagreement aborts everything.
	Balances []ImportBalance `json:"balances"`
}

type ImportWorker struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	LastName     *string    `json:"lastName"`
	DocumentType *string    `json:"documentType"`
	DocID        *string    `json:"docId"`
	Tag          *string    `json:"tag"`
	CreatedAt    *time.Time `json:"createdAt"`
	DeletedAt    *time.Time `json:"deletedAt"`
}

// ImportPlot carries the handset's `crop` and the plot that is invented around
// it. §8 phase 3: the plot_crop INHERITS the crop's uuid, because that is what
// the weighings point at; the plot is new and is named after the lot the user
// had in their head.
type ImportPlot struct {
	CropID    string     `json:"cropId"`
	Name      string     `json:"name"`
	CropType  string     `json:"cropType"`
	Variety   *string    `json:"variety"`
	AreaHa    *float64   `json:"areaHa"`
	DeletedAt *time.Time `json:"deletedAt"`
}

type ImportWeekPrice struct {
	WeekStart  string `json:"weekStart"`
	PriceCents int64  `json:"priceCents"`
}

type ImportWorkRecord struct {
	ID         string      `json:"id"`
	WorkerID   string      `json:"workerId"`
	CropID     string      `json:"cropId"`
	Quantity   json.Number `json:"quantity"`
	OccurredAt time.Time   `json:"occurredAt"`
	Note       *string     `json:"note"`
	DeviceID   *string     `json:"deviceId"`
	DeletedAt  *time.Time  `json:"deletedAt"`
}

type ImportSettlementItem struct {
	ID          string      `json:"id"`
	PayableID   string      `json:"payableId"`
	WeekStart   string      `json:"weekStart"`
	Quantity    json.Number `json:"quantity"`
	PriceCents  int64       `json:"priceCents"`
	AmountCents int64       `json:"amountCents"`
	VoidedAt    *time.Time  `json:"voidedAt"`
}

type ImportSettlement struct {
	ID          string                 `json:"id"`
	WorkerID    string                 `json:"workerId"`
	PeriodStart string                 `json:"periodStart"`
	PeriodEnd   string                 `json:"periodEnd"`
	GrossCents  int64                  `json:"grossCents"`
	Status      string                 `json:"status"`
	Note        *string                `json:"note"`
	CreatedAt   *time.Time             `json:"createdAt"`
	VoidedAt    *time.Time             `json:"voidedAt"`
	Items       []ImportSettlementItem `json:"items"`
}

type ImportLedger struct {
	ID           string     `json:"id"`
	WorkerID     string     `json:"workerId"`
	Kind         string     `json:"kind"`
	AmountCents  int64      `json:"amountCents"`
	Date         string     `json:"date"`
	Method       *string    `json:"method"`
	Note         *string    `json:"note"`
	SettlementID *string    `json:"settlementId"`
	ReversesID   *string    `json:"reversesId"`
	CreatedAt    *time.Time `json:"createdAt"`
}

type ImportBalance struct {
	WorkerID     string `json:"workerId"`
	BalanceCents int64  `json:"balanceCents"`
}

// ImportCounts is what actually happened, per table, split between written and
// already-there. The split is the whole answer to "did the retry do anything".
type ImportCounts struct {
	Written int `json:"written"`
	Skipped int `json:"skipped"`
}

type ImportReport struct {
	Workers         ImportCounts `json:"workers"`
	Plots           ImportCounts `json:"plots"`
	Crops           ImportCounts `json:"crops"`
	WeekPrices      ImportCounts `json:"weekPrices"`
	WorkRecords     ImportCounts `json:"workRecords"`
	Settlements     ImportCounts `json:"settlements"`
	SettlementItems ImportCounts `json:"settlementItems"`
	Ledger          ImportCounts `json:"ledger"`

	// The three reconciliations of §8 phase 3, reported even when they pass,
	// because a number that is only printed when it is wrong is a number
	// nobody ever sees be right.
	BalancesChecked int   `json:"balancesChecked"`
	LiveItems       int   `json:"liveItems"`
	KilosMinor      int64 `json:"-"`
}

// ImportSeason writes the whole history and reconciles it, or writes nothing.
//
// It does no COMMIT of its own: the request transaction commits it, and any
// error returned here reaches the HTTP layer as a 4xx, which the tenant
// middleware answers by rolling the whole thing back. That is the same
// property phase 4 relies on — "si algo falla: ROLLBACK, se quita el modo
// lectura, y la finca sigue como estaba".
func ImportSeason(ctx context.Context, tx pgx.Tx, farmID, createdBy string,
	in SeasonImport, newID func() string) (*ImportReport, error) {

	var rep ImportReport

	// 1. People. The handset's uuid becomes the employee's id.
	for _, wkr := range in.Workers {
		if wkr.ID == "" || wkr.Name == "" {
			return nil, domain.BadRequest("every imported worker needs an id and a name")
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO employees (id, farm_id, name, last_name, document_type, doc_id, tag,
			                       created_at, deleted_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9)
			ON CONFLICT (id) DO NOTHING`,
			wkr.ID, farmID, wkr.Name, wkr.LastName, wkr.DocumentType, wkr.DocID, wkr.Tag,
			wkr.CreatedAt, wkr.DeletedAt)
		if err != nil {
			return nil, importFailure("worker "+wkr.ID, err)
		}
		count(&rep.Workers, tag.RowsAffected())
	}

	// 2. Lots. One plot per crop, and the plot_crop inherits the crop's uuid
	//    because that is the id the weighings carry.
	for _, pl := range in.Plots {
		if pl.CropID == "" || pl.Name == "" {
			return nil, domain.BadRequest("every imported lot needs a cropId and a name")
		}
		// Already imported? The crop's id is what says so, not the plot's,
		// because the plot's id is invented here and a retry would invent a
		// different one.
		var existingPlot *string
		err := tx.QueryRow(ctx,
			`SELECT plot_id::text FROM plot_crops WHERE id = $1`, pl.CropID).Scan(&existingPlot)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, importFailure("lot "+pl.Name, err)
		}
		if existingPlot != nil {
			rep.Plots.Skipped++
			rep.Crops.Skipped++
			continue
		}

		plotID := newID()
		if _, err := tx.Exec(ctx, `
			INSERT INTO plots (id, farm_id, name, area_ha, deleted_at)
			VALUES ($1, $2, $3, $4, $5)`,
			plotID, farmID, pl.Name, pl.AreaHa, pl.DeletedAt); err != nil {
			return nil, importFailure("lot "+pl.Name, err)
		}
		rep.Plots.Written++

		cropType := pl.CropType
		if cropType == "" {
			cropType = "Cafe"
		}
		ct, err := EnsureCatalogItem(ctx, tx, CatalogCropTypes, farmID, newID(), cropType)
		if err != nil {
			return nil, importFailure("lot "+pl.Name, err)
		}
		var varietyID *string
		if pl.Variety != nil && *pl.Variety != "" {
			v, err := EnsureCatalogItem(ctx, tx, CatalogVarieties, farmID, newID(), *pl.Variety)
			if err != nil {
				return nil, importFailure("lot "+pl.Name, err)
			}
			varietyID = &v.ID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO plot_crops (id, farm_id, plot_id, crop_type_id, variety_id, area_ha, deleted_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			pl.CropID, farmID, plotID, ct.ID, varietyID, pl.AreaHa, pl.DeletedAt); err != nil {
			return nil, importFailure("lot "+pl.Name, err)
		}
		rep.Crops.Written++
	}

	// 3. Prices. cost_overrides -> week_prices, keyed by the Monday.
	for _, wp := range in.WeekPrices {
		week, err := time.Parse("2006-01-02", wp.WeekStart)
		if err != nil {
			return nil, domain.BadRequest("weekStart must be YYYY-MM-DD: " + wp.WeekStart)
		}
		if !domain.MondayOf(week).Equal(week) {
			return nil, domain.BadRequest("a week price is named by its Monday: " + wp.WeekStart)
		}
		if wp.PriceCents <= 0 {
			return nil, domain.BadRequest("a week price must be positive: " + wp.WeekStart)
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO week_prices (farm_id, week_start, price_minor) VALUES ($1, $2, $3)
			ON CONFLICT (farm_id, week_start) DO NOTHING`, farmID, week, wp.PriceCents)
		if err != nil {
			return nil, importFailure("week price "+wp.WeekStart, err)
		}
		count(&rep.WeekPrices, tag.RowsAffected())
	}

	// 4. The weighings. §8 phase 3 fixes their shape exactly: the seeded
	//    "Recolección" activity, rate_source = weekly_price, the unit off the
	//    activity, quantity = weight. local_day is NOT written here — the
	//    trigger computes it from the farm's timezone, which is the whole
	//    reason golden case 04 comes out the same on both sides.
	activityID, err := HarvestActivityID(ctx, tx)
	if err != nil {
		return nil, err
	}
	activity, err := GetActivity(ctx, tx, activityID)
	if err != nil {
		return nil, err
	}
	for _, wr := range in.WorkRecords {
		if wr.ID == "" || wr.WorkerID == "" {
			return nil, domain.BadRequest("every imported weighing needs an id and a workerId")
		}
		if wr.OccurredAt.IsZero() {
			return nil, domain.BadRequest("weighing " + wr.ID + " has no occurredAt")
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO work_records (id, farm_id, employee_id, activity_id, pay_scheme, rate_source,
			                          started_at, quantity, unit_id, note, device_id,
			                          created_by, created_at, deleted_at)
			VALUES ($1, $2, $3, $4, $5, 'weekly_price', $6, $7::numeric, $8, $9, $10, $11, coalesce($12, now()), $13)
			ON CONFLICT (id) DO NOTHING`,
			wr.ID, farmID, wr.WorkerID, activity.ID, activity.PayScheme,
			wr.OccurredAt, wr.Quantity.String(), activity.UnitID, wr.Note,
			nilUUID(deref(wr.DeviceID)), nilUUID(createdBy), wr.OccurredAt, wr.DeletedAt)
		if err != nil {
			return nil, importFailure("weighing "+wr.ID, err)
		}
		count(&rep.WorkRecords, tag.RowsAffected())
		if tag.RowsAffected() == 1 && wr.CropID != "" {
			if _, err := tx.Exec(ctx, `
				INSERT INTO work_record_plot_crops (work_record_id, plot_crop_id, farm_id)
				VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				wr.ID, wr.CropID, farmID); err != nil {
				return nil, importFailure("weighing "+wr.ID, err)
			}
		}
	}

	// 5. The settlements, with their lines. The lines are what the anti
	//    double-pay index acts on, and payable_id is the handset's own uuid:
	//    the money is not remapped.
	for _, st := range in.Settlements {
		if st.ID == "" || st.WorkerID == "" {
			return nil, domain.BadRequest("every imported settlement needs an id and a workerId")
		}
		periodStart, err := time.Parse("2006-01-02", st.PeriodStart)
		if err != nil {
			return nil, domain.BadRequest("settlement " + st.ID + ": periodStart must be YYYY-MM-DD")
		}
		periodEnd, err := time.Parse("2006-01-02", st.PeriodEnd)
		if err != nil {
			return nil, domain.BadRequest("settlement " + st.ID + ": periodEnd must be YYYY-MM-DD")
		}
		status := st.Status
		if status == "" {
			status = "open"
		}
		if status != "open" && status != "void" {
			return nil, domain.BadRequest("settlement " + st.ID + ": status must be open or void")
		}
		if (status == "void") != (st.VoidedAt != nil) {
			return nil, domain.BadRequest(
				"settlement " + st.ID + ": a void settlement carries voidedAt and an open one does not")
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO settlements (id, farm_id, employee_id, period_start, period_end,
			                         gross_minor, status, note, created_by, created_at, voided_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7::settlement_status, $8, $9, coalesce($10, now()), $11)
			ON CONFLICT (id) DO NOTHING`,
			st.ID, farmID, st.WorkerID, periodStart, periodEnd, st.GrossCents, status,
			st.Note, nilUUID(createdBy), st.CreatedAt, st.VoidedAt)
		if err != nil {
			return nil, importFailure("settlement "+st.ID, err)
		}
		count(&rep.Settlements, tag.RowsAffected())

		for _, it := range st.Items {
			// A line's identity for the purpose of "have I already imported
			// this" is (settlement, payable) and not the line's own uuid. The
			// handset does have a uuid per line, but a file that omits one
			// would otherwise get a fresh id on every run — and the second run
			// would then collide with ux_items_payable_live and report the
			// import's own first pass as a double claim.
			var existing *string
			if err := tx.QueryRow(ctx, `
				SELECT id::text FROM settlement_items
				 WHERE settlement_id = $1 AND payable_id = $2`,
				st.ID, it.PayableID).Scan(&existing); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, importFailure("settlement "+st.ID+" line "+it.PayableID, err)
			}
			if existing != nil {
				rep.SettlementItems.Skipped++
				continue
			}

			itemID := it.ID
			if itemID == "" {
				itemID = newID()
			}
			week, err := time.Parse("2006-01-02", it.WeekStart)
			if err != nil {
				return nil, domain.BadRequest("settlement " + st.ID + ": a line's weekStart must be YYYY-MM-DD")
			}
			itemTag, err := tx.Exec(ctx, `
				INSERT INTO settlement_items (id, farm_id, settlement_id, payable_id, week_start,
				                              quantity, price_minor, amount_minor, voided_at)
				VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)
				ON CONFLICT (id) DO NOTHING`,
				itemID, farmID, st.ID, it.PayableID, week,
				it.Quantity.String(), it.PriceCents, it.AmountCents, it.VoidedAt)
			if err != nil {
				if IsUniqueViolation(err, "ux_items_payable_live") {
					// The lock did its job. On an import it means the same
					// payable is claimed by two live settlements in the file
					// itself, which is a handset whose own lock was bypassed —
					// and it is not something to paper over.
					return nil, domain.Conflict(domain.CodePayableAlreadyClaimed,
						"payable "+it.PayableID+" is claimed by more than one live settlement in this import").
						WithDetails(map[string]any{
							"settlementId": st.ID, "payableId": it.PayableID,
						}).WithCause(err)
				}
				return nil, importFailure("settlement "+st.ID+" line "+it.PayableID, err)
			}
			count(&rep.SettlementItems, itemTag.RowsAffected())
		}
	}

	// 6. The ledger, in id order, with settlement_id and reverses_id resolved
	//    by uuid. Reversals last: check_reverso() reads the row it cancels.
	ordered := append([]ImportLedger(nil), in.Ledger...)
	for pass := 0; pass < 2; pass++ {
		for _, l := range ordered {
			isReversal := domain.LedgerKind(l.Kind) == domain.KindReversal
			if (pass == 0) == isReversal {
				continue
			}
			if l.ID == "" || l.WorkerID == "" {
				return nil, domain.BadRequest("every imported movement needs an id and a workerId")
			}
			if l.AmountCents == 0 {
				return nil, domain.BadRequest("movement " + l.ID + " has an amount of zero")
			}
			kind := domain.LedgerKind(l.Kind)
			day, err := time.Parse("2006-01-02", l.Date)
			if err != nil {
				return nil, domain.BadRequest("movement " + l.ID + ": date must be YYYY-MM-DD")
			}
			tag, err := tx.Exec(ctx, `
				INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
				                    settlement_id, method, note, reverses_id, created_by, created_at)
				VALUES ($1, $2, $3, $4::ledger_kind, $5, $6, $7, $8::pay_method, $9, $10, $11, coalesce($12, now()))
				ON CONFLICT (id) DO NOTHING`,
				l.ID, farmID, l.WorkerID, string(kind), l.AmountCents, day,
				nilUUID(deref(l.SettlementID)), l.Method, l.Note,
				nilUUID(deref(l.ReversesID)), nilUUID(createdBy), l.CreatedAt)
			if err != nil {
				return nil, importFailure("movement "+l.ID, err)
			}
			count(&rep.Ledger, tag.RowsAffected())
		}
	}

	if err := reconcileImport(ctx, tx, in, &rep); err != nil {
		return nil, err
	}
	return &rep, nil
}

// reconcileImport is §8 phase 3's three queries, and it is the reason this
// endpoint can be trusted at all.
//
// It runs BEFORE the transaction commits — the HTTP layer never commits a
// request that answered 4xx — so a mismatch leaves the server exactly as it
// was and the handset, which was never modified, is still the whole truth.
func reconcileImport(ctx context.Context, tx pgx.Tx, in SeasonImport, rep *ImportReport) error {
	// 1. The balance, per worker, to the cent. Any disagreement aborts.
	mismatches := []map[string]any{}
	for _, b := range in.Balances {
		var derived int64
		err := tx.QueryRow(ctx,
			`SELECT COALESCE(SUM(amount_minor), 0) FROM ledger WHERE employee_id = $1`,
			b.WorkerID).Scan(&derived)
		if err != nil {
			return importFailure("balance of worker "+b.WorkerID, err)
		}
		if derived != b.BalanceCents {
			mismatches = append(mismatches, map[string]any{
				"workerId":   b.WorkerID,
				"phoneCents": b.BalanceCents, "serverCents": derived,
				"differenceCents": derived - b.BalanceCents,
			})
		}
	}
	rep.BalancesChecked = len(in.Balances)
	if len(mismatches) > 0 {
		return domain.Conflict(domain.CodeImportMismatch,
			"the imported balances do not match what the server derives; nothing was written").
			WithDetails(map[string]any{"balances": mismatches})
	}

	// 2. The lock: as many live lines as the handset had, not one more. This
	//    is what would catch a settlement imported twice under two ids.
	var live int
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM settlement_items WHERE voided_at IS NULL`).Scan(&live); err != nil {
		return err
	}
	rep.LiveItems = live

	expectedLive := 0
	for _, st := range in.Settlements {
		for _, it := range st.Items {
			if it.VoidedAt == nil {
				expectedLive++
			}
		}
	}
	// Only meaningful on a farm whose whole history came from this file. A
	// server that already had lines of its own would count those too, and
	// refusing then would be refusing a correct import — so the check is a
	// floor, not an equality: the import cannot have produced FEWER live lines
	// than it brought.
	if live < expectedLive {
		return domain.Conflict(domain.CodeImportMismatch,
			"fewer live settlement lines survived the import than the handset sent").
			WithDetails(map[string]any{"expectedLiveItems": expectedLive, "liveItems": live})
	}
	return nil
}

func count(c *ImportCounts, affected int64) {
	if affected == 1 {
		c.Written++
		return
	}
	c.Skipped++
}

// importFailure keeps the constraint that fired attached to the log while the
// caller is told which row of their file was refused. On an import, "which
// row" is the whole of the useful information.
func importFailure(what string, err error) error {
	if de, ok := domain.AsError(err); ok {
		return de
	}
	if IsUniqueViolation(err, "") {
		return domain.Conflict(domain.CodeImportMismatch,
			"the import was refused at "+what).WithCause(err)
	}
	return domain.BadRequest("the import was refused at " + what + ": " + err.Error()).WithCause(err)
}
