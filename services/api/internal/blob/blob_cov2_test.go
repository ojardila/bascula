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
	c2otFarm = "11111111-2222-3333-4444-555555555555"
	c2otAtt  = "66666666-7777-8888-9999-000000000000"
)

func c2otDisk(t *testing.T) *Disk {
	t.Helper()
	d, err := NewDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// A key whose file position is taken by a directory cannot be written, and
// the failure is the filesystem's, returned as is.
func TestPutFailsWhenTheObjectPathIsADirectory(t *testing.T) {
	d := c2otDisk(t)
	if err := os.MkdirAll(filepath.Join(d.Root, c2otFarm, c2otAtt), 0o750); err != nil {
		t.Fatal(err)
	}
	_, err := d.Put(context.Background(), Key(c2otFarm, c2otAtt), strings.NewReader("x"), 10)
	if err == nil || errors.Is(err, ErrTooLarge) {
		t.Fatalf("Put over a directory: %v, want a filesystem error", err)
	}
	if info, err := os.Stat(filepath.Join(d.Root, c2otFarm, c2otAtt)); err != nil || !info.IsDir() {
		t.Fatalf("the directory must be left alone: %v", err)
	}
}

// When the farm directory cannot be created (a file sits where it should be),
// Put fails before opening anything.
func TestPutFailsWhenTheFarmDirectoryCannotBeMade(t *testing.T) {
	d := c2otDisk(t)
	if err := os.WriteFile(filepath.Join(d.Root, c2otFarm), []byte("not a dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Put(context.Background(), Key(c2otFarm, c2otAtt), strings.NewReader("x"), 10); err == nil {
		t.Fatal("Put under a file must fail")
	}
}

// An open that fails for a reason other than "not there" is not ErrNotFound:
// a farm "directory" that is a file is a broken store, not a missing object.
func TestOpenReportsErrorsOtherThanNotFound(t *testing.T) {
	d := c2otDisk(t)
	if err := os.WriteFile(filepath.Join(d.Root, c2otFarm), []byte("not a dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	rc, n, err := d.Open(context.Background(), Key(c2otFarm, c2otAtt))
	if err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("Open = %v, %d, %v; want a non-NotFound error", rc, n, err)
	}
}

// Delete forgives what is already gone, and nothing else.
func TestDeleteReportsErrorsOtherThanNotFound(t *testing.T) {
	d := c2otDisk(t)
	full := filepath.Join(d.Root, c2otFarm, c2otAtt)
	if err := os.MkdirAll(full, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(full, "inside"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.Delete(context.Background(), Key(c2otFarm, c2otAtt)); err == nil {
		t.Fatal("deleting a non-empty directory must fail")
	}
	if err := d.Delete(context.Background(), Key(c2otFarm, "aaaaaaaa")); err != nil {
		t.Fatalf("deleting what is not there: %v", err)
	}
}

// The head is bounded at 512 bytes however the stream arrives.
func TestHeadBufferKeepsOnlyTheFirst512Bytes(t *testing.T) {
	h := &headBuffer{}
	for i := 0; i < 3; i++ {
		n, err := h.Write([]byte(strings.Repeat("a", 300)))
		if err != nil || n != 300 {
			t.Fatalf("Write = %d, %v", n, err)
		}
	}
	if len(h.b) != 512 {
		t.Fatalf("head = %d bytes, want 512", len(h.b))
	}
}

// A write that cannot be made durable is not a stored object. The object
// position here is a symlink to /dev/null, which accepts bytes and refuses
// fsync on Linux (EINVAL) and macOS (ENOTSUP) alike; Put must fail and clean
// up the link it wrote through, without touching what it pointed at.
func TestPutFailsWhenTheWriteCannotBeSynced(t *testing.T) {
	d := c2otDisk(t)
	link := filepath.Join(d.Root, c2otFarm, c2otAtt)
	if err := os.MkdirAll(filepath.Dir(link), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(os.DevNull, link); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	_, err := d.Put(context.Background(), Key(c2otFarm, c2otAtt), strings.NewReader("photo"), 10)
	if err == nil {
		t.Fatal("Put through an unsyncable file must fail")
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("the object position must be cleaned up: %v", err)
	}
	if _, err := os.Stat(os.DevNull); err != nil {
		t.Fatalf("%s must survive: %v", os.DevNull, err)
	}
}
