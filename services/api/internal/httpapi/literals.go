package httpapi

// Strings repeated across the package, named once (Sonar go:S1192, #158).

const (
	contentTypeJSON   = "application/json"
	headerContentType = "Content-Type"

	msgInvalidTimezone = "that is not a valid IANA timezone name"
	msgMalformedForm   = "malformed form"
	msgPasswordTooLong = "password is too long"

	// Description of the municipality argument on the MCP write tools.
	descMunicipality = "Municipio."

	// HTML attribute that pre-selects a radio or checkbox on the OAuth pages.
	htmlChecked = " checked"

	// Every farm lives in Kubernetes namespace bascula-{slug}.
	farmNamespacePrefix = "bascula-"

	msgWorkerIDRequired      = "workerId is required"
	msgPasskeysMisconfigured = "passkeys are misconfigured"

	// Routes the MCP write tools call on the farm API itself.
	pathWorkers          = "/v1/workers"
	pathWorkersSlash     = pathWorkers + "/"
	pathSettlements      = "/v1/settlements"
	pathSettlementsSlash = pathSettlements + "/"
	pathPriceWeeksSlash  = "/v1/prices/weeks/"
)
