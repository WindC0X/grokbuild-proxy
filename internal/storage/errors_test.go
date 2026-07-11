package storage

import (
	"errors"
	"fmt"
	"testing"
)

func TestErrNotFoundIs(t *testing.T) {
	err := errNotFound("client", "cli_1")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected errors.Is(%v, ErrNotFound)", err)
	}
	// Wrapped further still matches.
	if !errors.Is(fmt.Errorf("wrap: %w", err), ErrNotFound) {
		t.Fatal("wrapped ErrNotFound should match")
	}
	if errors.Is(fmt.Errorf("storage: other failure"), ErrNotFound) {
		t.Fatal("unrelated error must not match ErrNotFound")
	}
}
