// SPDX-License-Identifier: MIT

package blob

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const farm, att = "6f1c3a526a0e4c439b510d2f3f3c1e11", "0b7a6c1e2d3f4a5b6c7d8e9f0a1b2c3d"

func newDisk(t *testing.T) *Disk {
	t.Helper()
	d, err := NewDisk(filepath.Join(t.TempDir(), "uploads"))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestPutOpenDeleteRoundTrip(t *testing.T) {
	d := newDisk(t)
	ctx := context.Background()
	key := Key(farm, att)
	res, err := d.Put(ctx, key, strings.NewReader("una foto"), 100)
	if err != nil || res.Bytes != 8 || len(res.SHA256) != 32 || string(res.Head) != "una foto" {
		t.Fatalf("put: %+v %v", res, err)
	}
	rc, size, err := d.Open(ctx, key)
	if err != nil || size != 8 {
		t.Fatalf("open: %d %v", size, err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "una foto" {
		t.Fatalf("read back %q", got)
	}
	if err := d.Delete(ctx, key); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := d.Delete(ctx, key); err != nil {
		t.Fatalf("deleting what is gone is not an error: %v", err)
	}
	if _, _, err := d.Open(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("open after delete: %v", err)
	}
}

func TestPutRefusesAndLeavesNothing(t *testing.T) {
	d := newDisk(t)
	ctx := context.Background()
	key := Key(farm, att)
	if _, err := d.Put(ctx, key, bytes.NewReader(make([]byte, 11)), 10); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("over the limit: %v", err)
	}
	if _, err := d.Put(ctx, key, strings.NewReader(""), 10); err == nil {
		t.Fatal("an empty object was stored")
	}
	if _, err := d.Put(ctx, key, failingReader{}, 10); err == nil {
		t.Fatal("a failed read was stored")
	}
	if _, err := os.Stat(filepath.Join(d.Root, farm, att)); !os.IsNotExist(err) {
		t.Fatalf("a refused put left a file behind: %v", err)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

func TestMalformedKeysAreRefused(t *testing.T) {
	d := newDisk(t)
	ctx := context.Background()
	for _, key := range []string{"solo", "a/b/c", "/x", "../etc", farm + "/..", farm + "/" + strings.Repeat("a", 65), `a\b/c`} {
		if _, err := d.Put(ctx, key, strings.NewReader("x"), 10); err == nil {
			t.Errorf("put %q accepted", key)
		}
		if _, _, err := d.Open(ctx, key); err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("open %q: %v", key, err)
		}
		if err := d.Delete(ctx, key); err == nil {
			t.Errorf("delete %q accepted", key)
		}
	}
}

func TestNewDisk(t *testing.T) {
	d, err := NewDisk("")
	if err != nil || d.Root != filepath.Join(os.TempDir(), "bascula-uploads") {
		t.Fatalf("default root: %+v %v", d, err)
	}
	file := filepath.Join(t.TempDir(), "un-archivo")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewDisk(filepath.Join(file, "debajo")); err == nil {
		t.Fatal("a root under a file was accepted")
	}
	// A farm directory that is a file: the object cannot be created.
	d = newDisk(t)
	if err := os.WriteFile(filepath.Join(d.Root, farm), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Put(context.Background(), Key(farm, att), strings.NewReader("x"), 10); err == nil {
		t.Fatal("put under a file was accepted")
	}
}
