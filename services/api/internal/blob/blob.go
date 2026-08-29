// Package blob is where the bytes of an uploaded file go, and the only place
// in this service that touches a filesystem.
//
// It exists as an interface with one implementation, which is usually a smell
// and here is the point: the design document says object storage (S3/R2) and
// there is none in this environment, so the choice was between blocking the
// sale receipt on a bucket nobody has provisioned and writing the seam now.
// Disk is the implementation that ships; a presigned-URL implementation is a
// second file and no change anywhere else, because nothing above this package
// knows where an object_key resolves to.
//
// What the seam deliberately does NOT abstract is the size limit. Put takes a
// limit and counts what it actually wrote, and every implementation must do
// the same, because the limit that matters is the one applied to the bytes
// that arrived — not to the number the client put in the request that asked
// where to send them.
package blob

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ErrTooLarge is returned when the stream exceeds the limit. The partial write
// is cleaned up before it comes back.
var ErrTooLarge = errors.New("blob: object exceeds the size limit")

// ErrNotFound is returned when a key resolves to nothing.
var ErrNotFound = errors.New("blob: object not found")

// Result is what the server measured, which is the only measurement anyone is
// allowed to trust.
type Result struct {
	Bytes  int64
	SHA256 []byte
	// Head is the first bytes of the object, so the caller can sniff the media
	// type from the content instead of believing the Content-Type header.
	Head []byte
}

// Store is the seam. Keys are opaque to callers and are produced by Key.
type Store interface {
	// Put streams r into key, refusing at limit bytes. It returns what it
	// actually wrote. A Put that fails leaves nothing behind.
	Put(ctx context.Context, key string, r io.Reader, limit int64) (Result, error)
	// Open returns the object for reading, and its size.
	Open(ctx context.Context, key string) (io.ReadCloser, int64, error)
	// Delete removes an object. Removing what is not there is not an error:
	// the caller is cleaning up, and a cleanup that fails because the mess is
	// already gone helps nobody.
	Delete(ctx context.Context, key string) error
}

// Key builds the object key for an attachment. The farm is in the path so an
// operator looking at the directory can see whose bytes they are, and both
// halves are UUIDs, which is what makes the sanitising in safePath trivially
// true rather than hopeful.
func Key(farmID, attachmentID string) string {
	return farmID + "/" + attachmentID
}

// Disk stores objects as files under Root. It is the implementation this
// environment gets: there is no object storage here, and the alternative was
// to ship no receipt photo at all.
//
// It is honest about what it is not. There is no replication, a rollback of
// the request transaction does not remove the file it wrote, and two API
// processes need a shared volume. All three are properties of the environment,
// not of the interface, and swapping in S3 fixes all three without touching a
// handler.
type Disk struct{ Root string }

// NewDisk creates the root directory if it is missing.
func NewDisk(root string) (*Disk, error) {
	if root == "" {
		root = filepath.Join(os.TempDir(), "bascula-uploads")
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("blob: create %s: %w", root, err)
	}
	return &Disk{Root: root}, nil
}

// safePath refuses anything that is not the shape Key produces. A key never
// comes from a client — it is read back from the attachments row — but a
// filesystem path assembled from a database column is exactly the sort of
// thing that becomes interesting later, so it is checked here once.
func (d *Disk) safePath(key string) (string, error) {
	parts := strings.Split(key, "/")
	if len(parts) != 2 {
		return "", fmt.Errorf("blob: malformed key %q", key)
	}
	for _, p := range parts {
		if p == "" || len(p) > 64 || strings.ContainsAny(p, `/\.`) {
			return "", fmt.Errorf("blob: malformed key %q", key)
		}
	}
	return filepath.Join(d.Root, parts[0], parts[1]), nil
}

func (d *Disk) Put(ctx context.Context, key string, r io.Reader, limit int64) (Result, error) {
	path, err := d.safePath(key)
	if err != nil {
		return Result{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return Result{}, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o640)
	if err != nil {
		return Result{}, err
	}
	cleanup := func() { _ = f.Close(); _ = os.Remove(path) }

	// limit+1: reading one byte past the limit is how you tell "exactly at the
	// limit" from "over it". Copying limit bytes and calling it a day would
	// accept a 6 MB file truncated to 5 MB, which is a corrupt photo stored
	// without a single error anywhere.
	sum := sha256.New()
	head := &headBuffer{}
	written, err := io.Copy(io.MultiWriter(f, sum, head), io.LimitReader(r, limit+1))
	if err != nil {
		cleanup()
		return Result{}, err
	}
	if written > limit {
		cleanup()
		return Result{}, ErrTooLarge
	}
	if written == 0 {
		cleanup()
		return Result{}, errors.New("blob: empty object")
	}
	if err := f.Sync(); err != nil {
		cleanup()
		return Result{}, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return Result{}, err
	}
	return Result{Bytes: written, SHA256: sum.Sum(nil), Head: head.b}, nil
}

func (d *Disk) Open(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	path, err := d.safePath(key)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, err
	}
	return f, info.Size(), nil
}

func (d *Disk) Delete(ctx context.Context, key string) error {
	path, err := d.safePath(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// headBuffer keeps the first 512 bytes of a stream, which is what
// http.DetectContentType reads.
type headBuffer struct{ b []byte }

func (h *headBuffer) Write(p []byte) (int, error) {
	if n := 512 - len(h.b); n > 0 {
		if n > len(p) {
			n = len(p)
		}
		h.b = append(h.b, p[:n]...)
	}
	return len(p), nil
}
