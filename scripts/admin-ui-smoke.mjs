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

  // --- Credentials ---
  await page.click('a[data-route="credentials"]');
  await page.waitForTimeout(500);
  await shot("03-credentials");
  assert(await page.locator("#page-credentials:not(.hidden)").count(), "credentials page hidden");

  // Empty or table — either ok; empty CTA should exist when empty
  const emptyVisible = await page.locator("#cred-empty:not(.hidden)").count();
  const tableVisible = await page.locator("#cred-table-wrap:not(.hidden)").count();
  assert(emptyVisible || tableVisible, "credentials has neither empty nor table");

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

  // --- Clients ---
  await page.click('a[data-route="clients"]');
  await page.waitForTimeout(500);
  await shot("05-clients");
  assert(await page.locator("#page-clients:not(.hidden)").count(), "clients page hidden");
  assert(await page.locator("#snippet-anthropic").count(), "integration snippet missing");

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
