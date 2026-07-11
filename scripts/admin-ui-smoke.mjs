#!/usr/bin/env node
/**
 * Admin UI browser smoke (no live upstream).
 *
 * Usage:
 *   ADMIN_UI_BASE_URL=http://127.0.0.1:PORT \
 *   ADMIN_UI_ADMIN_KEY=... \
 *   node scripts/admin-ui-smoke.mjs
 *
 * Requires: google-chrome/chromium + playwright-core (npm i -g or local).
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const baseURL = (process.env.ADMIN_UI_BASE_URL || "").replace(/\/$/, "");
const adminKey = process.env.ADMIN_UI_ADMIN_KEY || "";
const chromePath =
  process.env.CHROME_PATH ||
  ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) =>
    existsSync(p)
  );

if (!baseURL) {
  console.error("ADMIN_UI_BASE_URL is required");
  process.exit(2);
}
if (!adminKey) {
  console.error("ADMIN_UI_ADMIN_KEY is required");
  process.exit(2);
}
if (!chromePath) {
  console.error("Chrome/Chromium not found (set CHROME_PATH)");
  process.exit(2);
}

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    "playwright-core",
    "playwright",
    "/tmp/node_modules/playwright-core",
  ].filter(Boolean);
  let lastErr;
  for (const id of candidates) {
    try {
      return require(id);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    "playwright-core not found. Install: npm i playwright-core --prefix /tmp\n" +
      String(lastErr || "")
  );
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const shotDir = process.env.ADMIN_UI_SHOT_DIR || "";

async function shot(name) {
  if (!shotDir) return;
  await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: true });
}

try {
  // --- Login ---
  await page.goto(`${baseURL}/admin`, { waitUntil: "networkidle" });
  await shot("01-login");
  assert(await page.locator("#view-login").isVisible(), "login view hidden");
  await page.fill("#login-key", adminKey);
  await page.click("#login-submit");
  await page.waitForSelector("#view-shell:not(.hidden)", { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot("02-overview");

  // Default landing should be overview
  const hash1 = page.url();
  assert(hash1.includes("#/overview") || (await page.locator("#page-overview").isVisible()), "not on overview");

  // Checklist / stats present
  assert(await page.locator("#overview-stats").count(), "overview stats missing");
  assert(await page.locator("#overview-activity").count(), "overview activity surface missing");
  assert(
    (await page.locator("#overview-activity").innerText()).includes("最近操作"),
    "activity panel title missing"
  );

  // --- Credentials ---
  await page.click('a[data-route="credentials"]');
  await page.waitForTimeout(600);
  await shot("03-credentials");
  assert(await page.locator("#page-credentials:not(.hidden)").count(), "credentials page hidden");

  const expectCreds = process.env.ADMIN_UI_EXPECT_CREDS === "1";
  const emptyVisible = await page.locator("#cred-empty:not(.hidden)").count();
  const tableVisible = await page.locator("#cred-table-wrap:not(.hidden)").count();
  assert(emptyVisible || tableVisible, "credentials has neither empty nor table");

  if (expectCreds) {
    assert(tableVisible, "expected credential table with seeded accounts");
    const rows = page.locator("#cred-tbody tr.cred-row");
    const rowCount = await rows.count();
    assert(rowCount >= 3, `expected >=3 credential rows, got ${rowCount}`);

    // Drawer detail on row click
    await rows.first().click();
    await page.waitForSelector("#drawer:not(.hidden)", { timeout: 5000 });
    assert(await page.locator("#drawer-body").innerText(), "drawer body empty");
    await shot("03b-drawer");
    await page.click("#drawer-close");
    await page.waitForTimeout(200);
    assert(await page.locator("#drawer.hidden").count(), "drawer did not close");

    // Batch selection bar
    await page.locator("#cred-tbody input.cred-check").first().check();
    await page.waitForTimeout(150);
    assert(await page.locator("#cred-batch-bar:not(.hidden)").count(), "batch bar not shown");
    const batchText = await page.locator("#cred-batch-count").innerText();
    assert(batchText.includes("1"), `batch count unexpected: ${batchText}`);
    await page.click("#btn-batch-clear");
    await page.waitForTimeout(150);
    assert(await page.locator("#cred-batch-bar.hidden").count(), "batch bar still visible after clear");

    // Search narrows list
    await page.fill("#cred-search", "alice-e2e");
    await page.waitForTimeout(250);
    const filtered = await page.locator("#cred-tbody tr.cred-row").count();
    assert(filtered === 1, `search alice-e2e should leave 1 row, got ${filtered}`);
    await page.fill("#cred-search", "");
    // Poll row count without page.waitForFunction (CSP blocks unsafe-eval).
    let restored = 0;
    for (let i = 0; i < 20; i++) {
      restored = await page.locator("#cred-tbody tr.cred-row").count();
      if (restored >= 3) break;
      await page.waitForTimeout(150);
    }
    assert(restored >= 3, `search clear should restore >=3 rows, got ${restored}`);

    // Page quota is explicit (button exists); do not require live billing success.
    assert((await page.locator("#btn-page-quota").count()) > 0, "page quota button missing");
    const quotaCells = await page.locator("#cred-tbody td.quota-cell").count();
    assert(quotaCells >= 3, `quota cells missing on rows, got ${quotaCells}`);
  }

  // Filter URL sync
  await page.selectOption("#cred-filter-health", "problem");
  await page.waitForTimeout(300);
  const hashFilter = page.url();
  assert(hashFilter.includes("health=problem"), `filter not in hash: ${hashFilter}`);

  // Refresh restores filter from hash
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#view-shell:not(.hidden)", { timeout: 10000 });
  await page.waitForTimeout(500);
  // sessionStorage should keep login
  assert(await page.locator("#view-shell:not(.hidden)").count(), "session lost after reload");
  const healthVal = await page.locator("#cred-filter-health").inputValue();
  assert(healthVal === "problem", `health filter not restored: ${healthVal}`);
  await shot("04-credentials-filter-restored");

  // Reset filter
  await page.selectOption("#cred-filter-health", "all");
  await page.waitForTimeout(200);
  if (expectCreds) {
    // After reload+filter reset, table should still list seeded accounts
    await page.waitForTimeout(300);
    assert(
      (await page.locator("#cred-table-wrap:not(.hidden)").count()) > 0 ||
        (await page.locator("#cred-filtered-empty:not(.hidden)").count()) > 0,
      "credentials list missing after filter reset"
    );
  }

  // --- Clients ---
  await page.click('a[data-route="clients"]');
  await page.waitForTimeout(500);
  await shot("05-clients");
  assert(await page.locator("#page-clients:not(.hidden)").count(), "clients page hidden");
  assert(await page.locator("#snippet-anthropic").count(), "integration snippet missing");

  // Record an in-session activity via inspection attempt, then verify overview history.
  await page.click('a[data-route="overview"]');
  await page.waitForTimeout(300);
  await page.click("#btn-overview-inspect");
  await page.waitForTimeout(900);
  // Stay on / re-enter overview so paintActivity reflects recordActivity.
  await page.click('a[data-route="overview"]');
  await page.waitForTimeout(500);
  const activityText = await page.locator("#overview-activity").innerText();
  assert(
    activityText.includes("巡检"),
    `activity not retained after inspection: ${activityText.slice(0, 240)}`
  );
  await shot("05b-activity");

  // --- Settings dirty leave ---
  await page.click('a[data-route="settings"]');
  await page.waitForTimeout(600);
  await shot("06-settings");
  assert(await page.locator("#page-settings:not(.hidden)").count(), "settings page hidden");
  // Mark settings dirty via proxy mode select (visible on default tab).
  const proxySelect = page.locator("#settings-body select").first();
  assert((await proxySelect.count()) > 0, "settings select missing");
  const prevMode = await proxySelect.inputValue();
  const nextMode = prevMode === "direct" ? "environment" : "direct";
  await proxySelect.selectOption(nextMode);
  await page.waitForTimeout(200);

  page.once("dialog", async (d) => {
    assert(d.type() === "confirm", `unexpected dialog ${d.type()}: ${d.message()}`);
    await d.dismiss(); // stay on settings
  });
  await page.click('a[data-route="overview"]');
  await page.waitForTimeout(400);
  assert(
    (await page.locator("#page-settings:not(.hidden)").count()) > 0,
    "should stay on settings after cancel leave"
  );

  page.once("dialog", async (d) => {
    await d.accept(); // leave
  });
  await page.click('a[data-route="overview"]');
  await page.waitForTimeout(500);
  assert(
    (await page.locator("#page-overview:not(.hidden)").count()) > 0,
    "should navigate to overview after accept leave"
  );

  await shot("07-done");
  console.log("admin-ui-smoke: PASS");
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error("admin-ui-smoke: FAIL", err);
  try {
    await shot("99-fail");
  } catch {
    /* ignore */
  }
  await browser.close().catch(() => {});
  process.exit(1);
}
