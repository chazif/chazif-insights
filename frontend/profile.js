// Client-aware chrome + complexity profile. Runs after app.js + admin.js.
// If the bundle has no `meta` (e.g. the Mavis demo), everything is left as-is.
(function () {
  "use strict";
  // Auto-skip the demo gate right after an in-app "Open dashboard" navigation.
  try {
    if (sessionStorage.getItem("chz_nav") === "1") {
      sessionStorage.removeItem("chz_nav");
      if (typeof unlock === "function") unlock();
    }
  } catch (e) {}

  var META = (window.__BUNDLE__ && window.__BUNDLE__.meta) || null;
  if (!META) return; // pre-baked bundle -> keep original chrome

  var name = META.name || "";
  var periods = META.periods || {};
  var cur = periods.current || "";
  function setText(id, txt) { var e = document.getElementById(id); if (e && txt) e.textContent = txt; }

  // ---- chrome ----
  setText("crumbClient", name);
  setText("footClient", name);
  setText("periodPill", cur);
  setText("footPeriod", cur);
  setText("brandSub", [name, cur].filter(Boolean).join(" · "));
  setText("gateSub", "Client portal" + (name ? " · " + name : "") + (cur ? " · " + cur + " report" : ""));
  if (name) document.title = "Chazif Insights · " + name;

  // Account selector in the top bar (replaces the client name in the breadcrumb).
  (function () {
    var host = document.getElementById("crumbClient");
    if (!host || !META.client_id) return;
    fetch("/api/clients").then(function (r) { return r.json(); }).then(function (list) {
      var withData = (list || []).filter(function (c) { return c.reports_loaded > 0; });
      if (!withData.length) return;
      var opts = withData.map(function (c) {
        var nm = String(c.name || c.client_id).replace(/</g, "&lt;");
        return '<option value="' + c.client_id + '"' + (c.client_id === META.client_id ? " selected" : "") + ">" + nm + "</option>";
      }).join("");
      host.innerHTML = '<select id="clientSel" title="Switch account" style="background:#fff;border:1px solid var(--line,#e3e7da);border-radius:6px;font:inherit;font-weight:600;font-size:13px;color:var(--ink,#17190f);padding:2px 8px;cursor:pointer;max-width:240px">' + opts + "</select>";
      document.getElementById("clientSel").addEventListener("change", function () {
        try { sessionStorage.setItem("chz_nav", "1"); } catch (e) {}
        location.href = "/?client=" + encodeURIComponent(this.value);
      });
    }).catch(function () {});
  })();

  // ---- single-brand: drop the brand filter (and keep it dropped across views) ----
  var nBrands = (META.complexity && META.complexity.n_brands) || 1;
  if (nBrands <= 1) {
    var bf = document.getElementById("brandFilter");
    if (bf) bf.style.display = "none";
    // setView() re-shows the filter for non-hidden views; mark every populated
    // view hidden-for-brand-filter so it stays gone.
    if (typeof BRAND_FILTER_HIDDEN_VIEWS !== "undefined" && Array.isArray(META.views)) {
      META.views.forEach(function (v) { BRAND_FILTER_HIDDEN_VIEWS.add(v); });
    }
  }

  // ---- hide dashboard views not populated by this bundle ----
  if (Array.isArray(META.views)) {
    var allow = {}; META.views.forEach(function (v) { allow[v] = true; });
    var sidebar = document.getElementById("sidebar");
    if (sidebar) {
      sidebar.querySelectorAll(".nav-item").forEach(function (n) {
        var v = n.dataset.view;
        if (!v || v.indexOf("ws-") === 0) return;      // never touch workspace tabs
        if (!allow[v]) n.style.display = "none";
      });
      // hide section headers whose items are now all hidden
      var kids = Array.prototype.slice.call(sidebar.children);
      for (var i = 0; i < kids.length; i++) {
        if (!kids[i].classList.contains("nav-section")) continue;
        var anyVisible = false;
        for (var j = i + 1; j < kids.length && !kids[j].classList.contains("nav-section"); j++) {
          if (kids[j].classList.contains("nav-item") && kids[j].style.display !== "none") anyVisible = true;
        }
        if (!anyVisible) kids[i].style.display = "none";
      }
    }
  }
})();
