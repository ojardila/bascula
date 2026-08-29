package store

import (
	"context"
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// StockMove is one fact about the warehouse. The table is append-only and the
// database enforces it with a trigger and a REVOKE, exactly as it does for the
// ledger: existencias are derived from these rows, and a derivation is only
// worth anything if the rows underneath it never change after the fact.
//
// Sign travels with the reason and Postgres checks the pair (`stock_sign`), so
// "a sale that increased stock" is not a bug this code can have.
type StockMove struct {
	ID           string     `json:"id"`
	ProductID    string     `json:"productId"`
	Product      string     `json:"product"`
	WarehouseID  string     `json:"warehouseId"`
	Warehouse    string     `json:"warehouse"`
	PlotID       *string    `json:"plotId"`
	Plot         *string    `json:"plot"`
	PlotCropID   *string    `json:"plotCropId"`
	Qty          float64    `json:"qty"`
	Reason       string     `json:"reason"`
	Note         *string    `json:"note"`
	WorkRecordID *string    `json:"workRecordId"`
	SaleID       *string    `json:"saleId"`
	ReversesID   *string    `json:"reversesId"`
	ReversedByID *string    `json:"reversedById"`
	LocalDay     time.Time  `json:"localDay"`
	CreatedBy    *string    `json:"createdBy"`
	CreatedAt    time.Time  `json:"createdAt"`
	LabelBatchID *string    `json:"labelBatchId"`
	PrintedAt    *time.Time `json:"-"`
}

const stockMoveCols = `m.id::text, m.product_id::text, p.name, m.warehouse_id::text, w.name,
	m.plot_id::text, pl.name, m.plot_crop_id::text, m.qty::float8, m.reason::text, m.note,
	m.work_record_id::text, m.sale_id::text, m.reverses_id::text,
	(SELECT r.id::text FROM stock_moves r WHERE r.reverses_id = m.id),
	m.local_day, m.created_by::text, m.created_at,
	(SELECT b.id::text FROM label_batches b WHERE b.stock_move_id = m.id ORDER BY b.created_at LIMIT 1)`

const stockMoveFrom = `FROM stock_moves m
	JOIN products p   ON p.id = m.product_id
	JOIN warehouses w ON w.id = m.warehouse_id
	LEFT JOIN plots pl ON pl.id = m.plot_id`

func scanStockMove(row pgx.Row) (*StockMove, error) {
	var m StockMove
	err := row.Scan(&m.ID, &m.ProductID, &m.Product, &m.WarehouseID, &m.Warehouse,
		&m.PlotID, &m.Plot, &m.PlotCropID, &m.Qty, &m.Reason, &m.Note,
		&m.WorkRecordID, &m.SaleID, &m.ReversesID, &m.ReversedByID,
		&m.LocalDay, &m.CreatedBy, &m.CreatedAt, &m.LabelBatchID)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// StockMoveFilter narrows the movement list. Every field is optional and each
// one that is set has already been confirmed to belong to this farm by the
// handler — see the comment on StockLevels.
type StockMoveFilter struct {
	ProductID   string
	WarehouseID string
	Reason      string
	From        *time.Time
	To          *time.Time
	Limit       int
}

func ListStockMoves(ctx context.Context, tx pgx.Tx, f StockMoveFilter) ([]StockMove, error) {
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := tx.Query(ctx, `
		SELECT `+stockMoveCols+` `+stockMoveFrom+`
		 WHERE ($1::uuid IS NULL OR m.product_id = $1)
		   AND ($2::uuid IS NULL OR m.warehouse_id = $2)
		   AND ($3::text IS NULL OR m.reason::text = $3)
		   AND ($4::date IS NULL OR m.local_day >= $4)
		   AND ($5::date IS NULL OR m.local_day <= $5)
		 ORDER BY m.local_day DESC, m.created_at DESC
		 LIMIT $6`,
		nilIfEmpty(f.ProductID), nilIfEmpty(f.WarehouseID), nilIfEmpty(f.Reason),
		f.From, f.To, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []StockMove{}
	for rows.Next() {
		m, err := scanStockMove(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

func GetStockMove(ctx context.Context, tx pgx.Tx, id string) (*StockMove, error) {
	return scanStockMove(tx.QueryRow(ctx,
		`SELECT `+stockMoveCols+` `+stockMoveFrom+` WHERE m.id = $1`, id))
}

// StockLevel is one line of the existencias screen: how much of a product sits
// in a warehouse, as a SUM and never as a stored total.
type StockLevel struct {
	ProductID   string  `json:"productId"`
	Product     string  `json:"product"`
	StorageUnit string  `json:"storageUnit"`
	WarehouseID string  `json:"warehouseId"`
	Warehouse   string  `json:"warehouse"`
	Qty         float64 `json:"qty"`
}

// StockLevels reads the derived view.
//
// A caller narrowing by product or warehouse MUST have confirmed that the id
// belongs to this farm first, and the handlers here do. The reason is the trap
// this project has already been bitten by twice: a SUM over an id of another
// farm returns 0 rather than an error, because RLS narrows rows instead of
// raising, and "0 sacks in the warehouse" is a completely credible answer to a
// question about somebody else's warehouse. A wrong answer that looks right is
// the expensive kind.
func StockLevels(ctx context.Context, tx pgx.Tx, productID, warehouseID string) ([]StockLevel, error) {
	rows, err := tx.Query(ctx, `
		SELECT l.product_id::text, p.name, su.name, l.warehouse_id::text, w.name, l.qty::float8
		  FROM stock_levels l
		  JOIN products p       ON p.id = l.product_id
		  JOIN storage_units su ON su.id = p.storage_unit_id
		  JOIN warehouses w     ON w.id = l.warehouse_id
		 WHERE ($1::uuid IS NULL OR l.product_id = $1)
		   AND ($2::uuid IS NULL OR l.warehouse_id = $2)
		 ORDER BY p.name, w.name`,
		nilIfEmpty(productID), nilIfEmpty(warehouseID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []StockLevel{}
	for rows.Next() {
		var l StockLevel
		if err := rows.Scan(&l.ProductID, &l.Product, &l.StorageUnit,
			&l.WarehouseID, &l.Warehouse, &l.Qty); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// LockProductForStock serialises every decision taken FROM a product's
// existencias, per product, for the rest of the transaction.
//
// Exactly the same hole as the balance, in exactly the same shape and for
// exactly the same reason: existencias are DERIVED — a SUM over stock_moves,
// with no stored total anywhere, deliberately — so "read what is on hand,
// decide, write the movement" is three steps that two requests interleave.
// Five concurrent sales of a hundred units against a hundred on hand were all
// five accepted, and the warehouse ended at minus four hundred.
//
// The lock is on the product row and therefore covers every warehouse of that
// product at once. That is coarser than the (product, warehouse) pair the guard
// actually reads, and it is the right trade: contention is per product, and one
// lock per product cannot deadlock against itself the way two callers taking
// two different pairs in two different orders can.
//
// It must be taken BEFORE the SUM is read. A lock after the read serialises
// nothing.
func LockProductForStock(ctx context.Context, tx pgx.Tx, productID string) error {
	var one int
	err := tx.QueryRow(ctx,
		`SELECT 1 FROM products WHERE id = $1 FOR UPDATE`, productID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return NoRows
	}
	return err
}

// StockOnHand is the single number for one product in one warehouse. Same
// derivation as the view, asked for the one pair a write is about.
func StockOnHand(ctx context.Context, tx pgx.Tx, productID, warehouseID string) (float64, error) {
	var qty float64
	err := tx.QueryRow(ctx, `
		SELECT coalesce(sum(qty), 0)::float8 FROM stock_moves
		 WHERE product_id = $1 AND warehouse_id = $2`, productID, warehouseID).Scan(&qty)
	return qty, err
}

// NewStockMove is the write shape. LocalDay is a pointer because absent means
// "the farm's today", which the database computes: Go has no business deciding
// which calendar day 19:30 in Bogotá belongs to.
type NewStockMove struct {
	ID           string      `json:"id"`
	ProductID    string      `json:"productId"`
	WarehouseID  string      `json:"warehouseId"`
	PlotID       *string     `json:"plotId"`
	PlotCropID   *string     `json:"plotCropId"`
	Qty          float64     `json:"qty"`
	Reason       string      `json:"reason"`
	Note         *string     `json:"note"`
	WorkRecordID *string     `json:"workRecordId"`
	SaleID       *string     `json:"saleId"`
	ReversesID   *string     `json:"reversesId"`
	LocalDay     *domain.Day `json:"localDay"`
	CreatedBy    string      `json:"-"`
}

// StockReasons is every value of the enum, so the HTTP layer can reject an
// unknown one with a 400 that names the alternatives instead of letting
// Postgres answer 22P02, which the renderer turns into a confusing 404.
var StockReasons = []string{"cosecha", "compra", "venta", "consumo", "merma", "traslado", "ajuste"}

// OutgoingReasons are the ones whose sign is negative. Kept next to the CHECK
// it mirrors rather than in a handler, because the two must agree.
var OutgoingReasons = map[string]bool{"venta": true, "consumo": true, "merma": true}

func IsStockReason(s string) bool {
	for _, r := range StockReasons {
		if r == s {
			return true
		}
	}
	return false
}

// InsertStockMove appends one movement. It never updates anything, because
// there is nothing to update: the level is the sum of these rows.
func InsertStockMove(ctx context.Context, tx pgx.Tx, farmID string, n NewStockMove) (*StockMove, error) {
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO stock_moves (id, farm_id, product_id, warehouse_id, plot_id, plot_crop_id,
		                         qty, reason, note, work_record_id, sale_id, reverses_id,
		                         local_day, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::stock_reason, $9, $10, $11, $12, $13, $14)
		RETURNING id::text`,
		n.ID, farmID, n.ProductID, n.WarehouseID, n.PlotID, n.PlotCropID,
		n.Qty, n.Reason, n.Note, n.WorkRecordID, n.SaleID, n.ReversesID,
		n.LocalDay.Ptr(), nilIfEmpty(n.CreatedBy)).Scan(&id)
	if err != nil {
		return nil, translateStockError(err)
	}
	return GetStockMove(ctx, tx, id)
}

// translateStockError turns the database's own refusals into the contract's
// codes. The constraints are the specification; this only gives them a name
// the client can branch on.
func translateStockError(err error) error {
	switch {
	case IsCheckViolation(err, "stock_sign"):
		return domain.BadRequest(
			"the sign of the quantity does not match the reason: cosecha and compra come in, venta, consumo and merma go out")
	case IsCheckViolation(err, "stock_venta_has_sale"):
		return domain.BadRequest("a 'venta' movement belongs to a sale; record the sale instead")
	case IsCheckViolation(err, "stock_crop_needs_plot"):
		return domain.BadRequest("plotCropId needs the plotId it is planted in")
	case IsUniqueViolation(err, "ux_moves_reverses"):
		return domain.Conflict(domain.CodeAlreadyReversed, "that movement has already been reversed")
	}
	return err
}

// ReverseStockMove is the only way back through an append-only table: a second
// movement that is the exact opposite of the first, once. The database checks
// the "exact" and a partial unique index checks the "once".
func ReverseStockMove(ctx context.Context, tx pgx.Tx, farmID, id string, note *string, newID func() string) (*StockMove, error) {
	origin, err := GetStockMove(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if origin.ReversesID != nil {
		return nil, domain.Conflict(domain.CodeAlreadyReversed, "a reversal cannot be reversed")
	}
	if origin.ReversedByID != nil {
		return nil, domain.Conflict(domain.CodeAlreadyReversed, "that movement has already been reversed")
	}
	// 'ajuste' is the reason a correction carries: it is the only one whose
	// sign is free, which is what lets the opposite of an outgoing movement be
	// positive without lying about why it exists. reversesId is what says what
	// it really is.
	return InsertStockMove(ctx, tx, farmID, NewStockMove{
		ID:          newID(),
		ProductID:   origin.ProductID,
		WarehouseID: origin.WarehouseID,
		PlotID:      origin.PlotID,
		PlotCropID:  origin.PlotCropID,
		Qty:         -origin.Qty,
		Reason:      "ajuste",
		Note:        note,
		ReversesID:  &origin.ID,
	})
}

// ---------------------------------------------------------------------------
// Sticker batches (RSP-025)
// ---------------------------------------------------------------------------

// LabelBatch is what "el sistema imprime los stickers" becomes on a server
// with no printer: the batch is generated, it has an id, and whatever holds
// the paper asks for it. Printing from inside a request would make the sale of
// a truckload of coffee fail because a printer was out of paper.
type LabelBatch struct {
	ID          string     `json:"id"`
	StockMoveID string     `json:"stockMoveId"`
	Count       int        `json:"count"`
	PrintedAt   *time.Time `json:"printedAt"`
	CreatedAt   time.Time  `json:"createdAt"`
	Labels      []Label    `json:"labels"`
}

// Label is one sticker's worth of data. It is derived from the movement every
// time it is read rather than frozen into rows, because a sticker is a
// rendering of a fact and not a fact of its own.
type Label struct {
	Code        string  `json:"code"`
	Product     string  `json:"product"`
	StorageUnit string  `json:"storageUnit"`
	Qty         float64 `json:"qty"`
	Warehouse   string  `json:"warehouse"`
	Plot        *string `json:"plot"`
	LocalDay    string  `json:"localDay"`
}

func CreateLabelBatch(ctx context.Context, tx pgx.Tx, farmID, moveID string, count int, createdBy string, newID func() string) (*LabelBatch, error) {
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO label_batches (id, farm_id, stock_move_id, label_count, created_by)
		VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
		newID(), farmID, moveID, count, nilIfEmpty(createdBy)).Scan(&id)
	if err != nil {
		return nil, err
	}
	return GetLabelBatch(ctx, tx, id)
}

func GetLabelBatch(ctx context.Context, tx pgx.Tx, id string) (*LabelBatch, error) {
	var b LabelBatch
	var moveID string
	err := tx.QueryRow(ctx, `
		SELECT id::text, stock_move_id::text, label_count, printed_at, created_at
		  FROM label_batches WHERE id = $1`, id).
		Scan(&b.ID, &moveID, &b.Count, &b.PrintedAt, &b.CreatedAt)
	if err != nil {
		return nil, err
	}
	b.StockMoveID = moveID

	move, err := GetStockMove(ctx, tx, moveID)
	if err != nil {
		return nil, err
	}
	var unit string
	if err := tx.QueryRow(ctx, `
		SELECT su.name FROM products p JOIN storage_units su ON su.id = p.storage_unit_id
		 WHERE p.id = $1`, move.ProductID).Scan(&unit); err != nil {
		return nil, err
	}

	// The quantity is split evenly across the stickers, because that is what a
	// sticker per sack means. The remainder goes on the last one rather than
	// being rounded away: eleven arrobas over four labels is 2.75 each and the
	// total on the paper still says eleven.
	//
	// Each label is rounded FIRST and the last one gets whatever is left of the
	// total. Taking the remainder from the unrounded share and rounding that too
	// breaks the promise in the paragraph above: forty over three printed
	// 13.333 three times, and the paper said 39.999.
	b.Labels = make([]Label, 0, b.Count)
	each := round3(move.Qty / float64(b.Count))
	for i := 0; i < b.Count; i++ {
		qty := each
		if i == b.Count-1 {
			qty = round3(move.Qty - each*float64(b.Count-1))
		}
		b.Labels = append(b.Labels, Label{
			Code:        b.ID[:8] + "-" + strconv.Itoa(i+1),
			Product:     move.Product,
			StorageUnit: unit,
			Qty:         qty,
			Warehouse:   move.Warehouse,
			Plot:        move.Plot,
			LocalDay:    move.LocalDay.Format("2006-01-02"),
		})
	}
	return &b, nil
}

// round3 matches numeric(14,3), the precision the column stores. A label that
// said 2.7499999999 would be arithmetically closer and visibly wrong.
func round3(f float64) float64 { return math.Round(f*1000) / 1000 }
