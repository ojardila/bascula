package store

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Sale is RSP-027: product, quantity, customer, value, photo of the receipt.
//
// The value is AmountMinor — an int64 in the currency's minor unit — and not
// the `double` the use case asks for. That is not pedantry: a float peso is a
// peso that rounds differently on two machines, and this schema has held the
// line everywhere else money appears.
type Sale struct {
	ID           string     `json:"id"`
	ProductID    string     `json:"productId"`
	Product      string     `json:"product"`
	StorageUnit  string     `json:"storageUnit"`
	CustomerID   *string    `json:"customerId"`
	Customer     *string    `json:"customer"`
	WarehouseID  string     `json:"warehouseId"`
	Warehouse    string     `json:"warehouse"`
	Qty          float64    `json:"qty"`
	AmountMinor  int64      `json:"amountCents"`
	ReceiptID    *string    `json:"receiptId"`
	Note         *string    `json:"note"`
	LocalDay     time.Time  `json:"localDay"`
	CreatedBy    *string    `json:"createdBy"`
	CreatedAt    time.Time  `json:"createdAt"`
	VoidedAt     *time.Time `json:"voidedAt"`
	StockMoveID  *string    `json:"stockMoveId"`
	ReversalMove *string    `json:"reversalMoveId"`
}

const saleCols = `s.id::text, s.product_id::text, p.name, su.name,
	s.customer_id::text, c.name, s.warehouse_id::text, w.name,
	s.qty::float8, s.amount_minor, s.receipt_id::text, s.note, s.local_day,
	s.created_by::text, s.created_at, s.voided_at,
	(SELECT m.id::text FROM stock_moves m WHERE m.sale_id = s.id AND m.reason = 'venta'),
	(SELECT r.id::text FROM stock_moves r
	   JOIN stock_moves o ON o.id = r.reverses_id
	  WHERE o.sale_id = s.id)`

const saleFrom = `FROM sales s
	JOIN products p       ON p.id = s.product_id
	JOIN storage_units su ON su.id = p.storage_unit_id
	JOIN warehouses w     ON w.id = s.warehouse_id
	LEFT JOIN customers c ON c.id = s.customer_id`

func scanSale(row pgx.Row) (*Sale, error) {
	var s Sale
	err := row.Scan(&s.ID, &s.ProductID, &s.Product, &s.StorageUnit,
		&s.CustomerID, &s.Customer, &s.WarehouseID, &s.Warehouse,
		&s.Qty, &s.AmountMinor, &s.ReceiptID, &s.Note, &s.LocalDay,
		&s.CreatedBy, &s.CreatedAt, &s.VoidedAt, &s.StockMoveID, &s.ReversalMove)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// SaleFilter narrows the list. Status reuses the vocabulary of every other
// list in this service — "active" hides the voided ones — even though the
// column is voided_at rather than deleted_at, because on the screen it is the
// same switch.
type SaleFilter struct {
	Filter
	ProductID  string
	CustomerID string
	From       *time.Time
	To         *time.Time
}

func ListSales(ctx context.Context, tx pgx.Tx, f SaleFilter) ([]Sale, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+saleCols+` `+saleFrom+`
		 WHERE ($1 OR s.voided_at IS NULL)
		   AND (NOT $2 OR s.voided_at IS NOT NULL)
		   AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%'
		        OR coalesce(c.name, '') ILIKE '%' || $3 || '%')
		   AND ($4::uuid IS NULL OR s.product_id = $4)
		   AND ($5::uuid IS NULL OR s.customer_id = $5)
		   AND ($6::date IS NULL OR s.local_day >= $6)
		   AND ($7::date IS NULL OR s.local_day <= $7)
		 ORDER BY s.local_day DESC, s.created_at DESC`,
		f.includeDeleted(), f.onlyDeleted(), nilIfEmpty(f.Q),
		nilIfEmpty(f.ProductID), nilIfEmpty(f.CustomerID), f.From, f.To)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Sale{}
	for rows.Next() {
		s, err := scanSale(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

func GetSale(ctx context.Context, tx pgx.Tx, id string) (*Sale, error) {
	return scanSale(tx.QueryRow(ctx, `SELECT `+saleCols+` `+saleFrom+` WHERE s.id = $1`, id))
}

// NewSale is the write shape.
type NewSale struct {
	ID          string      `json:"id"`
	ProductID   string      `json:"productId"`
	CustomerID  *string     `json:"customerId"`
	Customer    string      `json:"customer"`
	WarehouseID string      `json:"warehouseId"`
	Qty         float64     `json:"qty"`
	AmountMinor int64       `json:"amountCents"`
	ReceiptID   *string     `json:"receiptId"`
	Note        *string     `json:"note"`
	LocalDay    *domain.Day `json:"localDay"`
	// AllowNegativeStock is the caller saying "yes, I know, record it anyway",
	// the same escape hatch `allowOverpayment` gives a payment larger than the
	// balance. Both are needed for the same reason: the guard exists because
	// the web is a keyboard, and the override exists because the warehouse is
	// not always in the database before the truck leaves.
	AllowNegativeStock bool   `json:"allowNegativeStock"`
	CreatedBy          string `json:"-"`
}

// CreateSale writes the sale AND its outgoing movement, in one transaction.
//
// This is the whole reason the function exists instead of two handlers. Split
// them and the first time somebody voids something, or the second call fails,
// the sales list and the warehouse disagree — and there is no third record to
// say which one is right. The database is in on it too: stock_venta_has_sale
// makes a 'venta' movement without a sale impossible, so the pair cannot be
// written half way even by a different code path.
func CreateSale(ctx context.Context, tx pgx.Tx, farmID string, n NewSale, newID func() string) (*Sale, error) {
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO sales (id, farm_id, product_id, customer_id, warehouse_id, qty,
		                   amount_minor, receipt_id, note, local_day, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id::text`,
		n.ID, farmID, n.ProductID, n.CustomerID, n.WarehouseID, n.Qty,
		n.AmountMinor, n.ReceiptID, n.Note, n.LocalDay.Ptr(), nilIfEmpty(n.CreatedBy)).Scan(&id)
	if err != nil {
		return nil, translateSaleError(err)
	}

	if _, err := InsertStockMove(ctx, tx, farmID, NewStockMove{
		ID:          newID(),
		ProductID:   n.ProductID,
		WarehouseID: n.WarehouseID,
		Qty:         -n.Qty, // out. stock_sign refuses any other answer for 'venta'.
		Reason:      "venta",
		SaleID:      &id,
		LocalDay:    n.LocalDay,
		CreatedBy:   n.CreatedBy,
	}); err != nil {
		return nil, err
	}
	return GetSale(ctx, tx, id)
}

func translateSaleError(err error) error {
	if IsCheckViolation(err, "attachments_ready_shape") {
		return domain.Conflict(domain.CodeUploadNotReady, "that attachment has no bytes yet")
	}
	// restrict_violation, raised by check_attachment_ready in 00011.
	if pe, ok := PgErr(err); ok && pe.Code == "23001" &&
		strings.Contains(pe.Message, "has no bytes yet") {
		return domain.Conflict(domain.CodeUploadNotReady,
			"the receipt has not finished uploading")
	}
	return err
}

// SalePatch is RSP-028, minus the one field that cannot move. The quantity is
// half of a stock movement that is already written and append-only; changing
// it here would leave the warehouse claiming one number and the sales list
// another. The handler answers 400 and says to void and record again.
type SalePatch struct {
	CustomerID  *string     `json:"customerId"`
	AmountMinor *int64      `json:"amountCents"`
	ReceiptID   *string     `json:"receiptId"`
	Note        *string     `json:"note"`
	LocalDay    *domain.Day `json:"localDay"`
}

func UpdateSale(ctx context.Context, tx pgx.Tx, id string, p SalePatch) (*Sale, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE sales SET
			customer_id  = coalesce($2, customer_id),
			amount_minor = coalesce($3, amount_minor),
			receipt_id   = coalesce($4, receipt_id),
			note         = coalesce($5, note),
			local_day    = coalesce($6, local_day)
		 WHERE id = $1 AND voided_at IS NULL`,
		id, p.CustomerID, p.AmountMinor, p.ReceiptID, p.Note, p.LocalDay.Ptr())
	if err != nil {
		return nil, translateSaleError(err)
	}
	if tag.RowsAffected() == 0 {
		return nil, NoRows
	}
	return GetSale(ctx, tx, id)
}

// VoidSale is RSP-029's "eliminar deja la venta inactiva", done honestly: the
// row is flagged AND the stock that went out comes back, as a reversing
// movement. Flagging alone would leave the coffee sold in the sales list and
// gone from the warehouse forever.
func VoidSale(ctx context.Context, tx pgx.Tx, farmID, id string, newID func() string) (*Sale, error) {
	sale, err := GetSale(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if sale.VoidedAt != nil {
		return nil, domain.Conflict(domain.CodeSaleAlreadyVoid, "that sale is already void")
	}
	if sale.StockMoveID == nil {
		return nil, domain.Internal("the sale has no stock movement to reverse")
	}
	if _, err := ReverseStockMove(ctx, tx, farmID, *sale.StockMoveID,
		ptr("void of sale "+id), newID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE sales SET voided_at = now() WHERE id = $1 AND voided_at IS NULL`, id); err != nil {
		return nil, err
	}
	return GetSale(ctx, tx, id)
}

func ptr(s string) *string { return &s }
