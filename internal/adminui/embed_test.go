package adminui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmbeddedStaticFilesPresent(t *testing.T) {
	for _, name := range []string{"index.html", "app.js", "app.css"} {
		b, err := ReadStatic(name)
		if err != nil {
			t.Fatalf("missing embed static/%s: %v", name, err)
		}
		if len(b) == 0 {
			t.Fatalf("static/%s is empty", name)
		}
	}
}

func TestBillingDiagnosticsPreserveMissingValues(t *testing.T) {
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)
	for _, marker := range []string{
		"var limit = optionalNum(m.monthlyLimit)",
		"var weekPct = optionalNum(w.creditUsagePercent)",
		`u.used != null ? fmtNum(u.used) : "未报告"`,
		`u.weekPct != null ? u.weekPct.toFixed(1) + "%" : "未报告"`,
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("app.js missing billing null-preservation marker %q", marker)
		}
	}
}

func TestCredentialDetailExposesInspectionResult(t *testing.T) {
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)
	for _, marker := range []string{
		"c.last_inspection_at",
		"c.last_inspection_status",
		"c.last_inspection_error",
		`lineMeta("最近巡检"`,
		`lineMeta("巡检结果"`,
		`lineMeta("巡检详情"`,
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("app.js missing credential inspection marker %q", marker)
		}
	}
}

func TestNoAutomaticBillingFanOutOnListRender(t *testing.T) {
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)

	// List rendering must not call fillCredentialUsage.
	if !strings.Contains(source, "function renderCredentialRow(c)") {
		t.Fatal("expected compact table row renderer")
	}
	rowStart := strings.Index(source, "function renderCredentialRow(c)")
	rowEnd := strings.Index(source[rowStart:], "function highlightSelectedRow")
	if rowEnd < 0 {
		t.Fatal("could not bound renderCredentialRow")
	}
	rowBody := source[rowStart : rowStart+rowEnd]
	if strings.Contains(rowBody, "fillCredentialUsage") {
		t.Fatal("credential list row must not auto-fetch billing (N+1)")
	}
	if strings.Contains(rowBody, "/billing") {
		t.Fatal("credential list row must not request /billing")
	}

	// On-demand helper remains available for detail view.
	if !strings.Contains(source, "function fillCredentialUsage(box, credId, force)") {
		t.Fatal("expected on-demand fillCredentialUsage")
	}
	if !strings.Contains(source, "BILLING_CONCURRENCY") {
		t.Fatal("expected billing concurrency limit")
	}
	if !strings.Contains(source, "enqueueBilling") {
		t.Fatal("expected queued billing loader")
	}
}

func TestAdminSessionUsesSessionStorage(t *testing.T) {
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)
	for _, marker := range []string{
		`SESSION_KEY = "grokbuild_admin_key"`,
		"sessionStorage.getItem(SESSION_KEY)",
		"sessionStorage.setItem(SESSION_KEY",
		"function loadSession()",
		"function saveSession(key)",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("app.js missing session marker %q", marker)
		}
	}
	if strings.Contains(source, "localStorage") {
		t.Fatal("admin key must not use long-lived localStorage")
	}
}

func TestRuntimeHealthDualStateModel(t *testing.T) {
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)
	for _, marker := range []string{
		"function runtimeHealth(c)",
		"function configState(c)",
		`label: "健康"`,
		`label: "冷却"`,
		`label: "隔离"`,
		`label: "已启用"`,
		`label: "已禁用"`,
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("app.js missing health model marker %q", marker)
		}
	}
}

func TestPageStateAndOverviewShell(t *testing.T) {
	index, err := ReadStatic("index.html")
	if err != nil {
		t.Fatal(err)
	}
	html := string(index)
	for _, marker := range []string{
		`id="page-overview"`,
		`id="page-credentials"`,
		`id="cred-loading"`,
		`id="cred-error"`,
		`id="cred-empty"`,
		`id="cred-table"`,
		`id="cred-search"`,
		`id="cred-filter-health"`,
		`id="crisis-banner"`,
		`id="drawer"`,
		`data-route="overview"`,
		`data-route="clients"`,
		`app.js?v=6`,
		`app.css?v=6`,
	} {
		if !strings.Contains(html, marker) {
			t.Fatalf("index.html missing shell marker %q", marker)
		}
	}
	// Integration is folded into clients page.
	if strings.Contains(html, `data-route="integration"`) {
		t.Fatal("integration should be merged into clients page")
	}
}

func TestCredentialListSupportsFilterPagination(t *testing.T) {
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)
	for _, marker := range []string{
		"PAGE_SIZE = 50",
		"function applyCredFiltersAndRender()",
		"function renderPager(pages)",
		`health === "problem"`,
		"function upsertCredentialLocal(c)",
		"function removeCredentialLocal(id)",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("app.js missing list ops marker %q", marker)
		}
	}
}

func TestCSSContainsOpsConsolePrimitives(t *testing.T) {
	css, err := ReadStatic("app.css")
	if err != nil {
		t.Fatal(err)
	}
	source := string(css)
	for _, marker := range []string{
		".data-table",
		".drawer-panel",
		".crisis-banner",
		".stat-grid",
		".status-dot-ok",
		".status-dot-danger",
		"prefers-reduced-motion",
		":focus-visible",
		/* Geist Dark tokens from design.dark.md */
		"--bg: #000000",
		"--text: #ededed",
		"--accent: #006efe",
		"--primary: #ededed",
		"--primary-fg: #000000",
		"Geist Dark",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("app.css missing primitive %q", marker)
		}
	}
}

func TestIndexHandlerServesHTMLWithoutAuth(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	rec := httptest.NewRecorder()
	IndexHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want 200", rec.Code)
	}
	ct := rec.Header().Get("Content-Type")
	if !strings.Contains(ct, "text/html") {
		t.Fatalf("Content-Type=%q want text/html", ct)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q want no-store", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing nosniff")
	}
	body := rec.Body.String()
	if !strings.Contains(body, "grokbuild 管理后台") && !strings.Contains(body, "grokbuild Admin") {
		t.Fatalf("body missing title marker")
	}
	if !strings.Contains(body, "/admin/ui/app.js") {
		t.Fatalf("body missing app.js reference")
	}
}

func TestIndexHandlerHEAD(t *testing.T) {
	req := httptest.NewRequest(http.MethodHead, "/admin/", nil)
	rec := httptest.NewRecorder()
	ServeIndex(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD should not write body, got %d bytes", rec.Body.Len())
	}
}

func TestAssetsHandlerServesJSAndCSS(t *testing.T) {
	h := http.StripPrefix("/admin/ui/", AssetsHandler())

	for _, path := range []string{"/admin/ui/app.js", "/admin/ui/app.css"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
		if rec.Body.Len() == 0 {
			t.Fatalf("%s empty body", path)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s missing nosniff", path)
		}
	}
}

func TestAssetsHandlerNotFound(t *testing.T) {
	h := http.StripPrefix("/admin/ui/", AssetsHandler())
	req := httptest.NewRequest(http.MethodGet, "/admin/ui/nope.js", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d want 404", rec.Code)
	}
}

func TestAssetsDoNotServeIndexAsCredentials(t *testing.T) {
	h := http.StripPrefix("/admin/ui/", AssetsHandler())
	req := httptest.NewRequest(http.MethodGet, "/admin/ui/credentials", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK {
		body, _ := io.ReadAll(rec.Body)
		if strings.Contains(string(body), "<!DOCTYPE html>") {
			t.Fatal("credentials path must not return SPA HTML")
		}
	}
}

func TestHandlerConvenienceMux(t *testing.T) {
	h := Handler()
	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
}
