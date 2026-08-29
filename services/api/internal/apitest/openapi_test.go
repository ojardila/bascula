package apitest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The tests in this file are the reason openapi.yaml is worth having.
//
// A contract written by hand and checked by nobody rots in a fortnight, and a
// rotten contract is worse than no contract at all: the web generates its types
// from it and then trusts them, so a stale field becomes a screen that renders
// undefined and a stale permission becomes a button that 403s in front of a
// customer. Today the web has its types hand-written precisely because this
// file did not exist.
//
// So the spec is not allowed to describe a server that does not exist, and the
// server is not allowed to expose a route the spec has not heard of. Four
// things are compared, all of them mechanical:
//
//	1. the set of (method, path), in both directions;
//	2. x-action, against the action the route declares;
//	3. x-roles, against auth.Matrix — the same table the middleware consults;
//	4. the ErrorCode enum, against domain.AllCodes().
//
// Plus a handful of hygiene rules that a generator needs: an operationId on
// every operation, path parameters that match the placeholders in the path, a
// success response, and the documented failures for anything behind a token.

// specDoc is the slice of OpenAPI these tests read. Everything else in the file
// is ignored on purpose: this is a consistency check against the router, not a
// validator, and pulling in a full OpenAPI implementation to compare sixty-odd
// strings would be a dependency nobody needs.
type specDoc struct {
	Paths      map[string]specPath `yaml:"paths"`
	Components struct {
		Schemas map[string]struct {
			Enum []string `yaml:"enum"`
		} `yaml:"schemas"`
	} `yaml:"components"`
}

type specPath struct {
	Parameters []specParam          `yaml:"parameters"`
	Operations map[string]*specOp   `yaml:"-"`
	Raw        map[string]yaml.Node `yaml:",inline"`
}

type specParam struct {
	Name string `yaml:"name"`
	In   string `yaml:"in"`
	Ref  string `yaml:"$ref"`
}

type specOp struct {
	OperationID string               `yaml:"operationId"`
	Summary     string               `yaml:"summary"`
	Action      string               `yaml:"x-action"`
	Roles       []string             `yaml:"x-roles"`
	Parameters  []specParam          `yaml:"parameters"`
	Responses   map[string]yaml.Node `yaml:"responses"`
}

var httpMethods = []string{"get", "put", "post", "delete", "patch", "options", "head", "trace"}

// componentParams maps the reusable parameter names to what they actually are,
// so a $ref in a path item can still be checked. Kept deliberately tiny: only
// path parameters matter to these assertions, and there is one.
var componentParams = map[string]specParam{
	"PathID": {Name: "id", In: "path"},
}

func loadSpec(t *testing.T) *specDoc {
	t.Helper()
	path := specPath_()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v\nThe contract is part of the service, not an "+
			"optional artefact: without it the web has no types to generate.", path, err)
	}
	var doc specDoc
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(doc.Paths) == 0 {
		t.Fatalf("%s declares no paths", path)
	}

	// Decode the operations out of the inline remainder of each path item.
	for p, item := range doc.Paths {
		item.Operations = map[string]*specOp{}
		for key, node := range item.Raw {
			if !isHTTPMethod(key) {
				continue
			}
			var op specOp
			if err := node.Decode(&op); err != nil {
				t.Fatalf("parse %s %s: %v", strings.ToUpper(key), p, err)
			}
			item.Operations[strings.ToUpper(key)] = &op
		}
		doc.Paths[p] = item
	}
	return &doc
}

func specPath_() string {
	// The tests run from internal/apitest; the contract lives at the service
	// root next to go.mod.
	return filepath.Join("..", "..", "openapi.yaml")
}

func isHTTPMethod(s string) bool {
	for _, m := range httpMethods {
		if s == m {
			return true
		}
	}
	return false
}

// specOperations flattens the document into the same shape walkMountedRoutes
// produces, so the two can be compared directly.
func specOperations(doc *specDoc) map[routeKey]*specOp {
	out := map[routeKey]*specOp{}
	for path, item := range doc.Paths {
		for method, op := range item.Operations {
			out[routeKey{method, path}] = op
		}
	}
	return out
}

// TestSpecAndRouterAgreeOnWhatExists is the headline: the spec cannot describe
// a route that is not mounted, and no route may be mounted that the spec has
// not heard of.
//
// It compares against the built mux and not against httpapi.Routes(), for the
// same reason the permission-table test does: a handler mounted by some other
// path would be invisible to a check that only read the table.
func TestSpecAndRouterAgreeOnWhatExists(t *testing.T) {
	h := requireDB(t)
	doc := loadSpec(t)

	mounted := walkMountedRoutes(t, h.server.Router())
	documented := specOperations(doc)

	for key := range mounted {
		if _, ok := documented[key]; !ok {
			t.Errorf("%s is mounted on the router but is absent from openapi.yaml.\n"+
				"Add it. An undocumented route is one the web cannot generate a "+
				"client for, which is how hand-written types get written a second time.", key)
		}
	}
	for key := range documented {
		if _, ok := mounted[key]; !ok {
			t.Errorf("openapi.yaml documents %s, which is not mounted.\n"+
				"Either mount it or delete it from the spec. A contract that "+
				"promises a route the server does not serve is worse than a "+
				"missing one: the client writes code against it.", key)
		}
	}
}

// TestSpecDeclaresTheSameActionAndRolesAsThePermissionTable stops the contract
// lying about who may call what.
//
// x-roles is not a comment. It is compared against auth.Matrix, the very table
// the middleware consults, so a rule loosened in Go without being written down
// — or written down without being loosened — fails here rather than in front of
// a customer.
func TestSpecDeclaresTheSameActionAndRolesAsThePermissionTable(t *testing.T) {
	h := requireDB(t)
	doc := loadSpec(t)
	documented := specOperations(doc)

	declared := map[routeKey]auth.Action{}
	for _, rt := range h.server.Routes() {
		declared[routeKey{rt.Method, rt.Pattern}] = rt.Action
	}

	for key, op := range documented {
		action, mounted := declared[key]
		if !mounted {
			continue // already reported by the test above
		}
		if op.Action != string(action) {
			t.Errorf("%s: openapi.yaml says x-action %q, the router says %q.\n"+
				"The action is what decides the permissions, so documenting a "+
				"route under somebody else's action documents the wrong rules.",
				key, op.Action, action)
			continue
		}

		want := rolesFor(action)
		if !equalStrings(op.Roles, want) {
			t.Errorf("%s (%s): openapi.yaml says x-roles %v, auth.Matrix says %v.\n"+
				"One of the two is wrong and the middleware obeys auth.Matrix.",
				key, action, op.Roles, want)
		}
	}
}

// rolesFor renders one row of the permission table the way the spec spells it:
// "public" for an action that needs no token, "superadmin" for one no farm role
// can reach, and otherwise the farm roles that may perform it, in seniority
// order rather than alphabetical — owner, admin, weigher reads as a hierarchy,
// admin, owner, weigher reads as a list.
func rolesFor(a auth.Action) []string {
	rule := auth.Matrix[a]
	switch {
	case rule.Public:
		return []string{"public"}
	case rule.Superadmin:
		return []string{"superadmin"}
	}
	out := []string{}
	for _, r := range []domain.Role{domain.RoleOwner, domain.RoleAdmin, domain.RoleWeigher} {
		if auth.Allowed(r, a) {
			out = append(out, string(r))
		}
	}
	return out
}

// TestSpecPathParametersMatchTheRoutePatterns catches the mismatch a generator
// turns into a compile error three repositories away: a documented {cropId}
// that the router calls {crop_id}, or a path parameter nobody declared.
func TestSpecPathParametersMatchTheRoutePatterns(t *testing.T) {
	doc := loadSpec(t)

	for path, item := range doc.Paths {
		placeholders := pathPlaceholders(path)
		for method, op := range item.Operations {
			declaredNames := map[string]bool{}
			for _, p := range append(append([]specParam{}, item.Parameters...), op.Parameters...) {
				p = resolveParam(p)
				if p.In == "path" {
					declaredNames[p.Name] = true
				}
			}
			for _, name := range placeholders {
				if !declaredNames[name] {
					t.Errorf("%s %s: the path has {%s} but no parameter declares it.",
						method, path, name)
				}
			}
			for name := range declaredNames {
				if !contains(placeholders, name) {
					t.Errorf("%s %s: a path parameter %q is declared but the path has no {%s}.",
						method, path, name, name)
				}
			}
		}
	}
}

// resolveParam follows the one kind of $ref these paths use.
func resolveParam(p specParam) specParam {
	if p.Ref == "" {
		return p
	}
	name := p.Ref[strings.LastIndex(p.Ref, "/")+1:]
	if resolved, ok := componentParams[name]; ok {
		return resolved
	}
	// A $ref this test cannot resolve is a query parameter it does not need to
	// check; path parameters are all in componentParams or written inline.
	return specParam{Name: name, In: "unresolved"}
}

// TestSpecIsUsableByAGenerator checks the properties a generated client needs
// and a human reader silently supplies: a name for every operation, a success
// to return, and the failures worth branching on.
func TestSpecIsUsableByAGenerator(t *testing.T) {
	h := requireDB(t)
	doc := loadSpec(t)
	documented := specOperations(doc)

	declared := map[routeKey]auth.Action{}
	for _, rt := range h.server.Routes() {
		declared[routeKey{rt.Method, rt.Pattern}] = rt.Action
	}

	seenIDs := map[string]routeKey{}
	for key, op := range documented {
		if op.OperationID == "" {
			t.Errorf("%s has no operationId; a generated client would name the "+
				"method after the path, which changes when the path does", key)
		} else if prev, dup := seenIDs[op.OperationID]; dup {
			t.Errorf("%s and %s share operationId %q", key, prev, op.OperationID)
		} else {
			seenIDs[op.OperationID] = key
		}
		if op.Summary == "" {
			t.Errorf("%s has no summary", key)
		}

		if !hasSuccessResponse(op) {
			t.Errorf("%s documents no 2xx response", key)
		}

		action, mounted := declared[key]
		if !mounted {
			continue
		}
		rule := auth.Matrix[action]
		if !rule.Public {
			for _, code := range []string{"401", "403"} {
				if _, ok := op.Responses[code]; !ok {
					t.Errorf("%s is behind a token but documents no %s response.\n"+
						"Every authenticated route can produce both: the "+
						"middleware answers 401 with no token and 403 when the "+
						"permission table refuses.", key, code)
				}
			}
		}
		if len(pathPlaceholders(key.pattern)) > 0 {
			if _, ok := op.Responses["404"]; !ok {
				t.Errorf("%s addresses a resource by id but documents no 404.\n"+
					"A resource of another farm answers 404 here, and a client "+
					"that does not expect one will render it as a crash.", key)
			}
		}
	}
}

func hasSuccessResponse(op *specOp) bool {
	for code := range op.Responses {
		if strings.HasPrefix(code, "2") {
			return true
		}
	}
	return false
}

// TestSpecErrorCodesMatchTheDomain keeps the enum the client branches on from
// falling behind the server. A code the server can emit and the spec does not
// list is a branch nobody wrote; a code the spec lists and the server cannot
// emit is dead code in every client at once.
func TestSpecErrorCodesMatchTheDomain(t *testing.T) {
	doc := loadSpec(t)

	schema, ok := doc.Components.Schemas["ErrorCode"]
	if !ok {
		t.Fatal("openapi.yaml has no ErrorCode schema")
	}
	spec := map[string]bool{}
	for _, c := range schema.Enum {
		spec[c] = true
	}
	real := map[string]bool{}
	for _, c := range domain.AllCodes() {
		real[string(c)] = true
	}

	for c := range real {
		if !spec[c] {
			t.Errorf("domain.Code %q is missing from the ErrorCode enum in openapi.yaml.\n"+
				"The client branches on these; an undocumented code is a branch "+
				"nobody wrote.", c)
		}
	}
	for c := range spec {
		if !real[c] {
			t.Errorf("openapi.yaml lists error code %q, which no longer exists in domain.\n"+
				"Remove it, or every client keeps a branch that can never run.", c)
		}
	}
}

// TestEveryRouteInTheTableIsAlsoInTheSpec is the third direction, and it is not
// redundant with the first: the router walk and the route table are compared to
// each other by the permission-table test, and each is compared to the spec
// here and above. Any one of the three drifting fails something.
func TestEveryRouteInTheTableIsAlsoInTheSpec(t *testing.T) {
	h := requireDB(t)
	doc := loadSpec(t)
	documented := specOperations(doc)

	for _, rt := range h.server.Routes() {
		key := routeKey{rt.Method, rt.Pattern}
		if _, ok := documented[key]; !ok {
			t.Errorf("httpapi.Routes() declares %s, which openapi.yaml does not describe", key)
		}
	}
	if len(documented) != len(h.server.Routes()) {
		t.Errorf("openapi.yaml describes %d operations, the route table has %d",
			len(documented), len(h.server.Routes()))
	}
}

func pathPlaceholders(path string) []string {
	var out []string
	for {
		open := strings.Index(path, "{")
		if open < 0 {
			return out
		}
		closeAt := strings.Index(path[open:], "}")
		if closeAt < 0 {
			return out
		}
		out = append(out, path[open+1:open+closeAt])
		path = path[open+closeAt+1:]
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
