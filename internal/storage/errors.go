package storage

import (
	"errors"
	"fmt"
)

// ErrNotFound indicates a credential, client, or other entity id was missing.
// Callers should use errors.Is(err, storage.ErrNotFound).
var ErrNotFound = errors.New("not found")

func errNotFound(kind, id string) error {
	return fmt.Errorf("storage: %s %q %w", kind, id, ErrNotFound)
}
