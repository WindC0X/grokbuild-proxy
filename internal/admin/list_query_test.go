package admin

import (
	"testing"
	"time"

	"github.com/GreyGunG/grokbuild-proxy/internal/storage"
)

func TestParseCredentialListQueryPaging(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	q := parseCredentialListQuery(map[string][]string{
		"q":      {"Alice"},
		"health": {"problem"},
		"sort":   {"name_asc"},
		"page":   {"3"},
		"limit":  {"25"},
	}, now)
	if q.Q != "alice" || q.Health != "problem" || q.Sort != "name_asc" {
		t.Fatalf("query fields: %+v", q)
	}
	if q.Limit != 25 || q.Offset != 50 {
		t.Fatalf("paging limit=%d offset=%d", q.Limit, q.Offset)
	}
	// Cap limit at 200
	q = parseCredentialListQuery(map[string][]string{"limit": {"999"}}, now)
	if q.Limit != 200 {
		t.Fatalf("limit cap=%d", q.Limit)
	}
}

func TestPageCredentialsFiltersAndPages(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	cool := now.Add(time.Hour)
	creds := []storage.Credential{
		{ID: "a", Name: "alice", Email: "a@x.com", Enabled: true, Priority: 10, ExpiresAt: now.Add(2 * time.Hour)},
		{ID: "b", Name: "bob", Email: "b@x.com", Enabled: true, Priority: 5, CooldownUntil: &cool, LastError: "http 429", ExpiresAt: now.Add(2 * time.Hour)},
		{ID: "c", Name: "carol", Email: "c@x.com", Enabled: false, Priority: 1, ExpiresAt: now.Add(2 * time.Hour)},
		{ID: "d", Name: "dave", Email: "d@x.com", Enabled: true, Priority: 20, ExpiresAt: now.Add(2 * time.Hour)},
	}
	q := credentialListQuery{Health: "problem", Sort: "priority_desc", Offset: 0, Limit: 10, Now: now}
	page, total, offset, limit := pageCredentials(creds, q)
	if total != 2 { // bob cooling, carol disabled
		t.Fatalf("total=%d want 2 page=%+v", total, idsOf(page))
	}
	if offset != 0 || limit != 10 || len(page) != 2 {
		t.Fatalf("page len=%d offset=%d limit=%d", len(page), offset, limit)
	}

	q.Q = "ali"
	q.Health = "all"
	page, total, _, _ = pageCredentials(creds, q)
	if total != 1 || page[0].ID != "a" {
		t.Fatalf("q=ali total=%d page=%+v", total, idsOf(page))
	}

	// Server paging slice
	q = credentialListQuery{Health: "all", Sort: "priority_desc", Offset: 1, Limit: 2, Now: now}
	page, total, offset, limit = pageCredentials(creds, q)
	if total != 4 || offset != 1 || limit != 2 || len(page) != 2 {
		t.Fatalf("paged total=%d off=%d lim=%d n=%d ids=%v", total, offset, limit, len(page), idsOf(page))
	}
	// priority_desc: d(20), a(10), b(5), c(1) → offset 1 limit 2 => a, b
	if page[0].ID != "a" || page[1].ID != "b" {
		t.Fatalf("unexpected page order %v", idsOf(page))
	}
}

func TestRuntimeHealthKeyTaxonomy(t *testing.T) {
	now := time.Now().UTC()
	cool := now.Add(time.Minute)
	cases := []struct {
		name string
		c    storage.Credential
		want string
	}{
		{"healthy", storage.Credential{Enabled: true, ExpiresAt: now.Add(time.Hour)}, "healthy"},
		{"disabled", storage.Credential{Enabled: false}, "disabled"},
		{"quarantined", storage.Credential{Enabled: true, LifecycleState: storage.CredentialStateQuarantined}, "quarantined"},
		{"cooling", storage.Credential{Enabled: true, CooldownUntil: &cool, ExpiresAt: now.Add(time.Hour)}, "cooling"},
		{"auth", storage.Credential{Enabled: true, ExpiresAt: now.Add(time.Hour), LastInspectionStatus: "unauthorized"}, "auth_failed"},
	}
	for _, tc := range cases {
		if got := runtimeHealthKey(tc.c, now); got != tc.want {
			t.Fatalf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}

func idsOf(creds []storage.Credential) []string {
	out := make([]string, len(creds))
	for i, c := range creds {
		out[i] = c.ID
	}
	return out
}
