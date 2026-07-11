package adminui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

func TestEmbeddedStaticFilesPresent(t *testing.T) {
	for _, name := range []string{"index.html", "app.js", "app.css", "theme-init.js"} {
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
	for _, banned := range []string{
		"fillCredentialUsage",
		"/billing",
		"enqueueBilling",
		"GetBilling",
	} {
		if strings.Contains(rowBody, banned) {
			t.Fatalf("credential list row must not contain %q (N+1 risk)", banned)
		}
	}

	// loadCredentials list path must not fan out billing either.
	loadStart := strings.Index(source, "function loadCredentials()")
	if loadStart < 0 {
		t.Fatal("missing loadCredentials")
	}
	loadEnd := strings.Index(source[loadStart:], "function applyCredFiltersAndRender")
	if loadEnd < 0 {
		t.Fatal("could not bound loadCredentials")
	}
	loadBody := source[loadStart : loadStart+loadEnd]
	if strings.Contains(loadBody, "/billing") || strings.Contains(loadBody, "fillCredentialUsage") {
		t.Fatal("loadCredentials must not request billing for each credential")
	}
	// List fetch goes through the server-paged collection helper (one request).
	if !strings.Contains(loadBody, "credentialsListURL()") {
		t.Fatal("loadCredentials should fetch via credentialsListURL (server paging)")
	}
	if !strings.Contains(source, "function credentialsListURL()") {
		t.Fatal("expected credentialsListURL helper")
	}
	if !strings.Contains(source, `"/admin/credentials?"`) && !strings.Contains(source, `"/admin/credentials?" +`) {
		// credentialsListURL builds "/admin/credentials?" + query
		if !strings.Contains(source, "/admin/credentials?") {
			t.Fatal("credentialsListURL should target /admin/credentials?…")
		}
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
	// Concurrency must stay small (not unbounded fan-out).
	if !strings.Contains(source, "BILLING_CONCURRENCY = 3") {
		t.Fatal("expected BILLING_CONCURRENCY = 3")
	}
}

func TestBatchOpsUseExistingDisableRefreshEndpoints(t *testing.T) {
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)
	// Batch bar wiring must call the same single-item APIs the UI already uses.
	for _, marker := range []string{
		`btn-batch-enable`,
		`btn-batch-disable`,
		`btn-batch-refresh`,
		`"/disable", {\n            enabled: true`,
		`"/disable", {\n            enabled: false`,
		`"/refresh"`,
		"function runBatch(actionLabel, worker)",
		"selectedIdList()",
	} {
		if !strings.Contains(source, marker) {
			// Allow compact single-line variants for disable payloads.
			altOK := false
			if strings.Contains(marker, "enabled: true") &&
				(strings.Contains(source, "enabled: true") && strings.Contains(source, "btn-batch-enable")) {
				altOK = true
			}
			if strings.Contains(marker, "enabled: false") &&
				(strings.Contains(source, "enabled: false") && strings.Contains(source, "btn-batch-disable")) {
				altOK = true
			}
			if strings.Contains(marker, `"/refresh"`) && strings.Contains(source, "/refresh") &&
				strings.Contains(source, "btn-batch-refresh") {
				altOK = true
			}
			if !altOK {
				t.Fatalf("app.js missing batch marker %q", marker)
			}
		}
	}
}

func TestAppJSParsesAsScript(t *testing.T) {
	// Syntax gate for the zero-build SPA (catches unbalanced braces etc.).
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	// node --check when available; otherwise do a cheap brace balance check.
	if path, lookErr := exec.LookPath("node"); lookErr == nil {
		cmd := exec.Command(path, "--check")
		cmd.Stdin = strings.NewReader(string(app))
		out, runErr := cmd.CombinedOutput()
		if runErr != nil {
			t.Fatalf("node --check app.js failed: %v\n%s", runErr, out)
		}
		return
	}
	balance := 0
	for _, r := range string(app) {
		switch r {
		case '{':
			balance++
		case '}':
			balance--
			if balance < 0 {
				t.Fatal("app.js has unmatched closing brace")
			}
		}
	}
	if balance != 0 {
		t.Fatalf("app.js brace balance=%d", balance)
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
	// Theme/density may use localStorage; admin key must stay on sessionStorage only.
	if strings.Contains(source, "localStorage.setItem(SESSION_KEY") ||
		strings.Contains(source, "localStorage.getItem(SESSION_KEY") ||
		strings.Contains(source, `localStorage.setItem("grokbuild_admin_key"`) ||
		strings.Contains(source, `localStorage.getItem("grokbuild_admin_key"`) {
		t.Fatal("admin key must not use long-lived localStorage")
	}
	if !strings.Contains(source, `localStorage.setItem("gb_theme"`) {
		t.Fatal("theme preference should use localStorage (not sessionStorage)")
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
		`app.js?v=13`,
		`app.css?v=13`,
		`theme-init.js?v=13`,
		`stroke="currentColor"`,
		`animate-ui.com/docs/icons`,
		`id="cred-batch-bar"`,
		`id="cred-select-all"`,
		`id="overview-activity"`,
		`id="btn-page-quota"`,
		`id="theme-seg"`,
		`id="density-seg"`,
		`id="sidebar"`,
		`class="shell-layout"`,
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
		"function renderCredentialPage()",
		"function credentialsListURL()",
		"function renderPager(pages)",
		"credTotal",
		"服务端分页",
		"function upsertCredentialLocal(c)",
		"function removeCredentialLocal(id)",
		"function runBatch(actionLabel, worker)",
		"function markSettingsDirty()",
		`/admin/clients/" + encodeURIComponent(c.id) + "/disable"`,
		"function syncCredHash()",
		"function applyCredQueryFromHash()",
		"function installFocusTrap(container)",
		"settings-tabs",
		"beforeunload",
		"function recordActivity(entry)",
		"function paintActivity()",
		"function loadVisiblePageQuota()",
		"ACTIVITY_MAX = 20",
		"activityLog",
		"function applyTheme(pref)",
		"function applyDensity(pref)",
		"gb_theme",
		"gb_density",
		"function setSidebarOpen(open)",
		"function sectionHead(title, hint)",
		"overview-grid",
		"drawer-hero",
		"function paintQuotaCell(cell, credId)",
		"settings-save-bar",
		"system-layout",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("app.js missing list ops marker %q", marker)
		}
	}
}

func TestBillingQueueConcurrencyKeepsPerJobBinding(t *testing.T) {
	// Guards the classic while+var async closure bug: concurrent page-quota
	// loads must not all close over the last shifted job.
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)
	if !strings.Contains(source, "function startBillingJob(job)") {
		t.Fatal("expected startBillingJob(job) so each concurrent request binds its own job")
	}
	if !strings.Contains(source, "function drainBillingQueue()") {
		t.Fatal("missing drainBillingQueue")
	}
	start := strings.Index(source, "function drainBillingQueue()")
	end := strings.Index(source[start:], "\n  function ")
	if end < 0 {
		end = len(source) - start
	}
	drainBody := source[start : start+end]
	// Drain must dispatch via startBillingJob(...shift...), not inline var job + api().then
	if !strings.Contains(drainBody, "startBillingJob(state.billingQueue.shift())") &&
		!strings.Contains(drainBody, "startBillingJob(state.billingQueue.shift())") {
		// allow whitespace variants
		if !strings.Contains(drainBody, "startBillingJob(") || !strings.Contains(drainBody, "billingQueue.shift()") {
			t.Fatalf("drainBillingQueue must call startBillingJob with shifted job, got:\n%s", drainBody)
		}
	}
	// Forbidden pattern: var job = ...shift in the same function that attaches .then using job
	if strings.Contains(drainBody, "var job = state.billingQueue.shift()") {
		t.Fatal("drainBillingQueue must not use loop-scoped var job with async callbacks")
	}
	// startBillingJob body must use job.id in URL and cache key (shipped path)
	jobStart := strings.Index(source, "function startBillingJob(job)")
	if jobStart < 0 {
		t.Fatal("missing startBillingJob")
	}
	jobEnd := strings.Index(source[jobStart:], "function drainBillingQueue")
	if jobEnd < 0 {
		t.Fatal("could not bound startBillingJob")
	}
	jobBody := source[jobStart : jobStart+jobEnd]
	for _, marker := range []string{
		"encodeURIComponent(job.id)",
		"state.billingCache[job.id]",
		"job.cb",
	} {
		if !strings.Contains(jobBody, marker) {
			t.Fatalf("startBillingJob missing %q", marker)
		}
	}
}

func TestPageQuotaIsBoundedAndNotAutoOnList(t *testing.T) {
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)
	// Page quota is explicit action, not automatic on list render.
	if !strings.Contains(source, "function loadVisiblePageQuota()") {
		t.Fatal("missing loadVisiblePageQuota")
	}
	// Must cap work to current page / PAGE_SIZE and reuse billing queue concurrency.
	for _, marker := range []string{
		"PAGE_SIZE",
		"ids.slice(0, PAGE_SIZE)",
		"enqueueBilling(credId",
		"BILLING_CONCURRENCY",
		`btn-page-quota`,
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("page quota missing bound marker %q", marker)
		}
	}
	// List row render must still not call loadVisiblePageQuota or billing.
	rowStart := strings.Index(source, "function renderCredentialRow(c)")
	rowEnd := strings.Index(source[rowStart:], "function highlightSelectedRow")
	if rowStart < 0 || rowEnd < 0 {
		t.Fatal("could not bound renderCredentialRow")
	}
	rowBody := source[rowStart : rowStart+rowEnd]
	for _, banned := range []string{"loadVisiblePageQuota", "enqueueBilling", "/billing", "fillCredentialUsage"} {
		if strings.Contains(rowBody, banned) {
			t.Fatalf("list row must not auto-load quota (%q)", banned)
		}
	}
}

func TestActivityHistorySurfacesImportAndInspection(t *testing.T) {
	app, err := ReadStatic("app.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(app)
	// recordActivity must be invoked from durable operator outcomes.
	for _, marker := range []string{
		`kind: "import"`,
		`kind: "inspection"`,
		`kind: "batch"`,
		`title: "批量导入"`,
		`title: "凭证巡检完成"`,
		`title: "凭证巡检失败"`,
		"overview-activity",
		"本会话",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("activity history missing marker %q", marker)
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
		/* Geist dual-theme tokens */
		"--bg: #000000",
		"--text: #ededed",
		"--accent: #006efe",
		"--primary: #ededed",
		"--primary-fg: #000000",
		`[data-theme="light"]`,
		`[data-theme="dark"]`,
		".shell-layout",
		".sidebar",
		"--bg: #fafafa",
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
