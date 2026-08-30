package domain

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// TestAllCodesListsEveryDeclaredCode closes the one gap in the chain that keeps
// openapi.yaml honest.
//
// There are two links. The contract test in internal/apitest compares
// AllCodes() against the ErrorCode enum in the spec, so a code in the list and
// not in the spec fails the build. But AllCodes() is a hand-written slice, and
// nothing compared it to the constants above it: declare CodeSomething, use it
// in a handler, forget the slice, and BOTH sides agree — the list does not have
// it, the spec does not have it, the test passes, and the code reaches a screen
// in English because no client ever heard of it.
//
// That is not hypothetical. It is exactly how SETTLEMENT_NOT_VOID,
// NOTHING_TO_RELEASE and REPLAY_REQUIRED were reported missing from the enum:
// the shape of the failure is real even when a particular instance of it has
// already been repaired.
//
// So this reads the declarations out of errors.go and demands that every one of
// them appear in AllCodes(). Together with the spec test, the chain is
// complete: a constant cannot exist without being in the list, and the list
// cannot differ from the contract.
//
// It parses the source rather than using reflection because a Go constant of a
// named string type leaves no runtime trace of having been declared. The AST is
// the only place the full set exists.
func TestAllCodesListsEveryDeclaredCode(t *testing.T) {
	declared := declaredCodes(t)
	if len(declared) < 30 {
		t.Fatalf("only %d Code constants were found in errors.go; this test has "+
			"stopped reading the file it is supposed to be guarding", len(declared))
	}

	listed := map[string]bool{}
	for _, c := range AllCodes() {
		if listed[string(c)] {
			t.Errorf("AllCodes() lists %q twice", c)
		}
		listed[string(c)] = true
	}

	for name, value := range declared {
		if !listed[value] {
			t.Errorf("domain.%s = %q is declared but missing from AllCodes().\n"+
				"AllCodes() is what openapi.yaml's ErrorCode enum is compared "+
				"against, so a code that is not in it is a code no client can "+
				"branch on — it reaches the screen in English.", name, value)
		}
	}

	values := map[string]string{}
	for name, value := range declared {
		if prev, dup := values[value]; dup {
			t.Errorf("domain.%s and domain.%s are both %q", prev, name, value)
		}
		values[value] = name
	}

	for value := range listed {
		if _, ok := values[value]; !ok {
			t.Errorf("AllCodes() lists %q, which no constant in errors.go declares.\n"+
				"Either declare it or drop it: the spec's enum is generated from "+
				"this list and every client keeps a branch for it.", value)
		}
	}
}

// declaredCodes returns every `Name Code = "VALUE"` constant in errors.go, by
// name.
func declaredCodes(t *testing.T) map[string]string {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "errors.go", nil, 0)
	if err != nil {
		t.Fatalf("parse errors.go: %v", err)
	}

	out := map[string]string{}
	// A const block carries its type on the first spec of each run, so the
	// declared type has to be remembered across specs that omit it — which is
	// how every constant after the first in a group is written.
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		typeName := ""
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			if ident, ok := vs.Type.(*ast.Ident); ok {
				typeName = ident.Name
			} else if vs.Type != nil {
				typeName = ""
			}
			if typeName != "Code" {
				continue
			}
			for i, name := range vs.Names {
				if i >= len(vs.Values) {
					continue
				}
				lit, ok := vs.Values[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					t.Errorf("%s is a Code constant whose value is not a string "+
						"literal; this test cannot see what it is", name.Name)
					continue
				}
				out[name.Name] = strings.Trim(lit.Value, `"`)
			}
		}
	}
	return out
}
