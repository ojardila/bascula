package httpapi

// Strings repeated across the package, named once (Sonar go:S1192, #158).

const (
	contentTypeJSON = "application/json"

	msgWorkerIDRequired      = "workerId is required"
	msgPasskeysMisconfigured = "passkeys are misconfigured"

	// Routes the MCP write tools call on the farm API itself.
	pathWorkers          = "/v1/workers"
	pathWorkersSlash     = pathWorkers + "/"
	pathSettlements      = "/v1/settlements"
	pathSettlementsSlash = pathSettlements + "/"
	pathPriceWeeksSlash  = "/v1/prices/weeks/"
)
