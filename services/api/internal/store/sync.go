package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The change feed, from the server's side. docs/sincronizacion.md §3.
//
// The phone carries ONE number, `cursor`, and what it is missing is
// "everything with a seq greater than that number". Not a watermark per table:
// a watermark needs updated_at everywhere, cannot tell a deletion from a row
// that never existed, and breaks on clocks. A sequence is an integer that only
// goes up and that one server hands out.
//
// The feed row carries identity only. Every body below is composed HERE, at
// pull time, from the real table — so a row corrected five times is sent once,
// in its current state, and the feed can never become a second copy of the
// money that drifts from the first.

// SyncEntity is a wire name, not a table name: the phone knows `worker`,
// `crop` and `workRecord`.
type SyncEntity string

const (
	EntityFarmConfig  SyncEntity = "farmConfig"
	EntityWorker      SyncEntity = "worker"
	EntityPlot        SyncEntity = "plot"
	EntityCrop        SyncEntity = "crop"
	EntityWeekPrice   SyncEntity = "weekPrice"
	EntityWorkRecord  SyncEntity = "workRecord"
	EntitySettlement  SyncEntity = "settlement"
	EntityLedgerEntry SyncEntity = "ledgerEntry"
)

// moneyEntities are the ones a weigher's pull never carries a body for. His
// own RLS policies already close settlements and the ledger, so this is the
// message rather than the guarantee — but a weigher whose pull silently
// returned nothing for half the feed would look like a bug, and this way it is
// a decision with a name.
//
// `weekPrice` is on the list and it is not an afterthought. GET
// /v1/prices/weeks/* answers 403 to a weigher and GET /v1/farm hands him the
// farm with priceCents removed; the feed was handing him the whole season's
// price list — every week, to the peso — through the one endpoint his handset
// is required to call. A weekPrice row is nothing BUT a price, so there is no
// reduced body worth composing: the seq is consumed and the row is not sent,
// exactly as for a settlement.
//
// farmConfig is not here, because a weigher does need it: it carries the
// timezone, the currency and the minor unit, without which his screen cannot
// render a date or an amount. It travels with priceCents dropped — see
// composeFarmConfig — which is the same projection /v1/farm already applies.
func (e SyncEntity) money() bool {
	return e == EntitySettlement || e == EntityLedgerEntry || e == EntityWeekPrice
}

// SyncChange is one row of the feed with its body attached.
type SyncChange struct {
	Seq    int64      `json:"seq"`
	Entity SyncEntity `json:"entity"`
	Op     string     `json:"op"`
	Row    any        `json:"row"`
}

// SyncCursor is where the server is now for this farm.
func SyncCursor(ctx context.Context, tx pgx.Tx) (int64, error) {
	var cursor int64
	err := tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(seq), 0) FROM sync_log WHERE farm_id = current_farm()`).Scan(&cursor)
	return cursor, err
}

// SyncBehind is how many changes the phone has not seen. It is what turns the
// status chip of §7.1 from a spinner into a number a person can act on.
func SyncBehind(ctx context.Context, tx pgx.Tx, cursor int64) (int64, error) {
	var behind int64
	err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM sync_log WHERE farm_id = current_farm() AND seq > $1`,
		cursor).Scan(&behind)
	return behind, err
}

// SyncOldestSeq is the oldest change still retained for this farm, or 0 when
// the farm has no feed at all. Retention is 180 days (§3.4); a cursor that
// fell below what is still here cannot be caught up incrementally, and the
// pull says so with CURSOR_TOO_OLD rather than skipping the gap in silence.
func SyncOldestSeq(ctx context.Context, tx pgx.Tx) (int64, error) {
	var oldest int64
	err := tx.QueryRow(ctx,
		`SELECT COALESCE(MIN(seq), 0) FROM sync_log WHERE farm_id = current_farm()`).Scan(&oldest)
	return oldest, err
}

type feedRow struct {
	seq    int64
	entity SyncEntity
	rowID  string
	op     string
}

// SyncFeed reads the identities, under the horizon.
//
// The horizon (§3.4) is the lowest seq still owned by a transaction that may
// not have committed. Everything strictly below it is final, in order, for
// ever. Without it, nextval() hands out 100 to a transaction that commits
// before the one holding 99: a reader takes cursor 100 and never sees 99
// again. A row held back appears in the next poll, in its place.
func SyncFeed(ctx context.Context, tx pgx.Tx, after int64, limit int) ([]feedRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT s.seq, s.entity, s.row_id::text, s.op
		  FROM sync_log s
		 WHERE s.farm_id = current_farm()
		   AND s.seq > $1
		   AND s.seq < sync_horizon(current_farm(), $1)
		 ORDER BY s.seq
		 LIMIT $2`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []feedRow{}
	for rows.Next() {
		var f feedRow
		if err := rows.Scan(&f.seq, &f.entity, &f.rowID, &f.op); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// SyncChanges is the pull: the identities from the feed, each with the body it
// names composed from the real table.
//
// `role` decides which bodies are composed at all, and skipping one does NOT
// hold the cursor back. A weigher has to be able to advance past the first
// payroll of the season; what he must not get is the amount, and he does not.
// The same goes for a row that has since become invisible for any other
// reason: the seq is consumed, the body is absent, and the phone is never left
// waiting for a change that will never compose.
func SyncChanges(ctx context.Context, tx pgx.Tx, after int64, limit int,
	role domain.Role) ([]SyncChange, int64, bool, error) {

	feed, err := SyncFeed(ctx, tx, after, limit+1)
	if err != nil {
		return nil, after, false, err
	}
	more := len(feed) > limit
	if more {
		feed = feed[:limit]
	}

	money := role == domain.RoleOwner || role == domain.RoleAdmin
	cursor := after
	out := []SyncChange{}
	for _, f := range feed {
		cursor = f.seq
		if f.entity.money() && !money {
			continue
		}
		body, err := composeSyncRow(ctx, tx, f)
		if err != nil {
			return nil, cursor, more, err
		}
		if body == nil {
			// The row is gone or filtered — a work record that is not a
			// weighing, a settlement this caller cannot read. The seq is still
			// consumed: silence about a change is only safe if the cursor
			// moves past it.
			continue
		}
		out = append(out, SyncChange{Seq: f.seq, Entity: f.entity, Op: f.op, Row: body})
	}
	return out, cursor, more, nil
}

// composeSyncRow builds one body, or nil when there is nothing to send.
func composeSyncRow(ctx context.Context, tx pgx.Tx, f feedRow) (any, error) {
	switch f.entity {
	case EntityFarmConfig:
		return composeFarmConfig(ctx, tx)
	case EntityWorker:
		return composeWorker(ctx, tx, f.rowID)
	case EntityPlot:
		return composePlot(ctx, tx, f.rowID)
	case EntityCrop:
		return composeCrop(ctx, tx, f.rowID)
	case EntityWeekPrice:
		return composeWeekPrice(ctx, tx, f.rowID)
	case EntityWorkRecord:
		return composeWorkRecord(ctx, tx, f.rowID)
	case EntitySettlement:
		return composeSettlement(ctx, tx, f.rowID)
	case EntityLedgerEntry:
		return composeLedgerEntry(ctx, tx, f.rowID)
	}
	// An entity this build does not know. Skipping it is right: an older
	// server must not choke on a feed written by a newer one.
	return nil, nil
}

func composeFarmConfig(ctx context.Context, tx pgx.Tx) (any, error) {
	var cropType, label, unit, yieldUnit, tz, currency string
	var price int64
	var minorUnit int
	err := tx.QueryRow(ctx, `
		SELECT fc.crop_type, fc.label, fc.unit, fc.yield_unit, fc.price_minor,
		       f.timezone, f.currency, f.minor_unit
		  FROM farm_config fc JOIN farms f ON f.id = fc.farm_id
		 WHERE fc.farm_id = current_farm()`).
		Scan(&cropType, &label, &unit, &yieldUnit, &price, &tz, &currency, &minorUnit)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	row := map[string]any{
		"cropType": cropType, "label": label, "unit": unit, "yieldUnit": yieldUnit,
		"timezone": tz, "currency": currency, "minorUnit": minorUnit,
	}
	// The same projection GET /v1/farm applies, applied here too. The price of
	// a kilo is the number ActionPricesRead keeps behind an administrator, and
	// a field that is refused on one route and delivered on another is not
	// refused at all.
	if currentRoleIsMoney(ctx, tx) {
		row["priceCents"] = price
	}
	return row, nil
}

// composeWorker sends what the phone's own screen holds, plus the fields that
// only exist on the web (photo, phone, address) which travel down and which the
// phone does not overwrite. The document does NOT go to a weigher's handset:
// that is the same projection /v1/workers already applies, and it would be odd
// for the feed to be the way around it.
func composeWorker(ctx context.Context, tx pgx.Tx, id string) (any, error) {
	e, err := GetEmployee(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	row := map[string]any{
		"id": e.ID, "name": e.Name, "lastName": e.LastName, "tag": e.Tag,
		"createdAt": e.CreatedAt, "deletedAt": e.DeletedAt,
	}
	if currentRoleIsMoney(ctx, tx) {
		row["documentType"] = e.DocumentType
		row["docId"] = e.DocID
		row["phone"] = e.Phone
		row["address"] = e.Address
		row["photoId"] = e.PhotoID
	}
	return row, nil
}

func composePlot(ctx context.Context, tx pgx.Tx, id string) (any, error) {
	var name string
	var area *float64
	var deletedAt *time.Time
	err := tx.QueryRow(ctx,
		`SELECT name, area_ha::float8, deleted_at FROM plots WHERE id = $1`, id).
		Scan(&name, &area, &deletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "name": name, "areaHa": area, "deletedAt": deletedAt}, nil
}

func composeCrop(ctx context.Context, tx pgx.Tx, id string) (any, error) {
	var plotID, plotName, cropType string
	var variety *string
	var deletedAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT pc.plot_id::text, p.name, ct.name, v.name, pc.deleted_at
		  FROM plot_crops pc
		  JOIN plots p ON p.id = pc.plot_id
		  JOIN crop_types ct ON ct.id = pc.crop_type_id
		  LEFT JOIN varieties v ON v.id = pc.variety_id
		 WHERE pc.id = $1`, id).
		Scan(&plotID, &plotName, &cropType, &variety, &deletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// `name` is what the phone puts on a button, and on the phone a crop IS
	// the lot: it has one name and the user picks it. The plot's name is that
	// name, with the crop type behind it for the day a lot grows two things —
	// which is also the day §8 phase 9 falls due.
	return map[string]any{
		"id": id, "plotId": plotID, "name": plotName,
		"cropType": cropType, "variety": variety, "deletedAt": deletedAt,
	}, nil
}

// composeWeekPrice finds the week behind the feed's synthetic row_id.
//
// week_prices is keyed by (farm_id, week_start) and has no id of its own, so
// the trigger derives a stable uuid from the week. Recovering the week is a
// scan of a table with one row per week of the season — fifty-odd rows — and
// the alternative, a surrogate key on a two-column table, would have to be
// backfilled onto every farm that already has prices.
func composeWeekPrice(ctx context.Context, tx pgx.Tx, rowID string) (any, error) {
	var week time.Time
	var price int64
	err := tx.QueryRow(ctx, `
		SELECT week_start, price_minor FROM week_prices
		 WHERE farm_id = current_farm()
		   AND md5(farm_id::text || '|weekPrice|' || week_start::text)::uuid = $1`, rowID).
		Scan(&week, &price)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"weekStart": week.Format("2006-01-02"), "priceCents": price,
	}, nil
}

// composeWorkRecord sends weighings and nothing else (§2.2).
//
// A day's wage on a screen that only knows how to show kilos is worse than
// nothing — which is exactly what GET /v1/pickups/{id} already decided when it
// answers 404 for a record that is not paid by the unit of work. The phone
// therefore cannot show the full detail of somebody who also did wages, and
// that is why the balance it displays comes from the server (§2.2, decision 7)
// rather than from its own sum.
func composeWorkRecord(ctx context.Context, tx pgx.Tx, id string) (any, error) {
	var employeeID, scheme string
	var cropID *string
	var qty string
	var startedAt time.Time
	var localDay, weekStart time.Time
	var note, deviceID *string
	var deletedAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT l.employee_id::text, l.pay_scheme::text, l.quantity::text, l.started_at,
		       l.local_day, l.week_start, l.note, l.device_id::text, l.deleted_at,
		       (SELECT c.plot_crop_id::text FROM work_record_plot_crops c
		         WHERE c.work_record_id = l.id LIMIT 1)
		  FROM work_records l WHERE l.id = $1`, id).
		Scan(&employeeID, &scheme, &qty, &startedAt, &localDay, &weekStart,
			&note, &deviceID, &deletedAt, &cropID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if domain.PayScheme(scheme) != domain.PaySchemeWorkUnit {
		return nil, nil
	}
	return map[string]any{
		"id": id, "workerId": employeeID, "cropId": cropID,
		"quantity": json.Number(qty), "occurredAt": startedAt,
		"localDay": localDay.Format("2006-01-02"), "weekStart": weekStart.Format("2006-01-02"),
		"note": note, "deviceId": deviceID, "deletedAt": deletedAt,
	}, nil
}

// composeSettlement sends the header WITH ITS LINES, always.
//
// §3.3 is emphatic and so is the phone's own history: a document for
// $1.187.500 with nothing underneath it is precisely what the phone's
// user_version = 4 migration existed to repair. That is why the trigger on
// settlement_items reports its parent instead of itself — a line changing is a
// settlement changing.
func composeSettlement(ctx context.Context, tx pgx.Tx, id string) (any, error) {
	s, err := GetSettlement(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0, len(s.Items))
	for _, it := range s.Items {
		items = append(items, map[string]any{
			"payableId": it.PayableID, "weekStart": it.WeekStart.Format("2006-01-02"),
			"quantity": it.Quantity, "priceCents": it.PriceMinor,
			"amountCents": it.AmountMinor, "voided": it.Voided,
		})
	}
	return map[string]any{
		"id": s.ID, "workerId": s.EmployeeID,
		"periodStart": s.PeriodStart.Format("2006-01-02"),
		"periodEnd":   s.PeriodEnd.Format("2006-01-02"),
		"grossCents":  s.GrossMinor, "status": s.Status, "note": s.Note,
		"createdAt": s.CreatedAt, "voidedAt": s.VoidedAt, "items": items,
	}, nil
}

func composeLedgerEntry(ctx context.Context, tx pgx.Tx, id string) (any, error) {
	e, err := FindLedgerEntry(ctx, tx, id)
	if err != nil || e == nil {
		return nil, err
	}
	return map[string]any{
		"id": e.ID, "workerId": e.EmployeeID, "kind": e.Kind,
		"amountCents": e.AmountMinor, "date": e.LocalDay.Format("2006-01-02"),
		"settlementId": e.SettlementID, "method": e.Method, "note": e.Note,
		"reversesId": e.ReversesID, "createdAt": e.CreatedAt,
	}, nil
}

func currentRoleIsMoney(ctx context.Context, tx pgx.Tx) bool {
	var role string
	if err := tx.QueryRow(ctx, `SELECT current_role_name()`).Scan(&role); err != nil {
		return false
	}
	return role == string(domain.RoleOwner) || role == string(domain.RoleAdmin)
}

// SyncBalance is the checksum of §3.3 — and it is a checksum, not a datum.
//
// The phone recomputes the balance with its own BALANCE_SQL and COMPARES. If
// they differ it does not copy the number: it flags the worker and puts them on
// the review screen. A balance that arrives down the wire and gets stored is
// the materialised total three documents in a row have refused. It travels only
// in the last batch, when the handset is already up to date.
type SyncBalance struct {
	WorkerID     string `json:"workerId"`
	BalanceMinor int64  `json:"balanceCents"`
}

func SyncBalances(ctx context.Context, tx pgx.Tx) ([]SyncBalance, error) {
	all, err := ListBalances(ctx, tx)
	if err != nil {
		return nil, err
	}
	out := make([]SyncBalance, 0, len(all))
	for _, b := range all {
		out = append(out, SyncBalance{WorkerID: b.EmployeeID, BalanceMinor: b.BalanceMinor})
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// The operation registry (§4.2)
// ---------------------------------------------------------------------------

// SyncOpResult is what one envelope produced, stored verbatim so a resend
// returns THE SAME ANSWER rather than a second attempt at the same act.
type SyncOpResult struct {
	OpID   string          `json:"opId"`
	Status string          `json:"status"`
	ID     string          `json:"id,omitempty"`
	Error  *SyncOpError    `json:"error,omitempty"`
	Row    json.RawMessage `json:"-"`
}

type SyncOpError struct {
	Code    domain.Code    `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// SyncOpFingerprint is the sha-256 of the QUESTION an envelope asked: its
// entity, its op and its payload, byte for byte as they arrived.
//
// The payload is hashed raw and not re-marshalled. A resend from the same
// handset sends the same bytes; normalising them first would be inventing an
// equivalence — is a reordered object the same act? is a trailing zero? — that
// nothing here needs and that would decide, wrongly, in the one case that
// matters.
func SyncOpFingerprint(entity, op string, payload []byte) string {
	sum := sha256.New()
	sum.Write([]byte(entity))
	sum.Write([]byte{0})
	sum.Write([]byte(op))
	sum.Write([]byte{0})
	sum.Write(payload)
	return hex.EncodeToString(sum.Sum(nil))
}

// ErrOpIDReused is the answer to an opId that came back carrying a different
// act. See migration 00015: returning the first act's answer told the handset
// its second weighing was `applied`, and the handset believed it.
var ErrOpIDReused = domain.Conflict(domain.CodeIdempotencyKeyReused,
	"that opId was already used for a different operation; a new act needs a new key")

// FindSyncOp returns the answer this opId already got, or nil.
//
// This is the layer client-side UUIDs cannot provide. An insert of a row with
// its own uuid is idempotent by construction; voiding and reversing are not —
// their second attempt has a different answer from the first — and this table
// is what makes those safe to resend too.
//
// `fingerprint` is what separates a resend from a collision. It matches, and
// the stored answer is returned as §4.2 says. It differs, and ErrOpIDReused
// comes back instead — the one thing that must never happen is answering
// `applied` with somebody else's row id. An empty fingerprint, or a stored row
// from before migration 00015, cannot be compared and falls back to the old
// behaviour.
func FindSyncOp(ctx context.Context, tx pgx.Tx, opID, fingerprint string) (*SyncOpResult, error) {
	var raw []byte
	var stored *string
	err := tx.QueryRow(ctx,
		`SELECT result, fingerprint FROM sync_ops WHERE op_id = $1`, opID).Scan(&raw, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if fingerprint != "" && stored != nil && *stored != fingerprint {
		return nil, ErrOpIDReused
	}
	var out SyncOpResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func RecordSyncOp(ctx context.Context, tx pgx.Tx, farmID, opID, deviceID, fingerprint string,
	r SyncOpResult) error {

	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO sync_ops (op_id, farm_id, device_id, status, result, fingerprint)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (op_id) DO NOTHING`,
		opID, farmID, deviceID, r.Status, raw, nilIfEmpty(fingerprint))
	return err
}

// UpsertSyncWorker is the phone's half of the `people` table (§2).
//
// It writes ONLY the columns the phone's own screen edits. The photo, the
// telephone and the address exist only on the web, travel down, and are not
// touched here — a push that sent every column would blank them on every sync,
// which is the quiet kind of data loss nobody attributes to the right cause.
//
// The return says whether a row was created, which is what tells `applied` from
// `duplicate`: zero rows out of the insert means it was already there (§4.1).
func UpsertSyncWorker(ctx context.Context, tx pgx.Tx, farmID string, e Employee) (*Employee, bool, error) {
	out, err := scanEmployee(tx.QueryRow(ctx, `
		INSERT INTO employees (id, farm_id, name, last_name, document_type, doc_id, tag)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO NOTHING
		RETURNING `+employeeCols,
		e.ID, farmID, e.Name, e.LastName, e.DocumentType, e.DocID, e.Tag))
	if err == nil {
		return out, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		// A collision on the document or the tag, rendered as the answer the
		// REST route gives rather than as the constraint that fired. The
		// caller here is always an administrator — pushWorker refuses the
		// weigher before this is reached — and an administrator reads the
		// document off /v1/workers anyway, so naming it tells them nothing
		// they could not already see.
		if IsUniqueViolation(err, "ux_employees_doc") {
			return nil, false, domain.Conflict(domain.CodeDuplicateDocument,
				"another worker on this farm already carries that document")
		}
		if IsUniqueViolation(err, "ux_employees_tag") {
			return nil, false, domain.Conflict(domain.CodeDuplicateName,
				"another worker on this farm already carries that tag")
		}
		return nil, false, err
	}

	existing, err := GetEmployee(ctx, tx, e.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The id belongs to a row this farm cannot see. Same answer as
		// AddLedgerEntry gives, for the same reason: confirming it exists
		// elsewhere would confirm another farm's id.
		return nil, false, domain.Conflict(domain.CodeIdempotencyKeyReused,
			"that id is already in use")
	}
	if err != nil {
		return nil, false, err
	}
	updated, err := scanEmployee(tx.QueryRow(ctx, `
		UPDATE employees SET
			name          = coalesce($2, name),
			last_name     = coalesce($3, last_name),
			document_type = coalesce($4, document_type),
			doc_id        = coalesce($5, doc_id),
			tag           = coalesce($6, tag)
		 WHERE id = $1
		 RETURNING `+employeeCols,
		e.ID, nilIfEmpty(e.Name), e.LastName, e.DocumentType, e.DocID, e.Tag))
	if err != nil {
		return nil, false, err
	}
	_ = existing
	return updated, false, nil
}
