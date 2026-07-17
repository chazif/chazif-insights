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
  if (!META) {                                  // pre-baked bundle -> keep original chrome
    var cp0 = document.querySelector(".client-pick");
    if (cp0) cp0.style.display = "none";
    var dr0 = document.getElementById("dateRange");
    if (dr0) dr0.style.display = "none";
    return;
  }

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
  if (name) document.title = "SearchNex AE · " + name;

  // Client selector in the sidebar, under the logo.
  (function () {
    var host = document.getElementById("clientPick");
    if (!host || !META.client_id) return;
    fetch("/api/clients").then(function (r) { return r.json(); }).then(function (list) {
      var withData = (list || []).filter(function (c) { return c.reports_loaded > 0; });
      if (!withData.length) return;
      var opts = withData.map(function (c) {
        var nm = String(c.name || c.client_id).replace(/</g, "&lt;");
        return '<option value="' + c.client_id + '"' + (c.client_id === META.client_id ? " selected" : "") + ">" + nm + "</option>";
      }).join("");
      host.innerHTML = '<select id="clientSel" title="Switch client">' + opts + "</select>";
      document.getElementById("clientSel").addEventListener("change", function () {
        try { sessionStorage.setItem("chz_nav", "1"); } catch (e) {}
        location.href = "/?client=" + encodeURIComponent(this.value);
      });
    }).catch(function () {});
  })();

  // Date-range selector (top bar). Filters time-series views today; whole-window reports
  // honour it once date-segmented data is uploaded.
  (function () {
    var host = document.getElementById("dateRange");
    if (!host || !META.client_id) return;
    var params = new URLSearchParams(location.search);
    var curFrom = params.get("from") || "", curTo = params.get("to") || "";
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var ymd = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
    var now = new Date();
    var monthsAgo = function (n) { var d = new Date(now); d.setMonth(d.getMonth() - n); return d; };
    var presets = {
      all: { label: "All time", from: "", to: "" },
      m3: { label: "Last 3 months", from: ymd(monthsAgo(3)), to: ymd(now) },
      m6: { label: "Last 6 months", from: ymd(monthsAgo(6)), to: ymd(now) },
      m12: { label: "Last 12 months", from: ymd(monthsAgo(12)), to: ymd(now) },
      ytd: { label: "Year to date", from: now.getFullYear() + "-01-01", to: ymd(now) },
    };
    var curKey = (!curFrom && !curTo) ? "all" : "custom";
    for (var k in presets) { if (presets[k].from === curFrom && presets[k].to === curTo) { curKey = k; break; } }
    var opts = Object.keys(presets).map(function (k) {
      return '<option value="' + k + '"' + (k === curKey ? " selected" : "") + ">" + presets[k].label + "</option>";
    }).join("") + '<option value="custom"' + (curKey === "custom" ? " selected" : "") + ">Custom…</option>";
    host.innerHTML =
      "<label>Dates</label><select id=\"drSel\">" + opts + "</select>" +
      '<span id="drCustom" style="display:' + (curKey === "custom" ? "flex" : "none") + ';gap:6px;align-items:center">' +
        '<input type="date" id="drFrom" value="' + curFrom + '"><input type="date" id="drTo" value="' + curTo + '">' +
        '<button class="dr-apply" id="drApply">Apply</button></span>' +
      '<span class="dr-info" title="The date range filters the time-series views (Overview, Monthly Trends, Campaign Performance, Budget & Pacing). Other reports show the full export window until date-segmented daily data is uploaded.">&#9432;</span>';
    function go(from, to) {
      try { sessionStorage.setItem("chz_nav", "1"); } catch (e) {}
      var u = new URLSearchParams(location.search);
      u.set("client", META.client_id);
      if (from) u.set("from", from); else u.delete("from");
      if (to) u.set("to", to); else u.delete("to");
      location.search = u.toString();
    }
    document.getElementById("drSel").addEventListener("change", function () {
      if (this.value === "custom") { document.getElementById("drCustom").style.display = "flex"; return; }
      var pr = presets[this.value]; go(pr.from, pr.to);
    });
    document.getElementById("drApply").addEventListener("click", function () {
      go(document.getElementById("drFrom").value, document.getElementById("drTo").value);
    });
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
