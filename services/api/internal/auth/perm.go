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

	// The audit of decision 8. It is a read of personnel history — who took
	// somebody off the payroll, and what put them back on — so it sits with
	// the private file rather than with the worker list.
	ActionReactivationsRead Action = "workers.reactivations.read"

	// Who can log in to this farm. A membership, not a person: the account is
	// global and this is the role it holds HERE.
	ActionUsersRead  Action = "users.read"
	ActionUsersWrite Action = "users.write"

	ActionPlotsRead     Action = "plots.read"
	ActionPlotsWrite    Action = "plots.write"
	ActionPlotsBoundary Action = "plots.boundary.write"

	ActionFarmRead  Action = "farm.read"
	ActionFarmWrite Action = "farm.write"

	// Adding another farm to an account that already exists. It used to be the
	// second half of the public signup, where it could only ask for a password
	// and so turned the registration form into a password oracle.
	ActionFarmsCreate Action = "farms.create"

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
	ActionSettlementsRelease Action = "settlements.release"
	ActionPendingRead        Action = "pending.read"
	ActionBalancesRead       Action = "balances.read"
	ActionLedgerRead         Action = "ledger.read"
	ActionLedgerPayment      Action = "ledger.payment"
	ActionLedgerAdvance      Action = "ledger.advance"
	ActionLedgerDeduction    Action = "ledger.deduction"
	ActionLedgerAdjust       Action = "ledger.adjust"
	ActionLedgerReverse      Action = "ledger.reverse"

	// Products, inventory, sales and expenses. Every one of these is Money in
	// the table below — see the note there.
	ActionProductsRead  Action = "products.read"
	ActionProductsWrite Action = "products.write"
	ActionStockRead     Action = "stock.read"
	ActionStockWrite    Action = "stock.write"
	ActionSalesRead     Action = "sales.read"
	ActionSalesWrite    Action = "sales.write"
	ActionSalesVoid     Action = "sales.void"
	ActionExpensesRead  Action = "expenses.read"
	ActionExpensesWrite Action = "expenses.write"

	ActionUploadsRead  Action = "uploads.read"
	ActionUploadsWrite Action = "uploads.write"

	// Synchronisation. Three actions rather than one, because they are
	// refused for different reasons the day one of them has to be: a handset
	// can be allowed to receive long after it is stopped from sending.
	ActionSyncHandshake Action = "sync.handshake"
	ActionSyncPush      Action = "sync.push"
	ActionSyncPull      Action = "sync.pull"

	// The one-off import of a season that already exists on a handset.
	ActionImportSeason Action = "import.season"

	// The harvest reports. One action for all six, because they are one
	// module and they are refused as one — see the note in the table below.
	ActionReportsRead Action = "reports.read"
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
	// balances, settlements, a worker's private file, sales, expenses,
	// stock on hand, and (when it exists) the registry. A contract test walks
	// this table and asserts 403 for the weigher on every one of them.
	//
	// Stock is on that list even though a sack of coffee is not a peso.
	// docs/modelo-datos.md §9 is explicit: "ventas, gastos y stock_moves
	// are out of the weigher's reach the same way the ledger is". The flag is
	// what the contract test walks, so anything the weigher must not see
	// carries it — the name is about payroll because that is where it
	// started, not because that is where it stops.
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

	// The reactivation audit. Administrator only and on the deny list, for the
	// same reason the notes are: it is a record of decisions taken ABOUT
	// people — who was taken off the payroll, by whom, and what undid it —
	// which is the one kind of text decision 1 keeps nailed to the farm. The
	// weigher's own handset is what triggers most of these rows and he still
	// does not read them back.
	ActionReactivationsRead: {Roles: admins, Money: true},

	// User management. Administrator only, and NOT Money: a member list is
	// names, addresses and roles, and there is not a peso in it. What keeps it
	// safe is not this flag, it is the two rules in handlers_users.go — a farm
	// keeps an owner, and nobody grants a role above their own — which no
	// permission table can express because they depend on the caller's own row.
	//
	// Both halves are `admins` rather than `owners`. An owner-only module
	// would mean a farm cannot add a weigher while the owner is out, which on
	// a farm is most of the week; the escalation that would otherwise open up
	// is closed by the grant rule instead, where it belongs.
	ActionUsersRead:  {Roles: admins},
	ActionUsersWrite: {Roles: admins},

	ActionPlotsRead:     {Roles: everyone},
	ActionPlotsWrite:    {Roles: admins},
	ActionPlotsBoundary: {Roles: admins},

	// The farm's own record. Everybody reads it — the weigher's client needs
	// the timezone and the currency to render a date and an amount — but the
	// projection drops priceCents for him, because that is the price of a
	// kilo. Only the owner writes it.
	ActionFarmRead:  {Roles: everyone},
	ActionFarmWrite: {Roles: owners},

	// Every role, and it is not an oversight. Owning a farm is a property of
	// the ACCOUNT and not of the role it holds on somebody else's farm: a
	// weigher who wants a farm of his own would otherwise have to register a
	// second email address to get one, which teaches the habit the cap exists
	// to discourage. What bounds it is MaxFarmsPerEmail, counted per account.
	//
	// Not Money: it creates an empty farm and reads nothing of this one.
	ActionFarmsCreate: {Roles: everyone},

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

	// The release is the owner's alone, which is one notch stricter than the
	// void beside it, and deliberately so. Voiding cancels a document; this
	// frees a weighing that a cancelled document was still holding, which puts
	// money back into circulation — the weighing becomes payable again and the
	// next settlement pays it. It is a repair of the farm's books rather than a
	// day's administration, it is the same shape as ActionImportSeason, and it
	// is rare enough that needing the owner costs a farm nothing.
	ActionSettlementsRelease: {Roles: owners, Money: true},
	ActionPendingRead:        {Roles: admins, Money: true},
	ActionBalancesRead:       {Roles: admins, Money: true},
	ActionLedgerRead:         {Roles: admins, Money: true},
	ActionLedgerPayment:      {Roles: admins, Money: true},
	ActionLedgerAdvance:      {Roles: admins, Money: true},
	ActionLedgerDeduction:    {Roles: admins, Money: true},
	ActionLedgerAdjust:       {Roles: admins, Money: true},
	ActionLedgerReverse:      {Roles: admins, Money: true},

	// Products, inventory, sales and expenses. All admin, all Money.
	//
	// The weigher is kept out of the whole surface and not only out of the
	// prices in it, because "al entrar a cualquier modulo sin privilegios, el
	// sistema notifica la carencia y saca al usuario del modulo" is what the
	// use cases say about a module, and because a product list carries its
	// stock on hand: RSP-018 puts "unidades existentes" on the very first
	// screen, so there is no reduced projection of it worth the trouble.
	ActionProductsRead:  {Roles: admins, Money: true},
	ActionProductsWrite: {Roles: admins, Money: true},
	ActionStockRead:     {Roles: admins, Money: true},
	ActionStockWrite:    {Roles: admins, Money: true},
	ActionSalesRead:     {Roles: admins, Money: true},
	ActionSalesWrite:    {Roles: admins, Money: true},
	ActionSalesVoid:     {Roles: admins, Money: true},
	ActionExpensesRead:  {Roles: admins, Money: true},
	ActionExpensesWrite: {Roles: admins, Money: true},

	// Uploads are not money and not on the deny list: they are photographs.
	// They are administrator-only all the same, because the two things that
	// carry one — an employee's file and a sale receipt — are both
	// administrator work, and an upload endpoint open to every role is a
	// place to put five megabytes of anything.
	ActionUploadsRead:  {Roles: admins},
	ActionUploadsWrite: {Roles: admins},

	// Sync is every role's, and that is the point: the person who works for
	// days without signal is the weigher, and stopping his handset from
	// synchronising stops the scale. It is NOT marked Money, and it must not
	// be — a Money flag here would make the contract test demand a 403 for the
	// weigher on the very endpoint his handset lives on.
	//
	// What keeps payroll away from him is not this table, it is the pull
	// itself: the bodies of `settlement` and `ledgerEntry` are composed from
	// tables p_settlements and p_ledger already close to him, and the pull
	// skips them by role rather than pretending to send an empty one. He
	// advances his cursor past them and sees no amount.
	ActionSyncHandshake: {Roles: everyone},
	ActionSyncPush:      {Roles: everyone},
	ActionSyncPull:      {Roles: everyone},

	// The import is the owner's alone and is Money. It writes a season of
	// settlements and a season of ledger in one act; there is no version of
	// that which an administrator does by themselves, and none at all that
	// goes anywhere near the weigher.
	ActionImportSeason: {Roles: owners, Money: true},

	// The reports. Administrator only, and Money, which is what makes the
	// contract test assert 403 for the weigher on all six.
	//
	// One action rather than a money half and a kilos half, for two reasons.
	// The first is what the endpoints actually carry: the weekly list and the
	// crop detail put kilos AND value on the first screen, so there is no
	// reduced projection of them worth the trouble — the same argument
	// ActionProductsRead makes about stock on hand on RSP-018.
	//
	// The second matters more. The two reports with no peso in them are the
	// two that judge people: the comparative index is the number a farm would
	// use to decide who not to hire again, and the review rules accuse
	// somebody of mis-weighing — usually the weigher himself. "El pesador no
	// ve reportes de dinero" is the floor here, not the ceiling.
	ActionReportsRead: {Roles: admins, Money: true},
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
