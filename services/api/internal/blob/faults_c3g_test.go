// SPDX-License-Identifier: MIT

package blob

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	c3gFarm = "aaaaaaaa-2222-3333-4444-555555555555"
	c3gAtt  = "bbbbbbbb-7777-8888-9999-000000000000"
)

var errC3gDisk = errors.New("c3g: disk failure")

// A close that fails after every byte was written and synced is still a failed
// Put: the error comes back and no half-trusted file stays behind.
func TestPutReportsAFailedCloseAndLeavesNothing(t *testing.T) {
	d, err := NewDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := closeFile
	t.Cleanup(func() { closeFile = old })
	closeFile = func(f *os.File) error {
		_ = old(f)
		return errC3gDisk
	}

	res, err := d.Put(context.Background(), Key(c3gFarm, c3gAtt), strings.NewReader("foto"), 10)
	if !errors.Is(err, errC3gDisk) || res.Bytes != 0 {
		t.Fatalf("Put = %+v, %v; want the close failure", res, err)
	}
	if _, err := os.Stat(filepath.Join(d.Root, c3gFarm, c3gAtt)); !os.IsNotExist(err) {
		t.Fatalf("the file survived a failed Put: %v", err)
	}
}

// When the object opens but cannot be described, Open returns that failure
// and no reader: a size it cannot vouch for would cut a download short.
func TestOpenReportsAFailedStat(t *testing.T) {
	d, err := NewDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	key := Key(c3gFarm, c3gAtt)
	if _, err := d.Put(context.Background(), key, strings.NewReader("foto"), 10); err != nil {
		t.Fatal(err)
	}
	old := statFile
	t.Cleanup(func() { statFile = old })
	var opened *os.File
	statFile = func(f *os.File) (os.FileInfo, error) {
		opened = f
		return nil, errC3gDisk
	}

	rc, size, err := d.Open(context.Background(), key)
	if !errors.Is(err, errC3gDisk) || rc != nil || size != 0 {
		t.Fatalf("Open = %v, %d, %v; want the stat failure", rc, size, err)
	}
	if err := opened.Close(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("the file was left open: close again = %v", err)
	}
}
