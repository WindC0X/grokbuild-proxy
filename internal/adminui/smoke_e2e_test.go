package adminui_test

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/GreyGunG/grokbuild-proxy/internal/admin"
	"github.com/GreyGunG/grokbuild-proxy/internal/adminui"
	"github.com/GreyGunG/grokbuild-proxy/internal/config"
	"github.com/GreyGunG/grokbuild-proxy/internal/httpserver"
	runtimesettings "github.com/GreyGunG/grokbuild-proxy/internal/settings"
	"github.com/GreyGunG/grokbuild-proxy/internal/storage"
)

// TestAdminUIBrowserSmoke drives a headless Chrome pass over the Admin SPA.
//
// Runs when Chrome/Chromium and Node are available (or ADMIN_UI_E2E=1 forces
// hard failure when tools are missing). No live upstream is required.
func TestAdminUIBrowserSmoke(t *testing.T) {
	force := os.Getenv("ADMIN_UI_E2E") == "1"
	chrome := findChrome()
	node, nodeErr := exec.LookPath("node")
	if chrome == "" || nodeErr != nil {
		if force {
			t.Fatalf("ADMIN_UI_E2E=1 but chrome=%q node_err=%v", chrome, nodeErr)
		}
		t.Skipf("skip browser smoke (chrome=%q node_err=%v); set ADMIN_UI_E2E=1 to require", chrome, nodeErr)
	}

	// Ensure playwright-core is resolvable for the smoke script.
	if err := ensurePlaywrightCore(t); err != nil {
		if force {
			t.Fatal(err)
		}
		t.Skipf("skip browser smoke: %v", err)
	}

	dir := t.TempDir()
	store, err := storage.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	const adminKey = "admin-ui-e2e-key-0001"
	const apiKey = "sk-ui-e2e-api-key-0001"
	if _, _, _, _, err := store.EnsureBootstrapKeys(apiKey, adminKey); err != nil {
		t.Fatal(err)
	}

	cfg := config.Default()
	cfg.Listen = "127.0.0.1:0"
	cfg.DataDir = dir
	cfg.AdminKey = adminKey
	cfg.APIKey = apiKey
	cfg.Anthropic.Enabled = true

	settingsMgr, err := runtimesettings.New(store, storage.DefaultRuntimeSettings())
	if err != nil {
		t.Fatal(err)
	}

	adm := &admin.Handlers{
		Store:    store,
		Settings: settingsMgr,
		Config:   cfg,
		AdminKey: adminKey,
		Version:  "e2e-test",
		MaxBody:  1 << 20,
	}

	handler := httpserver.New(httpserver.Options{
		Config:   cfg,
		AdminKey: adminKey,
		Store:    store,
		Admin:    adm,
		Version:  "e2e-test",
	})
	// Ensure UI routes resolve (httpserver.New already mounts adminui).
	_ = adminui.IndexHandler()

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	repoRoot := findRepoRoot(t)
	script := filepath.Join(repoRoot, "scripts", "admin-ui-smoke.mjs")
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("smoke script missing: %v", err)
	}

	shotDir := filepath.Join(t.TempDir(), "shots")
	if err := os.MkdirAll(shotDir, 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(node, script)
	cmd.Dir = repoRoot
	cmd.Env = append(os.Environ(),
		"ADMIN_UI_BASE_URL="+srv.URL,
		"ADMIN_UI_ADMIN_KEY="+adminKey,
		"CHROME_PATH="+chrome,
		"ADMIN_UI_SHOT_DIR="+shotDir,
		"PLAYWRIGHT_CORE_PATH="+playwrightCorePath(),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("admin-ui-smoke failed: %v (shots in %s)", err, shotDir)
	}
}

func findChrome() string {
	if p := os.Getenv("CHROME_PATH"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	for _, c := range []string{"google-chrome", "chromium-browser", "chromium", "google-chrome-stable"} {
		if p, err := exec.LookPath(c); err == nil {
			return p
		}
	}
	for _, p := range []string{"/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// internal/adminui/smoke_e2e_test.go -> repo root
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("repo root %s missing go.mod: %v", root, err)
	}
	return root
}

func playwrightCorePath() string {
	if p := os.Getenv("PLAYWRIGHT_CORE_PATH"); p != "" {
		return p
	}
	return "/tmp/node_modules/playwright-core"
}

func ensurePlaywrightCore(t *testing.T) error {
	t.Helper()
	// Prefer already-installed module under /tmp from prior smoke runs.
	target := playwrightCorePath()
	if _, err := os.Stat(filepath.Join(target, "package.json")); err == nil {
		return nil
	}
	// Install into /tmp (does not pollute the Go module).
	cmd := exec.Command("npm", "install", "--no-save", "--prefix", "/tmp", "playwright-core@1.49.0")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return err
	}
	// npm --prefix /tmp puts packages in /tmp/node_modules/playwright-core
	time.Sleep(50 * time.Millisecond)
	if _, err := os.Stat(filepath.Join("/tmp/node_modules/playwright-core", "package.json")); err != nil {
		return err
	}
	return nil
}
