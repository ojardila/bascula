package auth

import (
	"sort"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Action is what a request is trying to do. Every route declares exactly one,
// and this file is the only place that decides who may perform it.
//
// The permissions live in ONE TABLE, not in an `if` per handler. With nine
// modules coming, a per-handler check is not hygiene, it is the only defence
// that scales: a table can be walked by a test, and a hundred `if`s cannot.
type Action string

const (
	ActionHealth      Action = "health"
	ActionSignup      Action = "signup"
	ActionLogin       Action = "auth.login"
	ActionRefresh     Action = "auth.refresh"
	ActionVerifyEmail Action = "auth.verify_email"
	ActionLogout      Action = "auth.logout"
	ActionMeRead      Action = "me.read"

	ActionWorkersRead     Action = "workers.read"
	ActionWorkersWrite    Action = "workers.write"
	ActionWorkersPrivate  Action = "workers.read_private"
	ActionWorkerNotesRead Action = "workers.notes.read"
	ActionWorkerNotesAdd  Action = "workers.notes.write"
	ActionWorkerPayables  Action = "workers.payables.read"

	ActionPlotsRead     Action = "plots.read"
	ActionPlotsWrite    Action = "plots.write"
	ActionPlotsBoundary Action = "plots.boundary.write"

	ActionFarmRead  Action = "farm.read"
	ActionFarmWrite Action = "farm.write"

	// The super-admin console. Decision 2 shrank it to what it still needs:
	// see the farms, suspend one, and nothing else. It never reads a worker,
	// a work record or a peso of anybody's money.
	ActionAdminFarmsRead  Action = "admin.farms.read"
	ActionAdminFarmsWrite Action = "admin.farms.write"

	ActionCatalogsRead  Action = "catalogs.read"
	ActionCatalogsWrite Action = "catalogs.write"

	ActionActivitiesRead  Action = "activities.read"
	ActionActivitiesWrite Action = "activities.write"
	ActionActivityRate    Action = "activities.rate.write"

	ActionWorkRecordsRead  Action = "work_records.read"
	ActionWorkRecordsWrite Action = "work_records.write"
	ActionWorkRecordsAdmin Action = "work_records.admin"

	ActionPricesRead  Action = "prices.read"
	ActionPricesWrite Action = "prices.write"

	ActionSettlementsPreview Action = "settlements.preview"
	ActionSettlementsRead    Action = "settlements.read"
	ActionSettlementsWrite   Action = "settlements.write"
	ActionSettlementsVoid    Action = "settlements.void"
	ActionPendingRead        Action = "pending.read"
	ActionBalancesRead       Action = "balances.read"
	ActionLedgerRead         Action = "ledger.read"
	ActionLedgerPayment      Action = "ledger.payment"
	ActionLedgerAdvance      Action = "ledger.advance"
	ActionLedgerDeduction    Action = "ledger.deduction"
	ActionLedgerAdjust       Action = "ledger.adjust"
	ActionLedgerReverse      Action = "ledger.reverse"
)

// Rule is one row of the permission table.
type Rule struct {
	// Public means the action needs no token at all. The only public actions
	// are health and the three doors into a session.
	Public bool
	// Roles that may perform the action. Empty with Public false means "any
	// authenticated member of the farm", which is only used for /me and logout.
	Roles []domain.Role
	// Money marks the surface the weigher must never reach: payroll, prices,
	// balances, settlements, a worker's private file, and (when it exists) the
	// registry. A contract test walks this table and asserts 403 for the
	// weigher on every one of them.
	Money bool
	// TenantOptional marks actions that run before a farm is chosen. Every
	// other action goes through the tenant middleware and gets a transaction
	// with app.farm_id set.
	TenantOptional bool
	// Superadmin means the platform flag on the user is required on top of
	// the farm role. It is not a fourth farm role: a super-admin administers
	// farms from the outside and cannot read inside one, which is why the
	// only actions carrying this are the two in the console.
	Superadmin bool
}

var owners = []domain.Role{domain.RoleOwner}
var admins = []domain.Role{domain.RoleOwner, domain.RoleAdmin}
var everyone = []domain.Role{domain.RoleOwner, domain.RoleAdmin, domain.RoleWeigher}

// Matrix is the permission table. A route whose action is missing here fails
// the contract test, which is the point.
var Matrix = map[Action]Rule{
	ActionHealth:      {Public: true, TenantOptional: true},
	ActionSignup:      {Public: true, TenantOptional: true},
	ActionLogin:       {Public: true, TenantOptional: true},
	ActionRefresh:     {Public: true, TenantOptional: true},
	ActionVerifyEmail: {Public: true, TenantOptional: true},
	ActionLogout:      {Roles: everyone},
	ActionMeRead:      {Roles: everyone},

	// The weigher reads workers, but the handler hands him a reduced
	// projection: id, name, lastName, tag. No document, no phone, no photo.
	ActionWorkersRead:    {Roles: everyone},
	ActionWorkersWrite:   {Roles: admins},
	ActionWorkersPrivate: {Roles: admins, Money: true},

	// Notes are a person's private file. Decision 1 says they are born
	// private and have no exit route out of the farm; §6 puts them on the
	// weigher's deny list next to payroll, and the RLS policy on
	// employee_notes says it a second time.
	ActionWorkerNotesRead: {Roles: admins, Money: true},
	ActionWorkerNotesAdd:  {Roles: admins, Money: true},
	ActionWorkerPayables:  {Roles: admins, Money: true},

	ActionPlotsRead:     {Roles: everyone},
	ActionPlotsWrite:    {Roles: admins},
	ActionPlotsBoundary: {Roles: admins},

	// The farm's own record. Everybody reads it — the weigher's client needs
	// the timezone and the currency to render a date and an amount — but the
	// projection drops priceCents for him, because that is the price of a
	// kilo. Only the owner writes it.
	ActionFarmRead:  {Roles: everyone},
	ActionFarmWrite: {Roles: owners},

	ActionAdminFarmsRead:  {Roles: everyone, Superadmin: true, Money: true},
	ActionAdminFarmsWrite: {Roles: everyone, Superadmin: true, Money: true},

	// Catalogues are names, not prices. The weigher reads them because his
	// screens have the same pickers; only an administrator adds to them.
	ActionCatalogsRead:  {Roles: everyone},
	ActionCatalogsWrite: {Roles: admins},

	// Same route, different projection: the weigher's activity list comes
	// without rates. The rate itself is the owner's alone.
	ActionActivitiesRead:  {Roles: everyone},
	ActionActivitiesWrite: {Roles: admins},
	ActionActivityRate:    {Roles: owners, Money: true},

	// The weigher records work and reads back only his own, enforced again by
	// the RLS policy on work_records.
	ActionWorkRecordsRead:  {Roles: everyone},
	ActionWorkRecordsWrite: {Roles: everyone},
	ActionWorkRecordsAdmin: {Roles: admins},

	ActionPricesRead:  {Roles: admins, Money: true},
	ActionPricesWrite: {Roles: owners, Money: true},

	ActionSettlementsPreview: {Roles: admins, Money: true},
	ActionSettlementsRead:    {Roles: admins, Money: true},
	ActionSettlementsWrite:   {Roles: admins, Money: true},
	ActionSettlementsVoid:    {Roles: admins, Money: true},
	ActionPendingRead:        {Roles: admins, Money: true},
	ActionBalancesRead:       {Roles: admins, Money: true},
	ActionLedgerRead:         {Roles: admins, Money: true},
	ActionLedgerPayment:      {Roles: admins, Money: true},
	ActionLedgerAdvance:      {Roles: admins, Money: true},
	ActionLedgerDeduction:    {Roles: admins, Money: true},
	ActionLedgerAdjust:       {Roles: admins, Money: true},
	ActionLedgerReverse:      {Roles: admins, Money: true},
}

// Allowed reports whether a farm role, on its own, may perform an action.
//
// A rule that asks for the platform flag is never satisfied by a farm role, so
// the super-admin console is invisible to every member of every farm — the
// owner included. That is what makes it correct for the contract test to walk
// this table alone and conclude that the weigher is refused: the answer here
// and the answer at the door are the same answer.
func Allowed(role domain.Role, a Action) bool { return AllowedFor(role, false, a) }

// AllowedFor is Allowed with the platform flag from the token.
func AllowedFor(role domain.Role, superadmin bool, a Action) bool {
	rule, ok := Matrix[a]
	if !ok {
		// An unknown action is a closed door, never an open one.
		return false
	}
	if rule.Public {
		return true
	}
	if rule.Superadmin && !superadmin {
		return false
	}
	for _, r := range rule.Roles {
		if r == role {
			return true
		}
	}
	return false
}

// MoneyActions lists every action the weigher must be denied. Sorted so the
// contract test reports stably.
func MoneyActions() []Action {
	var out []Action
	for a, r := range Matrix {
		if r.Money {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
