/* Apply theme/density before paint (external for CSP script-src 'self'). */
(function () {
  "use strict";
  try {
    var pref = localStorage.getItem("gb_theme") || "system";
    var dark =
      pref === "dark" ||
      (pref !== "light" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme-pref", pref);
    var density = localStorage.getItem("gb_density") || "comfortable";
    document.documentElement.setAttribute(
      "data-density",
      density === "compact" ? "compact" : "comfortable"
    );
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.setAttribute("data-theme-pref", "system");
    document.documentElement.setAttribute("data-density", "comfortable");
  }
})();
