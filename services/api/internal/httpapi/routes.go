package httpapi

import (
	"net/http"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// Route ties a URL to an action. This slice is the router: nothing is mounted
// on the mux by any other path, so a route physically cannot exist without an
// entry here, and an entry cannot exist without an action in
// auth.Matrix. A contract test walks the built mux and fails if either half
// of that ever stops being true.
type Route struct {
	Method  string
	Pattern string
	Action  auth.Action
	Handler http.HandlerFunc
}

// Routes is the whole surface of the API.
func (s *Server) Routes() []Route {
	return []Route{
		{http.MethodGet, "/health", auth.ActionHealth, s.handleHealth},

		// Auth. Signup is public by decision 2: a farm goes live without
		// anybody at the platform intervening, after the address is verified.
		{http.MethodPost, "/v1/signup", auth.ActionSignup, s.handleSignup},
		{http.MethodPost, "/v1/auth/login", auth.ActionLogin, s.handleLogin},
		{http.MethodPost, "/v1/auth/refresh", auth.ActionRefresh, s.handleRefresh},
		{http.MethodPost, "/v1/auth/verify-email", auth.ActionVerifyEmail, s.handleVerifyEmail},
		{http.MethodPost, "/v1/auth/logout", auth.ActionLogout, s.handleLogout},
		{http.MethodGet, "/v1/me", auth.ActionMeRead, s.handleMe},

		// The farm's own record. The weigher reads it without the price.
		{http.MethodGet, "/v1/farm", auth.ActionFarmRead, s.handleGetFarm},
		{http.MethodPut, "/v1/farm", auth.ActionFarmWrite, s.handleUpdateFarm},

		// The super-admin console, and all of it. Decision 2 made the public
		// signup the front door and left this with two jobs.
		{http.MethodGet, "/v1/admin/farms", auth.ActionAdminFarmsRead, s.handleListAdminFarms},
		{http.MethodPatch, "/v1/admin/farms/{id}", auth.ActionAdminFarmsWrite, s.handleSetFarmStatus},

		// Workers.
		{http.MethodGet, "/v1/workers", auth.ActionWorkersRead, s.handleListWorkers},
		{http.MethodPost, "/v1/workers", auth.ActionWorkersWrite, s.handleCreateWorker},
		{http.MethodGet, "/v1/workers/{id}", auth.ActionWorkersRead, s.handleGetWorker},
		{http.MethodPatch, "/v1/workers/{id}", auth.ActionWorkersWrite, s.handleUpdateWorker},
		{http.MethodDelete, "/v1/workers/{id}", auth.ActionWorkersWrite, s.handleDeleteWorker},
		{http.MethodGet, "/v1/workers/{id}/profile", auth.ActionWorkersPrivate, s.handleWorkerProfile},
		{http.MethodGet, "/v1/workers/{id}/payables", auth.ActionWorkerPayables, s.handleWorkerPayables},
		{http.MethodGet, "/v1/workers/{id}/notes", auth.ActionWorkerNotesRead, s.handleListWorkerNotes},
		{http.MethodPost, "/v1/workers/{id}/notes", auth.ActionWorkerNotesAdd, s.handleAddWorkerNote},

		// Plots, with their crops nested: the form is one form.
		{http.MethodGet, "/v1/plots", auth.ActionPlotsRead, s.handleListPlots},
		{http.MethodPost, "/v1/plots", auth.ActionPlotsWrite, s.handleCreatePlot},
		{http.MethodGet, "/v1/plots/{id}", auth.ActionPlotsRead, s.handleGetPlot},
		{http.MethodPatch, "/v1/plots/{id}", auth.ActionPlotsWrite, s.handleUpdatePlot},
		{http.MethodDelete, "/v1/plots/{id}", auth.ActionPlotsWrite, s.handleDeletePlot},
		{http.MethodPut, "/v1/plots/{id}/boundary", auth.ActionPlotsBoundary, s.handleSetPlotBoundary},
		{http.MethodPost, "/v1/plots/{id}/crops", auth.ActionPlotsWrite, s.handleCreatePlotCrop},
		{http.MethodDelete, "/v1/plots/{id}/crops/{cropId}", auth.ActionPlotsWrite, s.handleDeletePlotCrop},

		// Activities. Same route, different projection: the weigher's list
		// comes back without a single rate in it.
		{http.MethodGet, "/v1/activities", auth.ActionActivitiesRead, s.handleListActivities},
		{http.MethodPost, "/v1/activities", auth.ActionActivitiesWrite, s.handleCreateActivity},
		{http.MethodPatch, "/v1/activities/{id}", auth.ActionActivitiesWrite, s.handleUpdateActivity},
		{http.MethodDelete, "/v1/activities/{id}", auth.ActionActivitiesWrite, s.handleArchiveActivity},
		{http.MethodGet, "/v1/activities/{id}/rates", auth.ActionActivityRate, s.handleListActivityRates},
		{http.MethodPut, "/v1/activities/{id}/rate", auth.ActionActivityRate, s.handleSetActivityRate},

		// Catalogues. None of these is an enum: every one is a table a farm can
		// add to, which is what "with an option to create a new one" means.
		{http.MethodGet, "/v1/catalogs/work-units", auth.ActionCatalogsRead, s.handleListWorkUnits},
		{http.MethodPost, "/v1/catalogs/work-units", auth.ActionCatalogsWrite, s.handleCreateWorkUnit},
		{http.MethodGet, "/v1/catalogs/activity-categories", auth.ActionCatalogsRead,
			s.handleListCatalog(store.CatalogActivityCategories)},
		{http.MethodPost, "/v1/catalogs/activity-categories", auth.ActionCatalogsWrite,
			s.handleCreateCatalogItem(store.CatalogActivityCategories)},
		{http.MethodGet, "/v1/catalogs/crop-types", auth.ActionCatalogsRead,
			s.handleListCatalog(store.CatalogCropTypes)},
		{http.MethodPost, "/v1/catalogs/crop-types", auth.ActionCatalogsWrite,
			s.handleCreateCatalogItem(store.CatalogCropTypes)},
		{http.MethodGet, "/v1/catalogs/varieties", auth.ActionCatalogsRead,
			s.handleListCatalog(store.CatalogVarieties)},
		{http.MethodPost, "/v1/catalogs/varieties", auth.ActionCatalogsWrite,
			s.handleCreateCatalogItem(store.CatalogVarieties)},

		// Work records — "labor" in the Spanish interface, which is the owner's
		// word. The weigher writes them and reads back only his own, which the
		// RLS policy on work_records enforces a second time.
		{http.MethodGet, "/v1/work-records", auth.ActionWorkRecordsRead, s.handleListWorkRecords},
		{http.MethodPost, "/v1/work-records", auth.ActionWorkRecordsWrite, s.handleCreateWorkRecord},
		{http.MethodGet, "/v1/work-records/{id}", auth.ActionWorkRecordsRead, s.handleGetWorkRecord},
		{http.MethodPatch, "/v1/work-records/{id}", auth.ActionWorkRecordsAdmin, s.handleUpdateWorkRecord},
		{http.MethodDelete, "/v1/work-records/{id}", auth.ActionWorkRecordsAdmin, s.handleDeleteWorkRecord},

		// The legacy pickup facade, so the phone in a farm's pocket keeps
		// working through the transition. It is a translation onto the routes
		// above, not a second implementation: see handlers_pickups.go.
		{http.MethodGet, "/v1/pickups", auth.ActionWorkRecordsRead, s.handleListPickups},
		{http.MethodPost, "/v1/pickups", auth.ActionWorkRecordsWrite, s.handleCreatePickup},
		{http.MethodGet, "/v1/pickups/{id}", auth.ActionWorkRecordsRead, s.handleGetPickup},
		{http.MethodDelete, "/v1/pickups/{id}", auth.ActionWorkRecordsAdmin, s.handleDeletePickup},

		// Prices.
		{http.MethodGet, "/v1/prices/weeks/{monday}", auth.ActionPricesRead, s.handleGetWeekPrice},
		{http.MethodPut, "/v1/prices/weeks/{monday}", auth.ActionPricesWrite, s.handleSetWeekPrice},

		// Money. Every one of these is Money:true in the permission table, and
		// the contract test asserts 403 for the weigher on all of them.
		{http.MethodGet, "/v1/pending", auth.ActionPendingRead, s.handlePending},
		{http.MethodGet, "/v1/balances", auth.ActionBalancesRead, s.handleListBalances},
		{http.MethodGet, "/v1/workers/{id}/balance", auth.ActionBalancesRead, s.handleWorkerBalance},
		{http.MethodGet, "/v1/workers/{id}/ledger", auth.ActionLedgerRead, s.handleWorkerLedger},
		{http.MethodPost, "/v1/settlements/preview", auth.ActionSettlementsPreview, s.handleSettlementPreview},
		{http.MethodPost, "/v1/settlements", auth.ActionSettlementsWrite, s.handleCreateSettlement},
		{http.MethodGet, "/v1/settlements/{id}", auth.ActionSettlementsRead, s.handleGetSettlement},
		{http.MethodPost, "/v1/settlements/{id}/void", auth.ActionSettlementsVoid, s.handleVoidSettlement},
		{http.MethodPost, "/v1/payments", auth.ActionLedgerPayment, s.handlePayment},
		{http.MethodPost, "/v1/advances", auth.ActionLedgerAdvance, s.handleAdvance},
		{http.MethodPost, "/v1/deductions", auth.ActionLedgerDeduction, s.handleDeduction},
		{http.MethodPost, "/v1/adjustments", auth.ActionLedgerAdjust, s.handleAdjustment},
		{http.MethodPost, "/v1/ledger/{id}/reverse", auth.ActionLedgerReverse, s.handleReverseLedger},

		// Synchronisation (docs/sincronizacion.md §3). Three routes and one
		// integer: the handset carries `cursor` and nothing else. Every role
		// reaches all three — the weigher's handset is the one that spends
		// days without signal — and what a weigher gets back is narrowed by
		// the same RLS policies that narrow everything else, not by a check
		// written here.
		{http.MethodPost, "/v1/sync/handshake", auth.ActionSyncHandshake, s.handleSyncHandshake},
		{http.MethodPost, "/v1/sync/push", auth.ActionSyncPush, s.handleSyncPush},
		{http.MethodGet, "/v1/sync/pull", auth.ActionSyncPull, s.handleSyncPull},

		// The season a farm already has on a handset (§8 phases 3–4). The
		// owner's alone, and Money: it writes a year of payroll in one act.
		{http.MethodPost, "/v1/import/season", auth.ActionImportSeason, s.handleImportSeason},

		// Productos e inventario (RSP-018 … RSP-025). The two pickers are
		// catalogues for the same reason every other picker here is one:
		// RSP-019 puts an "add it if it is not there" button beside both.
		{http.MethodGet, "/v1/catalogs/product-categories", auth.ActionProductsRead,
			s.handleListCatalog(store.CatalogProductCategories)},
		{http.MethodPost, "/v1/catalogs/product-categories", auth.ActionProductsWrite,
			s.handleCreateCatalogItem(store.CatalogProductCategories)},
		{http.MethodGet, "/v1/catalogs/storage-units", auth.ActionProductsRead,
			s.handleListCatalog(store.CatalogStorageUnits)},
		{http.MethodPost, "/v1/catalogs/storage-units", auth.ActionProductsWrite,
			s.handleCreateCatalogItem(store.CatalogStorageUnits)},

		// Bodegas. A place and a name; what is in one is derived from the
		// movements that name it, never stored on it.
		{http.MethodGet, "/v1/warehouses", auth.ActionProductsRead,
			s.handleListCatalog(store.CatalogWarehouses)},
		{http.MethodPost, "/v1/warehouses", auth.ActionProductsWrite,
			s.handleCreateCatalogItem(store.CatalogWarehouses)},

		{http.MethodGet, "/v1/products", auth.ActionProductsRead, s.handleListProducts},
		{http.MethodPost, "/v1/products", auth.ActionProductsWrite, s.handleCreateProduct},
		{http.MethodGet, "/v1/products/{id}", auth.ActionProductsRead, s.handleGetProduct},
		{http.MethodPatch, "/v1/products/{id}", auth.ActionProductsWrite, s.handleUpdateProduct},
		{http.MethodDelete, "/v1/products/{id}", auth.ActionProductsWrite, s.handleDeleteProduct},

		// Existencias: every one of these is a SUM over stock_moves computed
		// on the way out. There is no stored total anywhere behind them.
		{http.MethodGet, "/v1/stock", auth.ActionStockRead, s.handleListStock},
		{http.MethodGet, "/v1/products/{id}/stock", auth.ActionStockRead, s.handleProductStock},
		{http.MethodGet, "/v1/stock/moves", auth.ActionStockRead, s.handleListStockMoves},
		{http.MethodPost, "/v1/stock/moves", auth.ActionStockWrite, s.handleCreateStockMove},
		{http.MethodPost, "/v1/stock/moves/{id}/reverse", auth.ActionStockWrite, s.handleReverseStockMove},
		{http.MethodGet, "/v1/label-batches/{id}", auth.ActionStockRead, s.handleGetLabelBatch},

		// Ventas (RSP-026 … RSP-029). POST writes the sale and its outgoing
		// movement in one transaction; DELETE voids it and gives the stock
		// back, also in one.
		{http.MethodGet, "/v1/customers", auth.ActionSalesRead, s.handleListCustomers},
		{http.MethodPost, "/v1/customers", auth.ActionSalesWrite, s.handleCreateCustomer},
		{http.MethodGet, "/v1/sales", auth.ActionSalesRead, s.handleListSales},
		{http.MethodPost, "/v1/sales", auth.ActionSalesWrite, s.handleCreateSale},
		{http.MethodGet, "/v1/sales/{id}", auth.ActionSalesRead, s.handleGetSale},
		{http.MethodPatch, "/v1/sales/{id}", auth.ActionSalesWrite, s.handleUpdateSale},
		{http.MethodDelete, "/v1/sales/{id}", auth.ActionSalesVoid, s.handleVoidSale},

		// Gastos (RSP-030 … RSP-033). Nothing here reaches the ledger: an
		// expense is the farm's accounting, a debt is one person's balance,
		// and the document calling both of them "gasto" does not make them the
		// same thing. See handlers_expenses.go.
		{http.MethodGet, "/v1/expenses", auth.ActionExpensesRead, s.handleListExpenses},
		{http.MethodPost, "/v1/expenses", auth.ActionExpensesWrite, s.handleCreateExpense},
		{http.MethodGet, "/v1/expenses/{id}", auth.ActionExpensesRead, s.handleGetExpense},
		{http.MethodPatch, "/v1/expenses/{id}", auth.ActionExpensesWrite, s.handleUpdateExpense},
		{http.MethodDelete, "/v1/expenses/{id}", auth.ActionExpensesWrite, s.handleDeleteExpense},

		// Uploads. Two steps in the shape a presigned URL takes, because that
		// is what this becomes the day there is a bucket. The 5 MB is checked
		// on the bytes that arrive, not on the number the client declared.
		{http.MethodPost, "/v1/uploads", auth.ActionUploadsWrite, s.handleCreateUpload},
		{http.MethodPut, "/v1/uploads/{id}/content", auth.ActionUploadsWrite, s.handlePutUploadContent},
		{http.MethodGet, "/v1/uploads/{id}", auth.ActionUploadsRead, s.handleGetUpload},
		{http.MethodGet, "/v1/uploads/{id}/content", auth.ActionUploadsRead, s.handleGetUploadContent},

		// Reports. The console could administer a farm and had no way to say
		// how the harvest was going: every one of these is a port of analysis
		// that already ran on the phone and nowhere else. All six are
		// administrator-only and Money — see the note on ActionReportsRead.
		{http.MethodGet, "/v1/reports/weeks", auth.ActionReportsRead, s.handleReportWeeks},
		{http.MethodGet, "/v1/reports/weeks/{monday}", auth.ActionReportsRead, s.handleReportWeek},
		{http.MethodGet, "/v1/reports/crops/{plotCropId}", auth.ActionReportsRead, s.handleReportCrop},
		{http.MethodGet, "/v1/reports/performance", auth.ActionReportsRead, s.handleReportPerformance},
		{http.MethodGet, "/v1/reports/anomalies", auth.ActionReportsRead, s.handleReportAnomalies},
		{http.MethodGet, "/v1/reports/harvest-curve", auth.ActionReportsRead, s.handleReportHarvestCurve},
	}
}
