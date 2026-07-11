/* grokbuild Admin SPA — ops console (sessionStorage key, textContent-only DOM) */
(function () {
  "use strict";

  var API_BASE = "";
  var SESSION_KEY = "grokbuild_admin_key";
  var PAGE_SIZE = 50;
  var BILLING_CONCURRENCY = 3;
  var ACTIVITY_MAX = 20;

  var state = {
    key: "",
    route: "login",
    system: null,
    settings: null,
    credentials: [],
    // Server-side list totals (current page only lives in credentials[]).
    credTotal: 0,
    credOffset: 0,
    credLimit: PAGE_SIZE,
    clients: [],
    credFilter: { q: "", health: "all", sort: "priority_desc", page: 1 },
    selectedCredId: "",
    selectedIds: {},
    crisisDismissed: false,
    busy: false,
    listAbort: null,
    billingCache: {},
    billingInflight: {},
    billingQueue: [],
    billingActive: 0,
    focusReturn: null,
    settingsDirty: false,
    settingsSaveHint: null,
    // In-session operator history (import / inspection / batch); not durable audit.
    activityLog: [],
  };

  // ---------- DOM helpers (no innerHTML for untrusted data) ----------

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== "") node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function show(node, on) {
    if (!node) return;
    node.classList.toggle("hidden", !on);
  }

  function setText(node, text) {
    if (node) node.textContent = text == null ? "" : String(text);
  }

  function lineMeta(label, value) {
    var row = el("div", "meta-row");
    row.appendChild(el("span", "meta-k", label));
    row.appendChild(el("span", "meta-v", value == null || value === "" ? "—" : String(value)));
    return row;
  }

  // ---------- Toast (light feedback only) ----------

  function toast(message, kind) {
    var host = $("toast-host");
    if (!host) return;
    var t = el("div", "toast " + (kind || ""));
    t.textContent = message;
    host.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 3200);
  }

  // ---------- Modal / drawer a11y ----------

  var FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var trapHandler = null;

  function openModal(title, bodyNode, footNodes) {
    var modal = $("modal");
    state.focusReturn = document.activeElement;
    setText($("modal-title"), title || "对话框");
    var body = $("modal-body");
    clear(body);
    if (bodyNode) body.appendChild(bodyNode);
    var foot = $("modal-foot");
    clear(foot);
    (footNodes || []).forEach(function (n) {
      foot.appendChild(n);
    });
    show(modal, true);
    installFocusTrap(modal);
    var first = modal.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function closeModal() {
    var modal = $("modal");
    uninstallFocusTrap();
    show(modal, false);
    clear($("modal-body"));
    clear($("modal-foot"));
    releaseFocus();
  }

  function openDrawer(title, bodyNode, footNodes) {
    var drawer = $("drawer");
    state.focusReturn = document.activeElement;
    setText($("drawer-title"), title || "详情");
    var body = $("drawer-body");
    clear(body);
    if (bodyNode) body.appendChild(bodyNode);
    var foot = $("drawer-foot");
    clear(foot);
    (footNodes || []).forEach(function (n) {
      foot.appendChild(n);
    });
    show(drawer, true);
    drawer.setAttribute("aria-hidden", "false");
    installFocusTrap(drawer);
    var first = drawer.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function closeDrawer() {
    var drawer = $("drawer");
    uninstallFocusTrap();
    show(drawer, false);
    if (drawer) drawer.setAttribute("aria-hidden", "true");
    clear($("drawer-body"));
    clear($("drawer-foot"));
    state.selectedCredId = "";
    releaseFocus();
    highlightSelectedRow();
  }

  function installFocusTrap(container) {
    uninstallFocusTrap();
    trapHandler = function (e) {
      if (e.key !== "Tab" || !container || container.classList.contains("hidden")) return;
      var nodes = container.querySelectorAll(FOCUSABLE);
      if (!nodes.length) return;
      var first = nodes[0];
      var last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapHandler, true);
  }

  function uninstallFocusTrap() {
    if (trapHandler) {
      document.removeEventListener("keydown", trapHandler, true);
      trapHandler = null;
    }
  }

  function releaseFocus() {
    var ret = state.focusReturn;
    state.focusReturn = null;
    if (ret && typeof ret.focus === "function") {
      try {
        ret.focus();
      } catch (_) {}
    }
  }

  // ---------- API ----------

  function apiErrorMessage(data, status) {
    if (data && data.error) {
      if (typeof data.error === "string") return data.error;
      if (data.error.message) return data.error.message;
    }
    if (data && data.message) return data.message;
    return "请求失败 HTTP " + status;
  }

  function api(method, path, body, opts) {
    opts = opts || {};
    var headers = { Accept: "application/json" };
    if (state.key) headers.Authorization = "Bearer " + state.key;
    var init = { method: method, headers: headers };
    if (opts.signal) init.signal = opts.signal;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return fetch(API_BASE + path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (_) {
            data = { raw: text };
          }
        }
        if (res.status === 401) {
          clearSession();
          logout(true);
          var err401 = new Error(apiErrorMessage(data, res.status) || "会话已失效，请重新登录");
          err401.status = 401;
          throw err401;
        }
        if (!res.ok) {
          var err = new Error(apiErrorMessage(data, res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function apiForm(method, path, form) {
    var headers = { Accept: "application/json" };
    if (state.key) headers.Authorization = "Bearer " + state.key;
    return fetch(API_BASE + path, { method: method, headers: headers, body: form }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (_) {
            data = { raw: text };
          }
        }
        if (res.status === 401) {
          clearSession();
          logout(true);
          throw new Error(apiErrorMessage(data, res.status) || "会话已失效，请重新登录");
        }
        if (!res.ok) {
          var err = new Error(apiErrorMessage(data, res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  // ---------- Session ----------

  function loadSession() {
    try {
      return (sessionStorage.getItem(SESSION_KEY) || "").trim();
    } catch (_) {
      return "";
    }
  }

  function saveSession(key) {
    try {
      if (key) sessionStorage.setItem(SESSION_KEY, key);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (_) {}
  }

  function clearSession() {
    state.key = "";
    saveSession("");
  }

  // ---------- Routing ----------

  function parseHashQuery() {
    var hash = (location.hash || "").replace(/^#\/?/, "");
    var parts = hash.split("?");
    var query = {};
    if (parts[1]) {
      parts[1].split("&").forEach(function (pair) {
        if (!pair) return;
        var kv = pair.split("=");
        var k = decodeURIComponent(kv[0] || "");
        var v = decodeURIComponent(kv.slice(1).join("=") || "");
        if (k) query[k] = v;
      });
    }
    return query;
  }

  function parseRoute() {
    var hash = (location.hash || "").replace(/^#\/?/, "");
    var parts = hash.split("?");
    var name = (parts[0] || "").split("/")[0] || "";
    if (!name) name = state.key ? "overview" : "login";
    if (name === "integration") name = "clients";
    return name;
  }

  function applyCredQueryFromHash() {
    var q = parseHashQuery();
    if (q.q != null) state.credFilter.q = String(q.q);
    if (q.health) state.credFilter.health = String(q.health);
    if (q.sort) state.credFilter.sort = String(q.sort);
    if (q.page) {
      var p = parseInt(q.page, 10);
      if (!isNaN(p) && p > 0) state.credFilter.page = p;
    }
    if ($("cred-search") && q.q != null) $("cred-search").value = state.credFilter.q;
    if ($("cred-filter-health") && state.credFilter.health) {
      $("cred-filter-health").value = state.credFilter.health;
    }
    if ($("cred-sort") && state.credFilter.sort) $("cred-sort").value = state.credFilter.sort;
  }

  function syncCredHash() {
    if (state.route !== "credentials") return;
    var parts = [];
    if (state.credFilter.q) parts.push("q=" + encodeURIComponent(state.credFilter.q));
    if (state.credFilter.health && state.credFilter.health !== "all") {
      parts.push("health=" + encodeURIComponent(state.credFilter.health));
    }
    if (state.credFilter.sort && state.credFilter.sort !== "priority_desc") {
      parts.push("sort=" + encodeURIComponent(state.credFilter.sort));
    }
    if (state.credFilter.page > 1) parts.push("page=" + encodeURIComponent(String(state.credFilter.page)));
    var next = "#/credentials" + (parts.length ? "?" + parts.join("&") : "");
    if (location.hash !== next) {
      if (history.replaceState) history.replaceState(null, "", next);
      else location.hash = next;
    }
  }

  function navigate(route) {
    if (!route) route = "overview";
    if (state.route === "settings" && route !== "settings" && state.settingsDirty) {
      if (!confirm("运行配置有未保存的修改，确定离开？")) {
        setActiveNav("settings");
        return;
      }
      state.settingsDirty = false;
    }
    if (route === "credentials") {
      var parts = [];
      if (state.credFilter.q) parts.push("q=" + encodeURIComponent(state.credFilter.q));
      if (state.credFilter.health && state.credFilter.health !== "all") {
        parts.push("health=" + encodeURIComponent(state.credFilter.health));
      }
      if (state.credFilter.sort && state.credFilter.sort !== "priority_desc") {
        parts.push("sort=" + encodeURIComponent(state.credFilter.sort));
      }
      if (state.credFilter.page > 1) {
        parts.push("page=" + encodeURIComponent(String(state.credFilter.page)));
      }
      location.hash = "#/credentials" + (parts.length ? "?" + parts.join("&") : "");
      return;
    }
    location.hash = "#/" + route;
  }

  function requireAuth(route) {
    if (route === "login") return "login";
    if (!state.key) return "login";
    return route;
  }

  function setActiveNav(route) {
    var links = document.querySelectorAll("#main-nav a");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      a.classList.toggle("active", a.getAttribute("data-route") === route);
    }
  }

  // Theme / density prefs (localStorage only — never admin key).
  function themePref() {
    try {
      return localStorage.getItem("gb_theme") || "system";
    } catch (_) {
      return "system";
    }
  }

  function densityPref() {
    try {
      return localStorage.getItem("gb_density") === "compact" ? "compact" : "comfortable";
    } catch (_) {
      return "comfortable";
    }
  }

  function resolvedTheme(pref) {
    if (pref === "light") return "light";
    if (pref === "dark") return "dark";
    try {
      return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch (_) {
      return "dark";
    }
  }

  function applyTheme(pref) {
    if (!pref) pref = themePref();
    if (pref !== "light" && pref !== "dark" && pref !== "system") pref = "system";
    try {
      localStorage.setItem("gb_theme", pref);
    } catch (_) {}
    var resolved = resolvedTheme(pref);
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-pref", pref);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", resolved === "dark" ? "dark light" : "light dark");
    syncThemeSeg(pref);
  }

  function applyDensity(pref) {
    if (!pref) pref = densityPref();
    if (pref !== "compact") pref = "comfortable";
    try {
      localStorage.setItem("gb_density", pref);
    } catch (_) {}
    document.documentElement.setAttribute("data-density", pref);
    syncDensitySeg(pref);
  }

  function syncThemeSeg(pref) {
    var host = $("theme-seg");
    if (!host) return;
    var btns = host.querySelectorAll("[data-theme-pref]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].getAttribute("data-theme-pref") === pref);
    }
  }

  function syncDensitySeg(pref) {
    var host = $("density-seg");
    if (!host) return;
    var btns = host.querySelectorAll("[data-density-pref]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].getAttribute("data-density-pref") === pref);
    }
  }

  function setSidebarOpen(open) {
    document.body.classList.toggle("sidebar-open", !!open);
    var btn = $("btn-sidebar-toggle");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    var backdrop = $("sidebar-backdrop");
    if (backdrop) {
      if (open) {
        backdrop.hidden = false;
        backdrop.classList.remove("hidden");
      } else {
        backdrop.hidden = true;
        backdrop.classList.add("hidden");
      }
    }
  }

  function render() {
    var route = requireAuth(parseRoute());
    // Guard leaving settings with unsaved edits (hash navigation).
    if (
      state.route === "settings" &&
      route !== "settings" &&
      state.settingsDirty &&
      state.key
    ) {
      if (!confirm("运行配置有未保存的修改，确定离开？")) {
        location.hash = "#/settings";
        setActiveNav("settings");
        return;
      }
      state.settingsDirty = false;
    }
    state.route = route;
    setSidebarOpen(false);

    show($("view-login"), route === "login");
    show($("view-shell"), route !== "login");

    if (route === "login") {
      if (state.key) {
        navigate("overview");
      }
      return;
    }

    setActiveNav(route);
    show($("page-overview"), route === "overview");
    show($("page-credentials"), route === "credentials");
    show($("page-clients"), route === "clients");
    show($("page-settings"), route === "settings");
    show($("page-system"), route === "system");

    if (route === "overview") loadOverview();
    else if (route === "credentials") {
      applyCredQueryFromHash();
      loadCredentials();
    } else if (route === "clients") {
      loadClients();
      renderIntegration();
    } else if (route === "settings") loadSettings();
    else if (route === "system") loadSystem();
  }

  // ---------- Auth ----------

  function logout(silent) {
    clearSession();
    state.system = null;
    state.credentials = [];
    state.clients = [];
    closeDrawer();
    closeModal();
    if (!silent) toast("已退出", "ok");
    navigate("login");
    render();
  }

  function login(key) {
    key = (key || "").trim();
    if (!key) {
      setText($("login-error"), "请输入管理员密钥");
      show($("login-error"), true);
      return Promise.resolve();
    }
    var btn = $("login-submit");
    if (btn) btn.disabled = true;
    show($("login-error"), false);
    var prev = state.key;
    state.key = key;
    return api("GET", "/admin/system")
      .then(function (sys) {
        state.system = sys;
        saveSession(key);
        setText($("shell-version"), (sys && sys.version) || "管理后台");
        toast("登录成功", "ok");
        updateTopbarStatus(sys);
        navigate("overview");
        render();
      })
      .catch(function (err) {
        state.key = prev;
        setText($("login-error"), err.message || "登录失败");
        show($("login-error"), true);
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  // ---------- Formatters ----------

  function fmtTime(v) {
    if (!v) return "—";
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString();
  }

  function shortId(id) {
    id = String(id || "");
    if (id.length <= 12) return id || "—";
    return id.slice(0, 6) + "…" + id.slice(-4);
  }

  function num(v) {
    var n = Number(v);
    return isNaN(n) ? 0 : n;
  }

  function optionalNum(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  function inspectionStatusText(status) {
    var labels = {
      healthy: "健康",
      unauthorized: "认证失效",
      unauthorized_unconfirmed: "待确认的认证失效",
      rate_limited: "触发限流",
      mass_failure_guard: "批量异常保护",
      state_changed: "凭证已变更，结果未应用",
      settings_changed: "巡检设置已变更，结果未应用",
    };
    return labels[status] || status || "未记录";
  }

  // ---------- Health model ----------

  function runtimeHealth(c) {
    if (!c) return { key: "unknown", label: "未知", cls: "badge-off" };
    if (c.lifecycle_state === "quarantined") {
      return { key: "quarantined", label: "隔离", cls: "badge-danger" };
    }
    if (!c.enabled) {
      return { key: "disabled", label: "已禁用", cls: "badge-off" };
    }
    var now = Date.now();
    if (c.cooldown_until && new Date(c.cooldown_until).getTime() > now) {
      return { key: "cooling", label: "冷却", cls: "badge-warn" };
    }
    var expired = c.expires_at && new Date(c.expires_at).getTime() <= now;
    if (expired && !c.has_refresh_token) {
      return { key: "expired", label: "过期", cls: "badge-danger" };
    }
    if (expired && c.has_refresh_token) {
      return { key: "expired", label: "令牌过期(可刷新)", cls: "badge-warn" };
    }
    var err = String(c.last_error || "").toLowerCase();
    var insp = String(c.last_inspection_status || "");
    if (insp === "unauthorized" || err.indexOf("401") >= 0 || err.indexOf("unauthorized") >= 0) {
      return { key: "auth_failed", label: "认证失效", cls: "badge-danger" };
    }
    if (insp === "rate_limited" || err.indexOf("429") >= 0) {
      return { key: "cooling", label: "限流", cls: "badge-warn" };
    }
    if (c.failure_count > 0 && c.last_error) {
      return { key: "problem", label: "异常", cls: "badge-warn" };
    }
    return { key: "healthy", label: "健康", cls: "badge-ok" };
  }

  function configState(c) {
    if (!c) return { label: "—", cls: "badge-off" };
    if (c.lifecycle_state === "quarantined") return { label: "隔离配置", cls: "badge-danger" };
    if (c.enabled) return { label: "已启用", cls: "badge-ok" };
    return { label: "已禁用", cls: "badge-off" };
  }

  function isProblem(c) {
    var h = runtimeHealth(c).key;
    return h !== "healthy";
  }

  // ---------- Topbar / crisis ----------

  function updateTopbarStatus(sys) {
    var pool = (sys && sys.pool) || {};
    var total = num(pool.total);
    var available = num(pool.available);
    var text = $("status-text");
    var dot = $("status-dot");
    if (!text || !dot) return;
    if (total === 0) {
      setText(text, "无凭证");
      dot.className = "status-dot status-dot-warn";
    } else if (available === 0) {
      setText(text, "不可用 0/" + total);
      dot.className = "status-dot status-dot-danger";
    } else if (available < total) {
      setText(text, "可用 " + available + "/" + total);
      dot.className = "status-dot status-dot-warn";
    } else {
      setText(text, "可用 " + available + "/" + total);
      dot.className = "status-dot status-dot-ok";
    }
    updateCrisisBanner(sys);
  }

  function updateCrisisBanner(sys) {
    var banner = $("crisis-banner");
    if (!banner) return;
    var pool = (sys && sys.pool) || {};
    var total = num(pool.total);
    var available = num(pool.available);
    var severe = total > 0 && available === 0;
    if (!severe || state.crisisDismissed) {
      show(banner, false);
      return;
    }
    setText($("crisis-title"), "账号池不可用");
    setText(
      $("crisis-detail"),
      "共 " + total + " 个账号，当前可用 0。请检查认证失效、冷却或隔离状态。"
    );
    show(banner, true);
  }

  // ---------- In-session activity (import / inspection outcomes) ----------

  function recordActivity(entry) {
    if (!entry) return;
    state.activityLog.unshift({
      at: new Date().toISOString(),
      kind: entry.kind || "info",
      title: entry.title || "",
      detail: entry.detail || "",
      ok: entry.ok !== false,
    });
    if (state.activityLog.length > ACTIVITY_MAX) {
      state.activityLog.length = ACTIVITY_MAX;
    }
    if (state.route === "overview") paintActivity();
  }

  function paintActivity() {
    var host = $("overview-activity");
    if (!host) return;
    clear(host);
    host.appendChild(el("h3", "", "最近操作（本会话）"));
    host.appendChild(
      el(
        "p",
        "muted small",
        "导入、巡检、批量操作结果关闭弹窗后仍可在此查看（仅当前标签页会话，不落盘）。"
      )
    );
    if (!state.activityLog.length) {
      host.appendChild(el("p", "muted", "暂无记录。完成一次导入或巡检后会出现在这里。"));
      return;
    }
    var list = el("ul", "activity-list");
    state.activityLog.forEach(function (a) {
      var li = el("li", a.ok ? "activity-ok" : "activity-err");
      li.appendChild(el("div", "activity-title", a.title));
      var meta = fmtTime(a.at);
      if (a.detail) meta += " · " + a.detail;
      li.appendChild(el("div", "muted small", meta));
      list.appendChild(li);
    });
    host.appendChild(list);
  }

  // ---------- Overview ----------

  function loadOverview() {
    var body = $("overview-body");
    var stats = $("overview-stats");
    if (!stats) return;
    clear(stats);
    if (body) {
      clear(body);
      body.appendChild(el("p", "muted", "加载概览…"));
    }
    api("GET", "/admin/system")
      .then(function (sys) {
        state.system = sys;
        setText($("shell-version"), (sys && sys.version) || "管理后台");
        updateTopbarStatus(sys);
        renderOverview(sys);
        paintActivity();
        // Checklist only needs existence counts — avoid downloading the full pool.
        return api("GET", "/admin/credentials?limit=1").then(function (data) {
          state.credTotal = data && data.total != null ? num(data.total) : ((data && data.credentials) || []).length;
          renderChecklist();
        });
      })
      .catch(function (err) {
        if (body) {
          clear(body);
          var panel = el("div", "error-panel");
          panel.appendChild(el("h3", "", "概览加载失败"));
          panel.appendChild(el("p", "muted", err.message || "未知错误"));
          var retry = el("button", "btn btn-primary", "重试");
          retry.type = "button";
          retry.addEventListener("click", loadOverview);
          panel.appendChild(retry);
          body.appendChild(panel);
        }
        paintActivity();
      });
  }

  function renderOverview(sys) {
    var stats = $("overview-stats");
    var body = $("overview-body");
    if (!stats || !body) return;
    clear(stats);
    clear(body);
    var pool = (sys && sys.pool) || {};
    var cards = [
      ["可用", String(num(pool.available)) + " / " + String(num(pool.total)), "ok"],
      ["冷却", String(num(pool.cooling)), "warn"],
      ["禁用", String(num(pool.disabled)), "off"],
      ["过期", String(num(pool.expired)), "danger"],
    ];
    cards.forEach(function (item) {
      var card = el("div", "stat-card tone-" + item[2]);
      card.appendChild(el("div", "stat-label", item[0]));
      card.appendChild(el("div", "stat-value", item[1]));
      stats.appendChild(card);
    });

    var info = el("div", "card stack");
    info.appendChild(el("h3", "", "池状态详情"));
    info.appendChild(lineMeta("下次恢复", pool.next_recovery_at ? fmtTime(pool.next_recovery_at) : "—"));
    info.appendChild(lineMeta("最近成功", pool.last_success_at ? fmtTime(pool.last_success_at) : "—"));
    info.appendChild(lineMeta("缺少令牌", String(num(pool.missing_tokens))));
    if (sys.upstream) {
      info.appendChild(lineMeta("上游", sys.upstream.base_url || "—"));
    }
    body.appendChild(info);

    var actions = el("div", "card stack");
    actions.appendChild(el("h3", "", "快捷操作"));
    var row = el("div", "row gap wrap");
    var goProblem = el("button", "btn", "查看需处理账号");
    goProblem.type = "button";
    goProblem.addEventListener("click", function () {
      state.credFilter.health = "problem";
      state.credFilter.page = 1;
      var sel = $("cred-filter-health");
      if (sel) sel.value = "problem";
      navigate("credentials");
    });
    var goClients = el("button", "btn", "客户端接入");
    goClients.type = "button";
    goClients.addEventListener("click", function () {
      navigate("clients");
    });
    row.appendChild(goProblem);
    row.appendChild(goClients);
    actions.appendChild(row);
    body.appendChild(actions);
  }

  function renderChecklist() {
    var host = $("overview-checklist");
    if (!host) return;
    var poolTotal = state.system && state.system.pool ? num(state.system.pool.total) : 0;
    var hasCred = state.credTotal > 0 || poolTotal > 0;
    var hasClient = state.clients.length > 0;
    // Lazy-load clients if unknown.
    if (!hasClient && state.key) {
      api("GET", "/admin/clients")
        .then(function (data) {
          state.clients = (data && data.clients) || [];
          paintChecklist(host, hasCred, state.clients.length > 0);
        })
        .catch(function () {
          paintChecklist(host, hasCred, false);
        });
      return;
    }
    paintChecklist(host, hasCred, hasClient);
  }

  function paintChecklist(host, hasCred, hasClient) {
    clear(host);
    if (hasCred && hasClient) {
      show(host, false);
      return;
    }
    show(host, true);
    host.appendChild(el("h3", "", "启动清单"));
    host.appendChild(el("p", "muted", "完成下列步骤后即可在 Claude Code / OpenAI 客户端使用本代理。"));
    var list = el("ol", "checklist");
    list.appendChild(checkItem(hasCred, "添加至少一个 Grok 账号", function () {
      navigate("credentials");
      startDeviceLogin();
    }, "浏览器登录"));
    list.appendChild(checkItem(hasClient, "创建客户端密钥", function () {
      navigate("clients");
      openCreateClientModal();
    }, "创建密钥"));
    list.appendChild(checkItem(hasCred && hasClient, "复制接入配置", function () {
      navigate("clients");
    }, "打开接入"));
    host.appendChild(list);
  }

  function checkItem(done, label, onClick, btnLabel) {
    var li = el("li", done ? "check-done" : "check-todo");
    li.appendChild(el("span", "", (done ? "✓ " : "○ ") + label));
    if (!done && onClick) {
      var b = el("button", "btn btn-sm btn-primary", btnLabel || "前往");
      b.type = "button";
      b.addEventListener("click", onClick);
      li.appendChild(b);
    }
    return li;
  }

  // ---------- Credentials ----------

  function setCredPanel(mode) {
    show($("cred-loading"), mode === "loading");
    show($("cred-error"), mode === "error");
    show($("cred-empty"), mode === "empty");
    show($("cred-filtered-empty"), mode === "filtered");
    show($("cred-table-wrap"), mode === "table");
  }

  function syncFilterFromControls() {
    // Prefer live control values when present — empty input must clear the query.
    state.credFilter.q = $("cred-search")
      ? String($("cred-search").value || "").trim().toLowerCase()
      : String(state.credFilter.q || "").trim().toLowerCase();
    state.credFilter.health = $("cred-filter-health")
      ? String($("cred-filter-health").value || "all")
      : state.credFilter.health || "all";
    state.credFilter.sort = $("cred-sort")
      ? String($("cred-sort").value || "priority_desc")
      : state.credFilter.sort || "priority_desc";
    if (state.credFilter.page < 1) state.credFilter.page = 1;
  }

  function credentialsListURL() {
    syncFilterFromControls();
    var parts = [
      "page=" + encodeURIComponent(String(state.credFilter.page)),
      "limit=" + encodeURIComponent(String(PAGE_SIZE)),
    ];
    if (state.credFilter.q) parts.push("q=" + encodeURIComponent(state.credFilter.q));
    if (state.credFilter.health && state.credFilter.health !== "all") {
      parts.push("health=" + encodeURIComponent(state.credFilter.health));
    }
    if (state.credFilter.sort) parts.push("sort=" + encodeURIComponent(state.credFilter.sort));
    return "/admin/credentials?" + parts.join("&");
  }

  function loadCredentials() {
    if (state.listAbort) {
      try {
        state.listAbort.abort();
      } catch (_) {}
    }
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    state.listAbort = controller;
    setCredPanel("loading");
    // Sync controls → state before hash + URL (hash must not lag behind DOM filters).
    var listURL = credentialsListURL();
    syncCredHash();
    api("GET", listURL, undefined, controller ? { signal: controller.signal } : {})
      .then(function (data) {
        state.credentials = (data && data.credentials) || [];
        state.credTotal = data && data.total != null ? num(data.total) : state.credentials.length;
        state.credOffset = data && data.offset != null ? num(data.offset) : 0;
        state.credLimit = data && data.limit != null ? num(data.limit) : PAGE_SIZE;
        renderCredentialPage();
        // Refresh pool status without coupling to billing.
        return api("GET", "/admin/system").then(function (sys) {
          state.system = sys;
          updateTopbarStatus(sys);
        });
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return;
        setCredPanel("error");
        setText($("cred-error-msg"), err.message || "加载失败");
      });
  }

  // Server already filtered/sorted/paged — only render the current page payload.
  function applyCredFiltersAndRender() {
    // Filter controls changed: reset to page 1 and re-fetch from server.
    state.credFilter.page = 1;
    loadCredentials();
  }

  function renderCredentialPage() {
    var total = state.credTotal;
    var pageItems = state.credentials || [];
    var limit = state.credLimit || PAGE_SIZE;
    var pages = Math.max(1, Math.ceil(total / limit) || 1);
    // Clamp out-of-range page after deletes/filter shrinks; re-fetch once.
    if (total > 0 && state.credFilter.page > pages) {
      state.credFilter.page = pages;
      loadCredentials();
      return;
    }
    var start = state.credOffset;
    var end = start + pageItems.length;

    setText(
      $("cred-count"),
      "显示 " + (total && pageItems.length ? start + 1 : 0) + "–" + end + " / 筛选 " + total
    );

    if (total === 0) {
      // Distinguish empty pool vs empty filter when possible via health/q.
      var filtered =
        (state.credFilter.q && state.credFilter.q.length > 0) ||
        (state.credFilter.health && state.credFilter.health !== "all");
      setCredPanel(filtered ? "filtered" : "empty");
      show($("cred-batch-bar"), false);
      renderPager(1);
      return;
    }
    if (!pageItems.length) {
      setCredPanel("filtered");
      show($("cred-batch-bar"), false);
      renderPager(pages);
      return;
    }

    setCredPanel("table");
    var tbody = $("cred-tbody");
    clear(tbody);
    pageItems.forEach(function (c) {
      tbody.appendChild(renderCredentialRow(c));
    });
    renderPager(pages);
    highlightSelectedRow();
    updateBatchBar();
  }

  function renderPager(pages) {
    var host = $("cred-pager");
    if (!host) return;
    clear(host);
    if (pages <= 1) return;
    var prev = el("button", "btn btn-sm", "上一页");
    prev.type = "button";
    prev.disabled = state.credFilter.page <= 1;
    prev.addEventListener("click", function () {
      state.credFilter.page--;
      loadCredentials();
    });
    var next = el("button", "btn btn-sm", "下一页");
    next.type = "button";
    next.disabled = state.credFilter.page >= pages;
    next.addEventListener("click", function () {
      state.credFilter.page++;
      loadCredentials();
    });
    host.appendChild(prev);
    host.appendChild(el("span", "muted", "第 " + state.credFilter.page + " / " + pages + " 页 · 服务端分页"));
    host.appendChild(next);
  }

  function selectedCount() {
    var n = 0;
    for (var k in state.selectedIds) {
      if (state.selectedIds[k]) n++;
    }
    return n;
  }

  function selectedIdList() {
    var out = [];
    for (var k in state.selectedIds) {
      if (state.selectedIds[k]) out.push(k);
    }
    return out;
  }

  function updateBatchBar() {
    var bar = $("cred-batch-bar");
    var n = selectedCount();
    setText($("cred-batch-count"), "已选 " + n);
    show(bar, n > 0);
    var all = $("cred-select-all");
    if (all) {
      var rows = document.querySelectorAll("#cred-tbody input.cred-check");
      var checked = 0;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].checked) checked++;
      }
      all.checked = rows.length > 0 && checked === rows.length;
      all.indeterminate = checked > 0 && checked < rows.length;
    }
  }

  function clearSelection() {
    state.selectedIds = {};
    renderCredentialPage();
  }

  function runBatch(actionLabel, worker) {
    var ids = selectedIdList();
    if (!ids.length) {
      toast("请先选择账号", "err");
      return;
    }
    if (!confirm(actionLabel + " " + ids.length + " 个账号？")) return;
    var ok = 0;
    var fail = 0;
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return worker(id)
          .then(function () {
            ok++;
          })
          .catch(function () {
            fail++;
          });
      });
    });
    chain.then(function () {
      var detail = "成功 " + ok + " · 失败 " + fail;
      toast(actionLabel + "完成：" + detail, fail ? "err" : "ok");
      recordActivity({ kind: "batch", title: actionLabel, detail: detail, ok: fail === 0 });
      state.selectedIds = {};
      loadCredentials();
    });
  }

  function renderCredentialRow(c) {
    var tr = el("tr", "cred-row");
    tr.dataset.id = c.id || "";
    if (c.id === state.selectedCredId) tr.classList.add("is-selected");

    var checkTd = el("td", "col-check");
    var cb = el("input");
    cb.type = "checkbox";
    cb.className = "cred-check";
    cb.checked = !!state.selectedIds[c.id];
    cb.setAttribute("aria-label", "选择 " + (c.name || c.id || "账号"));
    cb.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    cb.addEventListener("change", function (e) {
      e.stopPropagation();
      if (cb.checked) state.selectedIds[c.id] = true;
      else delete state.selectedIds[c.id];
      updateBatchBar();
    });
    checkTd.appendChild(cb);
    tr.appendChild(checkTd);

    var nameTd = el("td");
    var title = el("div", "cred-name", c.name || c.email || c.id || "（未命名）");
    nameTd.appendChild(title);
    if (c.email && c.email !== c.name) nameTd.appendChild(el("div", "muted small", c.email));
    nameTd.appendChild(el("div", "muted small mono", shortId(c.id)));
    tr.appendChild(nameTd);

    var cfg = configState(c);
    var cfgTd = el("td");
    cfgTd.appendChild(el("span", "badge " + cfg.cls, cfg.label));
    tr.appendChild(cfgTd);

    var run = runtimeHealth(c);
    var runTd = el("td");
    var runBadge = el("span", "badge " + run.cls, run.label);
    runBadge.setAttribute("aria-label", cfg.label + "，" + run.label);
    runTd.appendChild(runBadge);
    tr.appendChild(runTd);

    tr.appendChild(el("td", "mono", String(c.priority != null ? c.priority : 0)));
    tr.appendChild(el("td", "small", fmtTime(c.expires_at)));
    var quotaTd = el("td", "quota-cell small muted");
    setText(quotaTd, quotaCellText(c.id));
    tr.appendChild(quotaTd);
    tr.appendChild(el("td", "small err-cell", c.last_error || "—"));

    var act = el("td", "col-actions");
    var detail = el("button", "btn btn-sm btn-primary", "详情");
    detail.type = "button";
    detail.addEventListener("click", function (e) {
      e.stopPropagation();
      openCredentialDetail(c.id);
    });
    act.appendChild(detail);

    var more = el("button", "btn btn-sm", "⋯");
    more.type = "button";
    more.setAttribute("aria-label", "更多操作");
    more.addEventListener("click", function (e) {
      e.stopPropagation();
      openCredentialActions(c);
    });
    act.appendChild(more);
    tr.appendChild(act);

    tr.addEventListener("click", function () {
      openCredentialDetail(c.id);
    });
    return tr;
  }

  function highlightSelectedRow() {
    var rows = document.querySelectorAll("#cred-tbody tr");
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle("is-selected", rows[i].dataset.id === state.selectedCredId);
    }
  }

  function findCredential(id) {
    for (var i = 0; i < state.credentials.length; i++) {
      if (state.credentials[i].id === id) return state.credentials[i];
    }
    return null;
  }

  function upsertCredentialLocal(c) {
    if (!c || !c.id) return;
    var found = false;
    for (var i = 0; i < state.credentials.length; i++) {
      if (state.credentials[i].id === c.id) {
        state.credentials[i] = c;
        found = true;
        break;
      }
    }
    if (!found) state.credentials.unshift(c);
  }

  function removeCredentialLocal(id) {
    state.credentials = state.credentials.filter(function (c) {
      return c.id !== id;
    });
  }

  function openCredentialActions(c) {
    var body = el("div", "stack");
    body.appendChild(el("p", "muted", (c.name || c.email || c.id || "") + " · " + runtimeHealth(c).label));

    function actionBtn(label, cls, fn) {
      var b = el("button", "btn " + (cls || ""), label);
      b.type = "button";
      b.addEventListener("click", function () {
        closeModal();
        fn();
      });
      return b;
    }

    var actions = el("div", "stack");
    actions.appendChild(
      actionBtn(c.enabled ? "禁用" : "启用", "", function () {
        toggleCredential(c);
      })
    );
    actions.appendChild(
      actionBtn("刷新令牌", "", function () {
        refreshCredential(c);
      })
    );
    actions.appendChild(
      actionBtn("设置代理", "", function () {
        showCredentialProxy(c);
      })
    );
    actions.appendChild(
      actionBtn("查看账单", "", function () {
        showBilling(c);
      })
    );
    actions.appendChild(
      actionBtn("删除", "btn-danger", function () {
        deleteCredential(c);
      })
    );
    body.appendChild(actions);

    var cancel = el("button", "btn", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", closeModal);
    openModal("账号操作", body, [cancel]);
  }

  function openCredentialDetail(id) {
    var c = findCredential(id);
    if (!c) return;
    state.selectedCredId = id;
    highlightSelectedRow();

    var body = el("div", "stack");
    body.appendChild(el("h4", "", c.name || c.email || c.id || "（未命名）"));
    body.appendChild(lineMeta("编号", c.id || "—"));
    body.appendChild(lineMeta("邮箱", c.email || "—"));
    body.appendChild(lineMeta("配置状态", configState(c).label));
    body.appendChild(lineMeta("运行状态", runtimeHealth(c).label));
    body.appendChild(lineMeta("优先级", String(c.priority != null ? c.priority : 0)));
    body.appendChild(lineMeta("过期时间", fmtTime(c.expires_at)));
    body.appendChild(
      lineMeta(
        "出站代理",
        c.proxy_mode === "url" ? c.proxy_url || "已配置" : c.proxy_mode === "direct" ? "直连" : "继承全局"
      )
    );
    if (c.disable_reason) body.appendChild(lineMeta("停用原因", c.disable_reason));
    if (c.quarantined_at) body.appendChild(lineMeta("隔离时间", fmtTime(c.quarantined_at)));
    body.appendChild(
      lineMeta(
        "令牌",
        (c.has_access_token ? "访问令牌" : "—") + " / " + (c.has_refresh_token ? "刷新令牌" : "—")
      )
    );
    if (c.access_token) body.appendChild(lineMeta("访问令牌(脱敏)", c.access_token));
    if (c.failure_count) body.appendChild(lineMeta("失败次数", String(c.failure_count)));
    if (c.last_error) body.appendChild(lineMeta("最近错误", c.last_error));
    if (c.cooldown_until) body.appendChild(lineMeta("冷却至", fmtTime(c.cooldown_until)));
    if (c.last_inspection_at || c.last_inspection_status || c.last_inspection_error) {
      body.appendChild(lineMeta("最近巡检", fmtTime(c.last_inspection_at)));
      body.appendChild(lineMeta("巡检结果", inspectionStatusText(c.last_inspection_status)));
      if (c.last_inspection_error) body.appendChild(lineMeta("巡检详情", c.last_inspection_error));
    }

    var prioRow = el("div", "priority-row");
    prioRow.appendChild(el("span", "label", "优先级"));
    var prioInput = el("input");
    prioInput.type = "number";
    prioInput.value = String(c.priority != null ? c.priority : 0);
    prioInput.setAttribute("aria-label", "优先级");
    var prioBtn = el("button", "btn btn-sm", "保存");
    prioBtn.type = "button";
    prioBtn.addEventListener("click", function () {
      var n = parseInt(prioInput.value, 10);
      if (isNaN(n)) {
        toast("优先级必须是数字", "err");
        return;
      }
      prioBtn.disabled = true;
      api("PUT", "/admin/credentials/" + encodeURIComponent(c.id) + "/priority", { priority: n })
        .then(function (updated) {
          toast("优先级已更新", "ok");
          if (updated && updated.id) upsertCredentialLocal(updated);
          else {
            c.priority = n;
            upsertCredentialLocal(c);
          }
          loadCredentials();
          openCredentialDetail(c.id);
        })
        .catch(function (err) {
          toast("更新失败: " + err.message, "err");
        })
        .finally(function () {
          prioBtn.disabled = false;
        });
    });
    prioRow.appendChild(prioInput);
    prioRow.appendChild(prioBtn);
    body.appendChild(prioRow);

    // On-demand billing only (never fan-out on list render).
    var usageBox = el("div", "usage-box");
    usageBox.appendChild(el("div", "muted", "额度未加载"));
    var loadUsage = el("button", "btn btn-sm", "加载额度");
    loadUsage.type = "button";
    loadUsage.addEventListener("click", function () {
      fillCredentialUsage(usageBox, c.id, true);
    });
    body.appendChild(usageBox);
    body.appendChild(loadUsage);

    var foot = [];
    var toggle = el("button", "btn", c.enabled ? "禁用" : "启用");
    toggle.type = "button";
    toggle.addEventListener("click", function () {
      toggleCredential(c);
    });
    foot.push(toggle);
    var refresh = el("button", "btn", "刷新令牌");
    refresh.type = "button";
    refresh.addEventListener("click", function () {
      refreshCredential(c);
    });
    foot.push(refresh);
    var proxyBtn = el("button", "btn", "代理");
    proxyBtn.type = "button";
    proxyBtn.addEventListener("click", function () {
      showCredentialProxy(c);
    });
    foot.push(proxyBtn);
    var billing = el("button", "btn", "账单");
    billing.type = "button";
    billing.addEventListener("click", function () {
      showBilling(c);
    });
    foot.push(billing);
    var del = el("button", "btn btn-danger", "删除");
    del.type = "button";
    del.addEventListener("click", function () {
      deleteCredential(c);
    });
    foot.push(del);

    openDrawer("凭证详情", body, foot);
  }

  function toggleCredential(c) {
    api("POST", "/admin/credentials/" + encodeURIComponent(c.id) + "/disable", { enabled: !c.enabled })
      .then(function (updated) {
        toast(c.enabled ? "已禁用" : "已启用", "ok");
        if (updated && updated.id) upsertCredentialLocal(updated);
        else {
          c.enabled = !c.enabled;
          upsertCredentialLocal(c);
        }
        loadCredentials();
        if (state.selectedCredId === c.id) openCredentialDetail(c.id);
      })
      .catch(function (err) {
        toast("切换失败: " + err.message, "err");
      });
  }

  function refreshCredential(c) {
    api("POST", "/admin/credentials/" + encodeURIComponent(c.id) + "/refresh")
      .then(function (updated) {
        toast("令牌已刷新", "ok");
        if (updated && updated.id) upsertCredentialLocal(updated);
        loadCredentials();
        if (state.selectedCredId === c.id) openCredentialDetail(c.id);
      })
      .catch(function (err) {
        toast("刷新令牌失败: " + err.message, "err");
      });
  }

  function deleteCredential(c) {
    if (!confirm("确认删除凭证 " + (c.name || c.id) + " ？此操作不可撤销。")) return;
    api("DELETE", "/admin/credentials/" + encodeURIComponent(c.id))
      .then(function () {
        toast("已删除", "ok");
        removeCredentialLocal(c.id);
        if (state.selectedCredId === c.id) closeDrawer();
        loadCredentials();
      })
      .catch(function (err) {
        toast("删除失败: " + err.message, "err");
      });
  }

  function showCredentialProxy(c) {
    var body = el("div", "stack");
    body.appendChild(el("p", "muted", "现有代理密码不会回显；切换为自定义 URL 时需重新完整输入。"));
    var mode = el("select");
    [
      ["inherit", "继承全局"],
      ["direct", "直连"],
      ["url", "自定义 URL"],
    ].forEach(function (opt) {
      var o = el("option", "", opt[1]);
      o.value = opt[0];
      o.selected = (c.proxy_mode || "inherit") === opt[0];
      mode.appendChild(o);
    });
    var modeField = el("label", "field");
    modeField.appendChild(el("span", "label", "代理模式"));
    modeField.appendChild(mode);
    body.appendChild(modeField);

    var proxyURL = el("input");
    proxyURL.type = "password";
    proxyURL.placeholder = "http://user:pass@host:port 或 socks5h://host:port";
    proxyURL.disabled = mode.value !== "url";
    var urlField = el("label", "field");
    urlField.appendChild(el("span", "label", "代理 URL"));
    urlField.appendChild(proxyURL);
    body.appendChild(urlField);
    mode.addEventListener("change", function () {
      proxyURL.disabled = mode.value !== "url";
    });

    var cancel = el("button", "btn", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", closeModal);
    var save = el("button", "btn btn-primary", "保存");
    save.type = "button";
    save.addEventListener("click", function () {
      if (mode.value === "url" && !(proxyURL.value || "").trim()) {
        toast("请输入完整代理 URL", "err");
        return;
      }
      save.disabled = true;
      api("PUT", "/admin/credentials/" + encodeURIComponent(c.id) + "/proxy", {
        mode: mode.value,
        url: (proxyURL.value || "").trim(),
      })
        .then(function (updated) {
          toast("凭证代理已更新", "ok");
          closeModal();
          if (updated && updated.id) upsertCredentialLocal(updated);
          loadCredentials();
          if (state.selectedCredId === c.id) openCredentialDetail(c.id);
        })
        .catch(function (err) {
          toast("代理设置失败: " + err.message, "err");
        })
        .finally(function () {
          save.disabled = false;
        });
    });
    openModal("凭证代理", body, [cancel, save]);
  }

  function showBilling(c) {
    var body = el("div", "stack");
    body.appendChild(el("p", "muted", "加载账单…"));
    var reloadBtn = el("button", "btn btn-primary", "刷新");
    reloadBtn.type = "button";
    function load() {
      clear(body);
      body.appendChild(el("p", "muted", "加载账单…"));
      reloadBtn.disabled = true;
      api("GET", "/admin/credentials/" + encodeURIComponent(c.id) + "/billing")
        .then(function (snap) {
          state.billingCache[c.id] = { at: Date.now(), snap: snap };
          clear(body);
          body.appendChild(renderBillingDashboard(snap));
          var details = el("details", "raw-details");
          var summary = el("summary", "", "调试：原始 JSON（默认折叠）");
          details.appendChild(summary);
          var pre = el("pre", "code");
          pre.textContent = JSON.stringify(snap, null, 2);
          details.appendChild(pre);
          body.appendChild(details);
        })
        .catch(function (err) {
          clear(body);
          body.appendChild(el("p", "error", err.message || "账单加载失败"));
        })
        .finally(function () {
          reloadBtn.disabled = false;
        });
    }
    reloadBtn.addEventListener("click", load);
    openModal("账单 · " + (c.name || shortId(c.id)), body, [reloadBtn]);
    load();
  }

  function quotaCellText(credId) {
    var cached = state.billingCache[credId];
    if (!cached || !cached.snap) return "—";
    var build = (cached.snap && cached.snap.grok_build) || {};
    if (!build.reported || build.shared_weekly_usage_percent == null) return "未报告";
    return num(build.shared_weekly_usage_percent).toFixed(1) + "%";
  }

  // Load quota only for rows currently on the page — never full-pool auto N+1.
  function loadVisiblePageQuota() {
    var rows = document.querySelectorAll("#cred-tbody tr.cred-row");
    var ids = [];
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].dataset.id;
      if (id) ids.push(id);
    }
    if (!ids.length) {
      toast("当前页无账号可加载额度", "err");
      return;
    }
    if (ids.length > PAGE_SIZE) {
      // Defensive: page size is the hard upper bound for this action.
      ids = ids.slice(0, PAGE_SIZE);
    }
    toast("正在加载本页 " + ids.length + " 个账号额度…", "ok");
    function quotaCellFor(credId) {
      var list = document.querySelectorAll("#cred-tbody tr.cred-row");
      for (var r = 0; r < list.length; r++) {
        if (list[r].dataset.id === credId) return list[r].querySelector(".quota-cell");
      }
      return null;
    }
    ids.forEach(function (credId) {
      var cell = quotaCellFor(credId);
      if (cell) {
        clear(cell);
        cell.appendChild(el("span", "muted", "…"));
      }
      enqueueBilling(credId, function (err) {
        var target = quotaCellFor(credId);
        if (!target) return;
        clear(target);
        if (err) {
          target.appendChild(el("span", "error", "失败"));
          return;
        }
        setText(target, quotaCellText(credId));
        target.className = "quota-cell small";
      });
    });
    recordActivity({
      kind: "quota",
      title: "加载本页额度",
      detail: ids.length + " 个账号（并发 ≤ " + BILLING_CONCURRENCY + "）",
      ok: true,
    });
  }

  // fillCredentialUsage is only called from detail view (on demand), never list render.
  function fillCredentialUsage(box, credId, force) {
    if (!box || !credId) return;
    var cached = state.billingCache[credId];
    if (!force && cached && Date.now() - cached.at < 60000) {
      paintUsageBox(box, cached.snap);
      return;
    }
    clear(box);
    box.appendChild(el("div", "muted", "额度加载中…"));
    enqueueBilling(credId, function (err, snap) {
      if (err) {
        clear(box);
        box.appendChild(el("div", "error", "额度: " + (err.message || "失败")));
        return;
      }
      paintUsageBox(box, snap);
    });
  }

  function enqueueBilling(credId, cb) {
    state.billingQueue.push({ id: credId, cb: cb });
    drainBillingQueue();
  }

  // Per-job function parameter (not loop `var`) so concurrent .then/.catch keep the
  // correct credential id when BILLING_CONCURRENCY > 1 (page-quota loads).
  function startBillingJob(job) {
    if (!job || !job.id) return;
    state.billingActive++;
    api("GET", "/admin/credentials/" + encodeURIComponent(job.id) + "/billing")
      .then(function (snap) {
        state.billingCache[job.id] = { at: Date.now(), snap: snap };
        if (job.cb) job.cb(null, snap);
      })
      .catch(function (err) {
        if (job.cb) job.cb(err);
      })
      .finally(function () {
        state.billingActive--;
        drainBillingQueue();
      });
  }

  function drainBillingQueue() {
    while (state.billingActive < BILLING_CONCURRENCY && state.billingQueue.length) {
      startBillingJob(state.billingQueue.shift());
    }
  }

  function paintUsageBox(box, snap) {
    clear(box);
    var build = (snap && snap.grok_build) || {};
    if (!build.reported || build.shared_weekly_usage_percent == null) {
      box.appendChild(usageBar("Grok Build", 0, "未报告", "neutral"));
      return;
    }
    var pct = num(build.shared_weekly_usage_percent);
    var label = "共享周额度已用 " + pct.toFixed(1) + "%";
    if (build.grok_build_contribution_percent != null) {
      label += " · Build 贡献 " + num(build.grok_build_contribution_percent).toFixed(1) + "%";
    }
    box.appendChild(usageBar("Grok Build", pct, label, toneFromPct(pct)));
  }

  function parseUsage(snap) {
    var m = (snap && snap.monthly) || {};
    var w = (snap && snap.weekly) || {};
    var limit = optionalNum(m.monthlyLimit);
    var used = optionalNum(m.used);
    var rem = limit != null && used != null ? Math.max(0, limit - used) : null;
    var monthPct = limit != null && limit > 0 && used != null ? (used / limit) * 100 : null;
    var weekPct = optionalNum(w.creditUsagePercent);
    return {
      limit: limit,
      used: used,
      rem: rem,
      monthPct: monthPct,
      weekPct: weekPct,
      monthLabel:
        limit != null && limit > 0 && used != null
          ? fmtNum(used) + " / " + fmtNum(limit)
          : used != null
            ? fmtNum(used)
            : "未报告",
    };
  }

  function fmtNum(n) {
    if (n == null) return "—";
    return String(n);
  }

  function toneFromPct(pct) {
    if (pct >= 90) return "danger";
    if (pct >= 70) return "warn";
    return "ok";
  }

  function usageBar(title, pct, label, tone) {
    var wrap = el("div", "usage-item");
    wrap.appendChild(el("div", "usage-title", title));
    var track = el("div", "usage-track");
    var fill = el("div", "usage-fill tone-" + (tone || "ok"));
    fill.style.width = Math.max(0, Math.min(100, pct || 0)) + "%";
    track.appendChild(fill);
    wrap.appendChild(track);
    wrap.appendChild(el("div", "muted small", label || ""));
    return wrap;
  }

  function renderBillingDashboard(snap) {
    var wrap = el("div", "stack");
    var u = parseUsage(snap);
    var grid = el("div", "billing-grid");
    grid.appendChild(statMini("月度已用", u.used != null ? fmtNum(u.used) : "未报告"));
    grid.appendChild(statMini("月度上限", u.limit != null ? fmtNum(u.limit) : "未报告"));
    grid.appendChild(statMini("月度占比", u.monthPct != null ? u.monthPct.toFixed(1) + "%" : "未报告"));
    grid.appendChild(
      statMini("周额度", u.weekPct != null ? u.weekPct.toFixed(1) + "%" : "未报告")
    );
    wrap.appendChild(grid);

    var build = (snap && snap.grok_build) || {};
    if (build.reported) {
      wrap.appendChild(
        usageBar(
          "Grok Build 共享周额度",
          num(build.shared_weekly_usage_percent),
          "已用 " +
            (build.shared_weekly_usage_percent != null
              ? num(build.shared_weekly_usage_percent).toFixed(1) + "%"
              : "未报告"),
          toneFromPct(num(build.shared_weekly_usage_percent))
        )
      );
    }

    if (snap && snap.products && snap.products.length) {
      var prod = el("div", "stack");
      prod.appendChild(el("h4", "", "产品"));
      snap.products.forEach(function (p) {
        prod.appendChild(el("div", "muted small", JSON.stringify(p)));
      });
      wrap.appendChild(prod);
    }

    var diagnostics = el("div", "stack");
    if (snap && snap.monthly_error) diagnostics.appendChild(el("p", "error", "月度接口: " + snap.monthly_error));
    if (snap && snap.weekly_error) diagnostics.appendChild(el("p", "error", "周额度接口: " + snap.weekly_error));
    if (diagnostics.childNodes.length) wrap.appendChild(diagnostics);

    if (u.weekPct != null && u.weekPct >= 100) {
      wrap.appendChild(el("p", "error", "周额度已用尽（上游可能返回 402 账单错误）。"));
    } else if (u.monthPct != null && u.monthPct >= 95) {
      wrap.appendChild(el("p", "error", "月额度即将用尽，请留意切换账号。"));
    }
    return wrap;
  }

  function statMini(k, v) {
    var d = el("div", "stat-mini");
    d.appendChild(el("div", "muted small", k));
    d.appendChild(el("div", "stat-mini-v", v));
    return d;
  }

  // ---------- Import / device ----------

  function importDefaultGrok() {
    api("POST", "/admin/credentials/import-grok", {})
      .then(function (data) {
        var n = (data && (data.imported || data.created + data.updated)) || 0;
        toast("已导入 " + n + " 条凭证", "ok");
        recordActivity({
          kind: "import",
          title: "导入本机 ~/.grok",
          detail: "导入 " + n + " 条" + (data && data.failed ? " · 失败 " + data.failed : ""),
          ok: !(data && data.failed > 0 && n === 0),
        });
        loadCredentials();
      })
      .catch(function (err) {
        toast("导入失败: " + err.message, "err");
        recordActivity({ kind: "import", title: "导入本机 ~/.grok 失败", detail: err.message || "", ok: false });
      });
  }

  function startDeviceLogin() {
    api("POST", "/admin/oauth/device/start", {})
      .then(function (data) {
        var body = el("div", "stack");
        body.appendChild(el("p", "", "请在浏览器中完成 xAI 授权。"));
        if (data.user_code) body.appendChild(el("div", "plaintext-box", data.user_code));
        if (data.verification_uri_complete || data.verification_uri) {
          var link = el("a", "btn btn-primary", "打开授权页面");
          link.href = data.verification_uri_complete || data.verification_uri;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          body.appendChild(link);
        }
        var status = el("p", "muted", "等待授权…");
        body.appendChild(status);
        var close = el("button", "btn", "关闭");
        close.type = "button";
        close.addEventListener("click", closeModal);
        openModal("浏览器登录", body, [close]);

        var interval = Math.max(2, num(data.interval) || 5) * 1000;
        function poll() {
          api("POST", "/admin/oauth/device/poll", { session_id: data.session_id })
            .then(function (res) {
              if (res && res.status === "complete") {
                setText(status, "授权成功");
                toast("账号授权成功", "ok");
                recordActivity({ kind: "oauth", title: "浏览器登录成功", detail: "Device Login 完成", ok: true });
                closeModal();
                loadCredentials();
                return;
              }
              if (res && res.status === "pending") {
                var delay = Math.max(1, num(res.interval) || interval / 1000) * 1000;
                setTimeout(poll, delay);
                return;
              }
              if (res && res.status === "slow_down") {
                var retry = num(res.interval) || 5;
                setTimeout(poll, Math.max(1, retry) * 1000);
                return;
              }
              setText(status, (res && res.error) || "授权未完成");
            })
            .catch(function (err) {
              setText(status, err.message || "轮询失败");
            });
        }
        setTimeout(poll, interval);
      })
      .catch(function (err) {
        toast("启动浏览器登录失败: " + err.message, "err");
      });
  }

  function openImportRawModal() {
    var body = el("div", "stack");
    body.appendChild(el("p", "muted", "支持 Grok/CPA JSON 与 SSO 文本；可多文件或粘贴。"));
    var fileInput = el("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    body.appendChild(fileInput);
    var ta = el("textarea");
    ta.rows = 8;
    ta.placeholder = "或在此粘贴 JSON / SSO 文本";
    body.appendChild(ta);
    var status = el("p", "muted", "");
    body.appendChild(status);
    var importDetails = el("pre", "code");
    importDetails.style.display = "none";
    body.appendChild(importDetails);

    var cancel = el("button", "btn", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", closeModal);
    var ok = el("button", "btn btn-primary", "导入");
    ok.type = "button";
    ok.addEventListener("click", function () {
      var files = fileInput.files;
      var raw = (ta.value || "").trim();
      if ((!files || !files.length) && !raw) {
        toast("请选择文件或粘贴内容", "err");
        return;
      }
      ok.disabled = true;
      setText(status, "上传中…");
      var form = new FormData();
      if (files && files.length) {
        for (var i = 0; i < files.length; i++) form.append("files", files[i]);
      }
      if (raw) form.append("raw", raw);
      apiForm("POST", "/admin/credential-imports", form)
        .then(function (job) {
          if (job && job.id && job.status && job.status !== "completed" && job.status !== "partial" && job.status !== "failed") {
            setText(status, "任务已提交，处理中…");
            return pollImportJob(job.id, status, importDetails);
          }
          return job;
        })
        .then(function (job) {
          if (!job) return;
          var message =
            "导入完成：新建 " +
            num(job.created) +
            " · 更新 " +
            num(job.updated) +
            " · 失败 " +
            num(job.failed);
          setText(status, message);
          renderImportJobDetails(job, importDetails);
          toast(message, job.failed ? "err" : "ok");
          recordActivity({
            kind: "import",
            title: "批量导入",
            detail: message,
            ok: !(job.failed > 0 && num(job.created) + num(job.updated) === 0),
          });
          loadCredentials();
        })
        .catch(function (err) {
          setText(status, "导入失败: " + err.message);
          toast("导入失败: " + err.message, "err");
          recordActivity({ kind: "import", title: "批量导入失败", detail: err.message || "", ok: false });
        })
        .finally(function () {
          ok.disabled = false;
        });
    });
    openModal("批量导入", body, [cancel, ok]);
  }

  function pollImportJob(id, statusNode, detailsNode) {
    return new Promise(function (resolve, reject) {
      function poll() {
        api("GET", "/admin/credential-imports/" + encodeURIComponent(id))
          .then(function (job) {
            if (!job) {
              reject(new Error("任务不存在"));
              return;
            }
            if (job.status === "completed" || job.status === "partial" || job.status === "failed") {
              if (job.status === "failed" && !job.created && !job.updated) {
                var detail = job.error || ((job.results || [])[0] || {}).error || "导入任务失败";
                reject(new Error(detail));
                return;
              }
              resolve(job);
              return;
            }
            setText(statusNode, "处理中… " + (job.status || ""));
            setTimeout(poll, 500);
          })
          .catch(reject);
      }
      poll();
    }).then(function (job) {
      renderImportJobDetails(job, detailsNode);
      return job;
    });
  }

  function renderImportJobDetails(job, node) {
    if (!node) return;
    var lines = [];
    (job.files || []).forEach(function (file) {
      lines.push("文件 " + (file.name || "?") + " · " + (file.status || ""));
      (file.warnings || []).forEach(function (warning) {
        lines.push("  警告 [" + (warning.field || "unknown") + "] " + (warning.message || ""));
      });
      (file.results || []).forEach(function (result) {
        var line = "  " + (result.source || result.source_key || "") + " · " + (result.status || "");
        if (result.error) line += " · " + result.error;
        lines.push(line);
        (result.warnings || []).forEach(function (warning) {
          lines.push("    警告 [" + (warning.field || "unknown") + "] " + (warning.message || ""));
        });
      });
    });
    node.style.display = lines.length ? "block" : "none";
    setText(node, lines.join("\n"));
  }

  // ---------- Clients ----------

  function setClientPanel(mode) {
    show($("client-loading"), mode === "loading");
    show($("client-error"), mode === "error");
    show($("client-empty"), mode === "empty");
    show($("client-list"), mode === "table");
  }

  function loadClients() {
    setClientPanel("loading");
    api("GET", "/admin/clients")
      .then(function (data) {
        var clients = (data && data.clients) || [];
        state.clients = clients;
        if (!clients.length) {
          setClientPanel("empty");
          return;
        }
        setClientPanel("table");
        var wrap = $("client-list");
        clear(wrap);
        wrap.appendChild(renderClientTable(clients));
      })
      .catch(function (err) {
        setClientPanel("error");
        setText($("client-error-msg"), err.message || "加载失败");
      });
  }

  function renderClientTable(clients) {
    var table = el("table", "data-table");
    var thead = el("thead");
    var hr = el("tr");
    ["名称", "编号", "前缀", "创建时间", "状态", ""].forEach(function (h) {
      hr.appendChild(el("th", "", h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    clients.forEach(function (c) {
      var tr = el("tr");
      tr.appendChild(el("td", "", c.name || "—"));
      var idTd = el("td");
      idTd.appendChild(el("code", "", shortId(c.id)));
      tr.appendChild(idTd);
      var prefTd = el("td");
      prefTd.appendChild(el("code", "", c.prefix || "—"));
      tr.appendChild(prefTd);
      tr.appendChild(el("td", "", fmtTime(c.created_at)));
      var st = el("td");
      st.appendChild(
        el("span", "badge " + (c.disabled ? "badge-off" : "badge-ok"), c.disabled ? "已停用" : "可用")
      );
      tr.appendChild(st);

      var act = el("td", "col-actions");
      var copyCfg = el("button", "btn btn-sm", "复制配置");
      copyCfg.type = "button";
      copyCfg.addEventListener("click", function () {
        copyClientConfig(c);
      });
      act.appendChild(copyCfg);
      var toggle = el("button", "btn btn-sm", c.disabled ? "启用" : "停用");
      toggle.type = "button";
      toggle.addEventListener("click", function () {
        var nextDisabled = !c.disabled;
        var label = nextDisabled ? "停用" : "启用";
        if (nextDisabled && !confirm("确认" + label + "客户端密钥 " + (c.name || c.id) + " ？停用后下游将无法鉴权。")) {
          return;
        }
        toggle.disabled = true;
        api("POST", "/admin/clients/" + encodeURIComponent(c.id) + "/disable", { disabled: nextDisabled })
          .then(function () {
            toast("已" + label, "ok");
            loadClients();
          })
          .catch(function (err) {
            toast(label + "失败: " + err.message, "err");
          })
          .finally(function () {
            toggle.disabled = false;
          });
      });
      act.appendChild(toggle);
      var del = el("button", "btn btn-sm btn-danger", "删除");
      del.type = "button";
      del.addEventListener("click", function () {
        if (!confirm("确认吊销客户端密钥 " + (c.name || c.id) + " ？下游将无法鉴权。")) return;
        del.disabled = true;
        api("DELETE", "/admin/clients/" + encodeURIComponent(c.id))
          .then(function () {
            toast("已删除客户端密钥", "ok");
            loadClients();
          })
          .catch(function (err) {
            toast("删除失败: " + err.message, "err");
          })
          .finally(function () {
            del.disabled = false;
          });
      });
      act.appendChild(del);
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function copyClientConfig(c) {
    // Without plaintext we can only copy placeholder-based snippets.
    renderIntegration();
    copyIntegration();
  }

  function openCreateClientModal() {
    var body = el("div", "stack");
    var field = el("label", "field");
    field.appendChild(el("span", "label", "名称（可选）"));
    var input = el("input");
    input.type = "text";
    input.placeholder = "例如：claude-code-本机";
    field.appendChild(input);
    body.appendChild(field);

    var cancel = el("button", "btn", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", closeModal);

    var ok = el("button", "btn btn-primary", "创建");
    ok.type = "button";
    ok.addEventListener("click", function () {
      ok.disabled = true;
      api("POST", "/admin/clients", { name: (input.value || "").trim() })
        .then(function (data) {
          var plain = (data && (data.plaintext || data.api_key)) || "";
          showOncePlaintext(plain, data && data.client);
          loadClients();
        })
        .catch(function (err) {
          toast("创建失败: " + err.message, "err");
        })
        .finally(function () {
          ok.disabled = false;
        });
    });

    openModal("创建客户端密钥", body, [cancel, ok]);
  }

  function showOncePlaintext(plain, client) {
    var body = el("div", "stack");
    body.appendChild(
      el("div", "warn-note", "明文 API Key 仅此一次展示，关闭后无法再次查看。请立即复制保存。")
    );
    if (client && client.name) body.appendChild(el("div", "muted", "名称: " + client.name));
    body.appendChild(el("div", "plaintext-box", plain || "（空）"));

    var origin = location.origin || "http://127.0.0.1:8080";
    var anthropic =
      'export ANTHROPIC_BASE_URL="' + origin + '"\n' + 'export ANTHROPIC_AUTH_TOKEN="' + plain + '"';
    var openai =
      'export OPENAI_BASE_URL="' + origin + '/v1"\n' + 'export OPENAI_API_KEY="' + plain + '"';
    body.appendChild(el("span", "label", "Claude Code 配置"));
    body.appendChild(el("pre", "code", anthropic));
    body.appendChild(el("span", "label", "OpenAI 配置"));
    body.appendChild(el("pre", "code", openai));

    var copy = el("button", "btn btn-primary", "复制密钥");
    copy.type = "button";
    copy.addEventListener("click", function () {
      copyText(plain).then(
        function () {
          toast("已复制", "ok");
        },
        function () {
          toast("复制失败，请手动选择", "err");
        }
      );
    });
    var copyAll = el("button", "btn", "复制完整配置");
    copyAll.type = "button";
    copyAll.addEventListener("click", function () {
      copyText(anthropic + "\n\n" + openai).then(
        function () {
          toast("已复制配置", "ok");
        },
        function () {
          toast("复制失败", "err");
        }
      );
    });
    var close = el("button", "btn", "我已保存");
    close.type = "button";
    close.addEventListener("click", closeModal);
    openModal("客户端密钥", body, [copy, copyAll, close]);
  }

  // ---------- Runtime settings ----------

  function markSettingsDirty() {
    state.settingsDirty = true;
    if (state.settingsSaveHint) {
      setText(state.settingsSaveHint, "有未保存的修改");
      state.settingsSaveHint.className = "warn-note";
    }
  }

  function clearSettingsDirty(savedAt) {
    state.settingsDirty = false;
    if (state.settingsSaveHint) {
      setText(state.settingsSaveHint, savedAt ? "已保存于 " + savedAt : "");
      state.settingsSaveHint.className = "muted small";
    }
  }

  function loadSettings() {
    var host = $("settings-body");
    if (!host) return;
    if (state.settingsDirty && !confirm("有未保存的修改，重新加载将丢弃。继续？")) {
      return;
    }
    clear(host);
    host.appendChild(el("p", "muted", "加载运行设置…"));
    api("GET", "/admin/settings")
      .then(function (settings) {
        state.settings = settings;
        state.settingsDirty = false;
        clear(host);
        host.appendChild(renderSettings(settings || {}));
      })
      .catch(function (err) {
        clear(host);
        var panel = el("div", "error-panel");
        panel.appendChild(el("h3", "", "设置加载失败"));
        panel.appendChild(el("p", "muted", err.message || "未知错误"));
        var retry = el("button", "btn btn-primary", "重试");
        retry.type = "button";
        retry.addEventListener("click", loadSettings);
        panel.appendChild(retry);
        host.appendChild(panel);
      });
  }

  function renderSettings(settings) {
    var wrap = el("div", "stack");
    var globalProxy = settings.global_proxy || {};
    var converter = settings.sso_converter || {};
    var inspection = settings.inspection || {};
    state.settingsSaveHint = el("p", "muted small", "");
    wrap.appendChild(state.settingsSaveHint);

    var tabs = el("div", "settings-tabs");
    tabs.setAttribute("role", "tablist");
    var paneProxy = el("div", "settings-pane");
    var paneSSO = el("div", "settings-pane hidden");
    var paneInspect = el("div", "settings-pane hidden");
    var panes = { proxy: paneProxy, sso: paneSSO, inspection: paneInspect };
    var tabButtons = {};

    function switchTab(name) {
      Object.keys(panes).forEach(function (key) {
        show(panes[key], key === name);
        if (tabButtons[key]) {
          tabButtons[key].classList.toggle("active", key === name);
          tabButtons[key].setAttribute("aria-selected", key === name ? "true" : "false");
        }
      });
    }

    [
      ["proxy", "出站代理"],
      ["sso", "SSO 转换"],
      ["inspection", "自动巡检"],
    ].forEach(function (item, idx) {
      var btn = el("button", "btn btn-sm settings-tab" + (idx === 0 ? " active" : ""), item[1]);
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", idx === 0 ? "true" : "false");
      btn.addEventListener("click", function () {
        switchTab(item[0]);
      });
      tabButtons[item[0]] = btn;
      tabs.appendChild(btn);
    });
    wrap.appendChild(tabs);

    paneProxy.appendChild(el("h3", "", "全局出站代理"));
    var proxyMode = settingSelect(
      "代理模式",
      [
        ["environment", "读取 HTTP(S)_PROXY 环境变量"],
        ["direct", "强制直连"],
        ["url", "固定代理 URL"],
      ],
      globalProxy.mode || "environment"
    );
    proxyMode.input.addEventListener("change", markSettingsDirty);
    paneProxy.appendChild(proxyMode.field);
    if (globalProxy.url) paneProxy.appendChild(el("p", "muted", "当前：" + globalProxy.url));
    var proxyURL = settingInput(
      "新代理 URL",
      "password",
      "http://user:pass@host:port 或 socks5h://host:port"
    );
    proxyURL.input.addEventListener("input", markSettingsDirty);
    paneProxy.appendChild(proxyURL.field);

    paneSSO.appendChild(el("h3", "", "SSO 转换服务"));
    var converterEnabled = settingCheckbox("启用 SSO 文件转换", !!converter.enabled);
    var converterEndpoint = settingInput("服务端点", "url", "https://converter.example");
    converterEndpoint.input.value = converter.endpoint || "";
    var converterKey = settingInput("API Key（留空保持不变）", "password", "转换服务 API Key");
    var converterClear = settingCheckbox("清除已保存的 API Key", false);
    var converterInsecure = settingCheckbox(
      "允许明文 HTTP（仅可信容器网络）",
      !!converter.allow_insecure_http
    );
    var converterTimeout = settingInput("转换超时（秒）", "number");
    converterTimeout.input.value = converter.timeout_sec || 600;
    var converterBatch = settingInput("单批最大 SSO 数", "number");
    converterBatch.input.value = converter.max_batch || 50;
    [
      converterEnabled,
      converterEndpoint,
      converterKey,
      converterClear,
      converterInsecure,
      converterTimeout,
      converterBatch,
    ].forEach(function (item) {
      paneSSO.appendChild(item.field);
      var ev = item.input.type === "checkbox" || item.input.tagName === "SELECT" ? "change" : "input";
      item.input.addEventListener(ev, markSettingsDirty);
    });
    paneSSO.appendChild(
      el("p", "muted", converter.api_key_configured ? "API Key 已配置（不会回显）" : "尚未配置 API Key")
    );

    paneInspect.appendChild(el("h3", "", "凭证自动巡检"));
    var inspectEnabled = settingCheckbox("启用定时巡检", !!inspection.enabled);
    var inspectInterval = settingInput("巡检间隔（秒）", "number");
    inspectInterval.input.value = inspection.interval_sec || 3600;
    var inspectTimeout = settingInput("单账号超时（秒）", "number");
    inspectTimeout.input.value = inspection.timeout_sec || 30;
    var inspectConcurrency = settingInput("并发数", "number");
    inspectConcurrency.input.value = inspection.concurrency || 2;
    var inspectConfirm = settingInput("连续 401 确认次数", "number");
    inspectConfirm.input.value = inspection.confirm_unauthorized || 2;
    var inspectPurge = settingInput("隔离后自动删除（秒，0 表示不删除）", "number");
    inspectPurge.input.value = inspection.purge_after_sec || 0;
    [
      inspectEnabled,
      inspectInterval,
      inspectTimeout,
      inspectConcurrency,
      inspectConfirm,
      inspectPurge,
    ].forEach(function (item) {
      paneInspect.appendChild(item.field);
      var ev = item.input.type === "checkbox" || item.input.tagName === "SELECT" ? "change" : "input";
      item.input.addEventListener(ev, markSettingsDirty);
    });
    paneInspect.appendChild(
      el("p", "muted", "401 经刷新复核后隔离；429 只进入冷却，不会被判定为失效。自动删除为高风险操作。")
    );
    var inspectionStatus = el("p", "muted", "巡检状态加载中…");
    paneInspect.appendChild(inspectionStatus);

    wrap.appendChild(paneProxy);
    wrap.appendChild(paneSSO);
    wrap.appendChild(paneInspect);
    api("GET", "/admin/inspection")
      .then(function (data) {
        if (data.running) setText(inspectionStatus, "巡检正在运行");
        else if (data.has_run && data.last) {
          setText(
            inspectionStatus,
            "上次巡检：" +
              fmtTime(data.last.finished_at) +
              " · 正常 " +
              num(data.last.healthy) +
              " · 隔离 " +
              num(data.last.quarantined) +
              " · 429 " +
              num(data.last.rate_limited)
          );
        } else setText(inspectionStatus, "尚未执行巡检");
      })
      .catch(function () {
        setText(inspectionStatus, "巡检状态不可用");
      });
    var runInspection = el("button", "btn", "立即巡检");
    runInspection.type = "button";
    runInspection.addEventListener("click", function () {
      runInspectionOnce(inspectionStatus, runInspection);
    });
    paneInspect.appendChild(runInspection);

    var save = el("button", "btn btn-primary", "保存运行设置");
    save.type = "button";
    save.addEventListener("click", function () {
      if (num(inspectPurge.input.value) > 0) {
        if (!confirm("已设置隔离后自动删除。确认保存该高风险配置？")) return;
      }
      var payload = {};
      var nextMode = proxyMode.input.value;
      var nextURL = (proxyURL.input.value || "").trim();
      if (nextMode !== (globalProxy.mode || "environment") || nextURL) {
        if (nextMode === "url" && !nextURL) {
          toast("切换固定代理时必须输入完整代理 URL", "err");
          return;
        }
        payload.global_proxy = { mode: nextMode, url: nextURL };
      }
      payload.sso_converter = {
        enabled: converterEnabled.input.checked,
        allow_insecure_http: converterInsecure.input.checked,
        timeout_sec: parseInt(converterTimeout.input.value, 10),
        max_batch: parseInt(converterBatch.input.value, 10),
        clear_api_key: converterClear.input.checked,
      };
      if ((converterEndpoint.input.value || "").trim()) {
        payload.sso_converter.endpoint = converterEndpoint.input.value.trim();
      }
      if ((converterKey.input.value || "").trim()) {
        payload.sso_converter.api_key = converterKey.input.value.trim();
      }
      payload.inspection = Object.assign({}, inspection, {
        enabled: inspectEnabled.input.checked,
        interval_sec: parseInt(inspectInterval.input.value, 10),
        timeout_sec: parseInt(inspectTimeout.input.value, 10),
        concurrency: parseInt(inspectConcurrency.input.value, 10),
        confirm_unauthorized: parseInt(inspectConfirm.input.value, 10),
        purge_after_sec: parseInt(inspectPurge.input.value, 10),
      });
      save.disabled = true;
      api("PUT", "/admin/settings", payload)
        .then(function () {
          proxyURL.input.value = "";
          converterKey.input.value = "";
          toast("运行设置已保存", "ok");
          state.settingsDirty = false;
          clearSettingsDirty(new Date().toLocaleTimeString());
          // Reload without dirty confirm.
          state.settingsDirty = false;
          var host = $("settings-body");
          return api("GET", "/admin/settings").then(function (settings) {
            state.settings = settings;
            if (host) {
              clear(host);
              host.appendChild(renderSettings(settings || {}));
              clearSettingsDirty(new Date().toLocaleTimeString());
            }
          });
        })
        .catch(function (err) {
          toast("设置保存失败: " + err.message, "err");
        })
        .finally(function () {
          save.disabled = false;
        });
    });
    wrap.appendChild(save);
    return wrap;
  }

  function runInspectionOnce(statusNode, btn) {
    if (btn) btn.disabled = true;
    if (statusNode) setText(statusNode, "正在巡检，请稍候…");
    return api("POST", "/admin/inspection/run")
      .then(function (summary) {
        var msg =
          "巡检完成：正常 " +
          num(summary.healthy) +
          " · 隔离 " +
          num(summary.quarantined) +
          " · 429 " +
          num(summary.rate_limited) +
          (summary.mass_failure_guard ? " · 已触发批量故障保护" : "");
        if (statusNode) setText(statusNode, msg);
        toast("巡检完成", "ok");
        recordActivity({ kind: "inspection", title: "凭证巡检完成", detail: msg, ok: true });
        if (state.route === "credentials") loadCredentials();
        if (state.route === "overview") loadOverview();
      })
      .catch(function (err) {
        if (statusNode) setText(statusNode, "巡检失败: " + err.message);
        toast("巡检失败: " + err.message, "err");
        recordActivity({
          kind: "inspection",
          title: "凭证巡检失败",
          detail: err.message || "",
          ok: false,
        });
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function settingInput(label, type, placeholder) {
    var field = el("label", "field");
    field.appendChild(el("span", "label", label));
    var input = el("input");
    input.type = type || "text";
    if (placeholder) input.placeholder = placeholder;
    field.appendChild(input);
    return { field: field, input: input };
  }

  function settingCheckbox(label, checked) {
    var field = el("label", "row gap");
    var input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    field.appendChild(input);
    field.appendChild(el("span", "", label));
    return { field: field, input: input };
  }

  function settingSelect(label, options, selected) {
    var field = el("label", "field");
    field.appendChild(el("span", "label", label));
    var input = el("select");
    options.forEach(function (value) {
      var option = el("option", "", value[1]);
      option.value = value[0];
      option.selected = value[0] === selected;
      input.appendChild(option);
    });
    field.appendChild(input);
    return { field: field, input: input };
  }

  // ---------- System ----------

  function loadSystem() {
    var host = $("system-body");
    if (!host) return;
    clear(host);
    host.appendChild(el("p", "muted", "加载中…"));
    api("GET", "/admin/system")
      .then(function (sys) {
        state.system = sys;
        setText($("shell-version"), (sys && sys.version) || "管理后台");
        updateTopbarStatus(sys);
        clear(host);
        host.appendChild(renderSystem(sys));
      })
      .catch(function (err) {
        clear(host);
        var panel = el("div", "error-panel");
        panel.appendChild(el("h3", "", "加载失败"));
        panel.appendChild(el("p", "muted", err.message || "未知错误"));
        var retry = el("button", "btn btn-primary", "重试");
        retry.type = "button";
        retry.addEventListener("click", loadSystem);
        panel.appendChild(retry);
        host.appendChild(panel);
      });
  }

  function renderSystem(sys) {
    var wrap = el("div", "stack");
    var dl = el("dl", "kv");
    addKV(dl, "版本", sys.version);
    addKV(dl, "监听地址", sys.listen);
    addKV(dl, "数据目录", sys.data_dir);
    addKV(dl, "对话后端", sys.chat_backend);
    if (sys.upstream) {
      addKV(dl, "上游地址", sys.upstream.base_url);
      addKV(dl, "客户端版本", sys.upstream.client_version);
      addKV(dl, "客户端标识", sys.upstream.client_identifier);
      addKV(dl, "User-Agent", sys.upstream.user_agent);
      addKV(dl, "Token 鉴权头", String(!!sys.upstream.token_auth));
    }
    if (sys.anthropic) {
      addKV(dl, "Anthropic 入口", sys.anthropic.enabled ? "已启用" : "已关闭");
    }
    if (sys.pool) {
      var pool = sys.pool;
      addKV(dl, "账号池可用", String(pool.available || 0) + " / " + String(pool.total || 0));
      addKV(dl, "冷却中", pool.cooling || 0);
      addKV(dl, "已禁用", pool.disabled || 0);
      addKV(dl, "令牌已过期", pool.expired || 0);
      addKV(dl, "下次恢复", pool.next_recovery_at ? fmtTime(pool.next_recovery_at) : "—");
      addKV(dl, "最近成功", pool.last_success_at ? fmtTime(pool.last_success_at) : "—");
    }
    if (sys.limits) {
      var lim = sys.limits;
      addKV(dl, "最大请求体", String(lim.MaxBodyBytes != null ? lim.MaxBodyBytes : lim.max_body_bytes || "—"));
      addKV(
        dl,
        "请求超时(秒)",
        String(lim.RequestTimeoutSec != null ? lim.RequestTimeoutSec : lim.request_timeout_sec || "—")
      );
      addKV(dl, "最大并发", String(lim.MaxConcurrent != null ? lim.MaxConcurrent : lim.max_concurrent || "—"));
    }
    wrap.appendChild(dl);

    var raw = el("details");
    raw.appendChild(el("summary", "", "调试：原始 JSON"));
    var pre = el("pre", "code");
    pre.textContent = JSON.stringify(sys, null, 2);
    raw.appendChild(pre);
    wrap.appendChild(raw);
    return wrap;
  }

  function addKV(dl, k, v) {
    dl.appendChild(el("dt", "", k));
    dl.appendChild(el("dd", "", v == null || v === "" ? "—" : String(v)));
  }

  // ---------- Integration ----------

  function renderIntegration() {
    var origin = location.origin || "http://127.0.0.1:8080";
    var anthropic =
      'export ANTHROPIC_BASE_URL="' +
      origin +
      '"\n' +
      'export ANTHROPIC_AUTH_TOKEN="<客户端密钥>"';
    var openai =
      'export OPENAI_BASE_URL="' + origin + '/v1"\n' + 'export OPENAI_API_KEY="<客户端密钥>"';
    setText($("snippet-anthropic"), anthropic);
    setText($("snippet-openai"), openai);
  }

  function copyIntegration() {
    var a = ($("snippet-anthropic") && $("snippet-anthropic").textContent) || "";
    var o = ($("snippet-openai") && $("snippet-openai").textContent) || "";
    copyText(a + "\n\n" + o).then(
      function () {
        toast("已复制接入片段", "ok");
      },
      function () {
        toast("复制失败", "err");
      }
    );
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error("复制失败"));
      } catch (e) {
        reject(e);
      }
    });
  }

  // ---------- Wire events ----------

  function bind() {
    applyTheme(themePref());
    applyDensity(densityPref());
    try {
      if (window.matchMedia) {
        matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
          if (themePref() === "system") applyTheme("system");
        });
      }
    } catch (_) {}

    var themeSeg = $("theme-seg");
    if (themeSeg) {
      themeSeg.addEventListener("click", function (e) {
        var t = e.target && e.target.closest ? e.target.closest("[data-theme-pref]") : null;
        if (!t) return;
        applyTheme(t.getAttribute("data-theme-pref"));
      });
    }
    var densitySeg = $("density-seg");
    if (densitySeg) {
      densitySeg.addEventListener("click", function (e) {
        var t = e.target && e.target.closest ? e.target.closest("[data-density-pref]") : null;
        if (!t) return;
        applyDensity(t.getAttribute("data-density-pref"));
      });
    }
    var sideToggle = $("btn-sidebar-toggle");
    if (sideToggle) {
      sideToggle.addEventListener("click", function () {
        setSidebarOpen(!document.body.classList.contains("sidebar-open"));
      });
    }
    var sideBackdrop = $("sidebar-backdrop");
    if (sideBackdrop) {
      sideBackdrop.addEventListener("click", function () {
        setSidebarOpen(false);
      });
    }

    var loginForm = $("login-form");
    if (loginForm) {
      loginForm.addEventListener("submit", function (e) {
        e.preventDefault();
        login(($("login-key") && $("login-key").value) || "");
      });
    }

    var logoutBtn = $("btn-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", function () {
      logout(false);
    });

    var credRefresh = $("btn-cred-refresh-list");
    if (credRefresh) credRefresh.addEventListener("click", loadCredentials);

    var pageQuota = $("btn-page-quota");
    if (pageQuota) pageQuota.addEventListener("click", loadVisiblePageQuota);

    var btnRetry = $("btn-cred-retry");
    if (btnRetry) btnRetry.addEventListener("click", loadCredentials);

    var selectAll = $("cred-select-all");
    if (selectAll) {
      selectAll.addEventListener("change", function () {
        var rows = document.querySelectorAll("#cred-tbody input.cred-check");
        for (var i = 0; i < rows.length; i++) {
          var id = rows[i].closest("tr") && rows[i].closest("tr").dataset.id;
          rows[i].checked = selectAll.checked;
          if (!id) continue;
          if (selectAll.checked) state.selectedIds[id] = true;
          else delete state.selectedIds[id];
        }
        updateBatchBar();
      });
    }
    var batchEnable = $("btn-batch-enable");
    if (batchEnable) {
      batchEnable.addEventListener("click", function () {
        runBatch("批量启用", function (id) {
          return api("POST", "/admin/credentials/" + encodeURIComponent(id) + "/disable", {
            enabled: true,
          }).then(function (updated) {
            if (updated && updated.id) upsertCredentialLocal(updated);
          });
        });
      });
    }
    var batchDisable = $("btn-batch-disable");
    if (batchDisable) {
      batchDisable.addEventListener("click", function () {
        runBatch("批量禁用", function (id) {
          return api("POST", "/admin/credentials/" + encodeURIComponent(id) + "/disable", {
            enabled: false,
          }).then(function (updated) {
            if (updated && updated.id) upsertCredentialLocal(updated);
          });
        });
      });
    }
    var batchRefresh = $("btn-batch-refresh");
    if (batchRefresh) {
      batchRefresh.addEventListener("click", function () {
        runBatch("批量刷新令牌", function (id) {
          return api("POST", "/admin/credentials/" + encodeURIComponent(id) + "/refresh").then(
            function (updated) {
              if (updated && updated.id) upsertCredentialLocal(updated);
            }
          );
        });
      });
    }
    var batchClear = $("btn-batch-clear");
    if (batchClear) batchClear.addEventListener("click", clearSelection);

    var btnClearFilter = $("btn-cred-clear-filter");
    if (btnClearFilter) {
      btnClearFilter.addEventListener("click", function () {
        if ($("cred-search")) $("cred-search").value = "";
        if ($("cred-filter-health")) $("cred-filter-health").value = "all";
        state.credFilter = { q: "", health: "all", sort: state.credFilter.sort, page: 1 };
        applyCredFiltersAndRender();
      });
    }

    var searchTimer = null;
    var searchNode = $("cred-search");
    if (searchNode) {
      searchNode.addEventListener("input", function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          searchTimer = null;
          applyCredFiltersAndRender();
        }, 280);
      });
    }
    ["cred-filter-health", "cred-sort"].forEach(function (id) {
      var node = $(id);
      if (!node) return;
      node.addEventListener("change", function () {
        applyCredFiltersAndRender();
      });
    });

    var impDef = $("btn-import-default");
    if (impDef) impDef.addEventListener("click", importDefaultGrok);
    var emptyImp = $("btn-empty-import");
    if (emptyImp) emptyImp.addEventListener("click", importDefaultGrok);

    var deviceLogin = $("btn-device-login");
    if (deviceLogin) deviceLogin.addEventListener("click", startDeviceLogin);
    var emptyDevice = $("btn-empty-device");
    if (emptyDevice) emptyDevice.addEventListener("click", startDeviceLogin);

    var impRaw = $("btn-import-raw");
    if (impRaw) impRaw.addEventListener("click", openImportRawModal);

    var clientRefresh = $("btn-client-refresh");
    if (clientRefresh) clientRefresh.addEventListener("click", loadClients);
    var clientRetry = $("btn-client-retry");
    if (clientRetry) clientRetry.addEventListener("click", loadClients);
    var clientCreate = $("btn-client-create");
    if (clientCreate) clientCreate.addEventListener("click", openCreateClientModal);
    var emptyClient = $("btn-empty-client-create");
    if (emptyClient) emptyClient.addEventListener("click", openCreateClientModal);

    var sysRefresh = $("btn-system-refresh");
    if (sysRefresh) sysRefresh.addEventListener("click", loadSystem);
    var settingsRefresh = $("btn-settings-refresh");
    if (settingsRefresh) settingsRefresh.addEventListener("click", loadSettings);
    var copyInt = $("btn-copy-integration");
    if (copyInt) copyInt.addEventListener("click", copyIntegration);

    var overviewRefresh = $("btn-overview-refresh");
    if (overviewRefresh) overviewRefresh.addEventListener("click", loadOverview);
    var overviewAdd = $("btn-overview-add");
    if (overviewAdd) {
      overviewAdd.addEventListener("click", function () {
        navigate("credentials");
        startDeviceLogin();
      });
    }
    var overviewInspect = $("btn-overview-inspect");
    if (overviewInspect) {
      overviewInspect.addEventListener("click", function () {
        runInspectionOnce(null, overviewInspect);
      });
    }

    var crisisView = $("btn-crisis-view");
    if (crisisView) {
      crisisView.addEventListener("click", function () {
        state.credFilter.health = "problem";
        state.credFilter.page = 1;
        if ($("cred-filter-health")) $("cred-filter-health").value = "problem";
        navigate("credentials");
      });
    }

    window.addEventListener("beforeunload", function (e) {
      if (!state.settingsDirty) return;
      e.preventDefault();
      e.returnValue = "";
    });
    var crisisDismiss = $("btn-crisis-dismiss");
    if (crisisDismiss) {
      crisisDismiss.addEventListener("click", function () {
        state.crisisDismissed = true;
        show($("crisis-banner"), false);
      });
    }

    var modalClose = $("modal-close");
    if (modalClose) modalClose.addEventListener("click", closeModal);
    var modal = $("modal");
    if (modal) {
      modal.addEventListener("click", function (e) {
        if (e.target && e.target.getAttribute("data-close") === "1") closeModal();
      });
    }

    var drawerClose = $("drawer-close");
    if (drawerClose) drawerClose.addEventListener("click", closeDrawer);
    var drawer = $("drawer");
    if (drawer) {
      drawer.addEventListener("click", function (e) {
        if (e.target && e.target.getAttribute("data-drawer-close") === "1") closeDrawer();
      });
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if ($("modal") && !$("modal").classList.contains("hidden")) closeModal();
        else if ($("drawer") && !$("drawer").classList.contains("hidden")) closeDrawer();
        else if (document.body.classList.contains("sidebar-open")) setSidebarOpen(false);
      }
    });

    window.addEventListener("hashchange", render);
  }

  function boot() {
    bind();
    state.key = loadSession();
    if (state.key) {
      api("GET", "/admin/system")
        .then(function (sys) {
          state.system = sys;
          setText($("shell-version"), (sys && sys.version) || "管理后台");
          updateTopbarStatus(sys);
          if (!location.hash || location.hash === "#" || location.hash === "#/" || location.hash === "#/login") {
            navigate("overview");
          }
          render();
        })
        .catch(function () {
          clearSession();
          navigate("login");
          render();
        });
    } else {
      if (!location.hash || location.hash === "#" || location.hash === "#/credentials" || location.hash === "#/overview") {
        navigate("login");
      }
      render();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
