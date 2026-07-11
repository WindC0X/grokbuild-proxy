package admin

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/GreyGunG/grokbuild-proxy/internal/storage"
)

// credentialListQuery is the Admin GET /admin/credentials query surface.
type credentialListQuery struct {
	Q      string
	Health string
	Sort   string
	Offset int
	Limit  int
	Now    time.Time
}

func parseCredentialListQuery(values map[string][]string, now time.Time) credentialListQuery {
	get := func(key string) string {
		if values == nil {
			return ""
		}
		vs := values[key]
		if len(vs) == 0 {
			return ""
		}
		return strings.TrimSpace(vs[0])
	}
	q := credentialListQuery{
		Q:      strings.ToLower(get("q")),
		Health: strings.ToLower(get("health")),
		Sort:   strings.ToLower(get("sort")),
		Now:    now.UTC(),
		Limit:  50,
		Offset: 0,
	}
	if q.Health == "" {
		q.Health = "all"
	}
	if q.Sort == "" {
		q.Sort = "priority_desc"
	}
	if q.Now.IsZero() {
		q.Now = time.Now().UTC()
	}
	if n, err := strconv.Atoi(get("limit")); err == nil {
		q.Limit = n
	}
	if q.Limit < 1 {
		q.Limit = 1
	}
	if q.Limit > 200 {
		q.Limit = 200
	}
	if n, err := strconv.Atoi(get("offset")); err == nil {
		q.Offset = n
	}
	if page, err := strconv.Atoi(get("page")); err == nil && page > 0 {
		q.Offset = (page - 1) * q.Limit
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	return q
}

// runtimeHealthKey mirrors the Admin SPA health taxonomy for server-side filter.
func runtimeHealthKey(c storage.Credential, now time.Time) string {
	if c.LifecycleState == storage.CredentialStateQuarantined {
		return "quarantined"
	}
	if !c.Enabled {
		return "disabled"
	}
	if c.CooldownUntil != nil && c.CooldownUntil.After(now) {
		return "cooling"
	}
	expired := !c.ExpiresAt.IsZero() && !c.ExpiresAt.After(now)
	hasRefresh := strings.TrimSpace(c.RefreshToken) != ""
	if expired && !hasRefresh {
		return "expired"
	}
	if expired && hasRefresh {
		return "expired"
	}
	err := strings.ToLower(c.LastError)
	insp := strings.ToLower(strings.TrimSpace(c.LastInspectionStatus))
	if insp == "unauthorized" || strings.Contains(err, "401") || strings.Contains(err, "unauthorized") {
		return "auth_failed"
	}
	if insp == "rate_limited" || strings.Contains(err, "429") {
		return "cooling"
	}
	if c.FailureCount > 0 && strings.TrimSpace(c.LastError) != "" {
		return "problem"
	}
	return "healthy"
}

func matchCredentialQuery(c storage.Credential, q credentialListQuery) bool {
	if q.Q != "" {
		hay := strings.ToLower(strings.Join([]string{c.Name, c.Email, c.ID}, " "))
		if !strings.Contains(hay, q.Q) {
			return false
		}
	}
	if q.Health == "" || q.Health == "all" {
		return true
	}
	key := runtimeHealthKey(c, q.Now)
	if q.Health == "problem" {
		return key != "healthy"
	}
	return key == q.Health
}

func sortCredentials(creds []storage.Credential, sortKey string) {
	sort.SliceStable(creds, func(i, j int) bool {
		a, b := creds[i], creds[j]
		switch sortKey {
		case "priority_asc":
			if a.Priority != b.Priority {
				return a.Priority < b.Priority
			}
		case "expires_asc":
			if !a.ExpiresAt.Equal(b.ExpiresAt) {
				return a.ExpiresAt.Before(b.ExpiresAt)
			}
		case "updated_desc":
			if !a.UpdatedAt.Equal(b.UpdatedAt) {
				return a.UpdatedAt.After(b.UpdatedAt)
			}
		case "name_asc":
			an := strings.ToLower(firstNonEmpty(a.Name, a.Email, a.ID))
			bn := strings.ToLower(firstNonEmpty(b.Name, b.Email, b.ID))
			if an != bn {
				return an < bn
			}
		case "priority_desc":
			fallthrough
		default:
			if a.Priority != b.Priority {
				return a.Priority > b.Priority
			}
		}
		return a.ID < b.ID
	})
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func pageCredentials(creds []storage.Credential, q credentialListQuery) (page []storage.Credential, total, offset, limit int) {
	filtered := make([]storage.Credential, 0, len(creds))
	for _, c := range creds {
		if matchCredentialQuery(c, q) {
			filtered = append(filtered, c)
		}
	}
	sortCredentials(filtered, q.Sort)
	total = len(filtered)
	offset = q.Offset
	if offset > total {
		offset = total
	}
	limit = q.Limit
	end := offset + limit
	if end > total {
		end = total
	}
	page = filtered[offset:end]
	return page, total, offset, limit
}
