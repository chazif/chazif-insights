// Client-aware chrome + complexity profile. Runs after app.js + admin.js.
// If the bundle has no `meta` (e.g. the Mavis demo), everything is left as-is.
(function () {
  "use strict";
  // Stay signed in for the session: once authed, every reload (date/client change)
  // auto-enters the dashboard instead of re-showing the login gate.
  try {
    if (sessionStorage.getItem("chz_authed") === "1" || sessionStorage.getItem("chz_nav") === "1") {
      sessionStorage.removeItem("chz_nav");
      sessionStorage.setItem("chz_authed", "1");
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

  var FILTER_KEYS = ["seg", "campaign", "region", "category", "brand"];
  function setText(id, txt) { var e = document.getElementById(id); if (e && txt) e.textContent = txt; }

  // ---- chrome (re-applied after every in-place refresh) ----
  function applyChrome() {
    var name = META.name || "";
    var cur = (META.periods || {}).current || "";
    setText("crumbClient", name);
    setText("footClient", name);
    setText("periodPill", name || cur);   // the top-bar pill shows the client name
    setText("footPeriod", cur);
    setText("brandSub", [name, cur].filter(Boolean).join(" · "));
    setText("gateSub", "Client portal" + (name ? " · " + name : "") + (cur ? " · " + cur + " report" : ""));
    if (name) document.title = "SearchNex AE · " + name;
  }
  applyChrome();

  // ---- in-place refresh: swap the bundle contents and re-render, no page reload ----
  function setBusy(on) {
    if (!document.getElementById("chzBusyStyle")) {
      var st = document.createElement("style"); st.id = "chzBusyStyle";
      st.textContent =
        "#chzBusy{position:fixed;inset:0;background:rgba(252,252,250,.5);z-index:900;display:none;" +
        "align-items:flex-start;justify-content:center;padding-top:140px;backdrop-filter:saturate(.9)}" +
        "#chzBusy .chz-sp{width:26px;height:26px;border:3px solid #e2e2da;border-top-color:#1a1a1a;" +
        "border-radius:50%;animation:chzspin .7s linear infinite}" +
        "@keyframes chzspin{to{transform:rotate(360deg)}}";
      document.head.appendChild(st);
    }
    var el = document.getElementById("chzBusy");
    if (!el) {
      el = document.createElement("div"); el.id = "chzBusy";
      el.innerHTML = '<div class="chz-sp"></div>';
      document.body.appendChild(el);
    }
    el.style.display = on ? "flex" : "none";
  }

  function bundleUrl(params) {
    var period = params.get("period") || "2026-03";
    var from = params.get("from"), to = params.get("to");
    var extra = FILTER_KEYS.map(function (k) {
      var v = params.get(k);
      return (v && v !== "all") ? "&" + k + "=" + encodeURIComponent(v) : "";
    }).join("");
    var cmp = "";
    ["compare", "cfrom", "cto"].forEach(function (k) {
      var v = params.get(k);
      if (v) cmp += "&" + k + "=" + encodeURIComponent(v);
    });
    return "/api/bundle?client=" + encodeURIComponent(META.client_id) + "&period=" + encodeURIComponent(period) +
      (from ? "&from=" + encodeURIComponent(from) : "") + (to ? "&to=" + encodeURIComponent(to) : "") + extra + cmp;
  }

  function refresh(params) {
    setBusy(true);
    try { history.replaceState(null, "", location.pathname + "?" + params.toString()); } catch (e) {}
    fetch(bundleUrl(params))
      .then(function (r) { if (!r.ok) throw new Error("bundle HTTP " + r.status); return r.json(); })
      .then(function (d) {
        // keep the same object identity — app.js holds `const DATA = window.__BUNDLE__`
        var B = window.__BUNDLE__;
        Object.keys(B).forEach(function (k) { delete B[k]; });
        Object.keys(d).forEach(function (k) { B[k] = d[k]; });
        META = B.meta || META;
        applyChrome(); renderFilters(); renderDateRange();
        var v = (typeof CURRENT_VIEW !== "undefined" && CURRENT_VIEW) ? CURRENT_VIEW : "overview";
        if (typeof setView === "function") setView(v, { preserveScroll: true });
      })
      .catch(function (e) { console.error("filter refresh failed:", e); })
      .then(function () { setBusy(false); });
  }
  // let other scripts (e.g. Budget Input) trigger an in-place bundle refresh
  window.chzRefresh = function () { refresh(new URLSearchParams(location.search)); };

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
  function renderDateRange() {
    var host = document.getElementById("dateRange");
    if (!host || !META.client_id) return;
    var params = new URLSearchParams(location.search);
    var curFrom = params.get("from") || "", curTo = params.get("to") || "";
    var cmpMode = params.get("compare") || "yoy";
    var cmpFrom = params.get("cfrom") || "", cmpTo = params.get("cto") || "";
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var ymd = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
    var now = new Date();
    var addDays = function (base, n) { var d = new Date(base); d.setDate(d.getDate() + n); return d; };
    var Y = now.getFullYear(), M = now.getMonth();
    var yst = addDays(now, -1);
    var monthFirst = new Date(Y, M, 1);
    var lmFirst = new Date(M === 0 ? Y - 1 : Y, M === 0 ? 11 : M - 1, 1);   // first of last month
    var lmLast = new Date(Y, M, 0);                                        // last of last month
    var sunday = addDays(now, -now.getDay());                              // most recent Sunday (0=Sun)
    var lwEnd = addDays(sunday, -1);                                       // Sat before this Sunday
    var lwStart = addDays(lwEnd, -6);
    // Requested order: MTD, Last Month, YTD; then the Google-Ads-style presets.
    var presets = {
      mtd: { label: "MTD (month to date)", from: ymd(monthFirst), to: ymd(now) },
      lastmonth: { label: "Last month", from: ymd(lmFirst), to: ymd(lmLast) },
      ytd: { label: "YTD (year to date)", from: Y + "-01-01", to: ymd(now) },
      today: { label: "Today", from: ymd(now), to: ymd(now) },
      yesterday: { label: "Yesterday", from: ymd(yst), to: ymd(yst) },
      thisweek: { label: "This week (Sun – Today)", from: ymd(sunday), to: ymd(now) },
      last7: { label: "Last 7 days", from: ymd(addDays(now, -7)), to: ymd(yst) },
      lastweek: { label: "Last week (Sun – Sat)", from: ymd(lwStart), to: ymd(lwEnd) },
      last14: { label: "Last 14 days", from: ymd(addDays(now, -14)), to: ymd(yst) },
      last30: { label: "Last 30 days", from: ymd(addDays(now, -30)), to: ymd(yst) },
      all: { label: "All time", from: "", to: "" },
    };
    var curKey = (!curFrom && !curTo) ? "all" : "custom";
    for (var k in presets) { if (presets[k].from === curFrom && presets[k].to === curTo) { curKey = k; break; } }
    var opts = Object.keys(presets).map(function (k) {
      return '<option value="' + k + '"' + (k === curKey ? " selected" : "") + ">" + presets[k].label + "</option>";
    }).join("") +
      '<option value="days"' + (curKey === "custom" ? "" : "") + ">Last N days…</option>" +
      '<option value="custom"' + (curKey === "custom" ? " selected" : "") + ">Custom range…</option>";
    host.innerHTML =
      "<label>Dates</label><select id=\"drSel\">" + opts + "</select>" +
      '<span id="drCustom" style="display:' + (curKey === "custom" ? "flex" : "none") + ';gap:6px;align-items:center">' +
        '<input type="date" id="drFrom" value="' + curFrom + '"><input type="date" id="drTo" value="' + curTo + '">' +
        '<button class="dr-apply" id="drApply">Apply</button></span>' +
      '<span id="drDays" style="display:none;gap:6px;align-items:center">Last <input type="number" id="drNdays" value="30" min="1" style="width:58px"> days up to <select id="drUpto"><option value="today">today</option><option value="yesterday" selected>yesterday</option></select><button class="dr-apply" id="drDaysApply">Apply</button></span>' +
      '<span class="dr-info" title="The date range applies to the campaign-time-series views — Overview, Monthly Trends, Campaign Performance, Pacing, NB Categories and Regions. The other reports (Keyword, QS, Search Terms, Ad Copy, Landing Pages, Geo) arrive as a single whole-window export with no per-row date, so they always show the full window until date-segmented (daily) exports are uploaded.">&#9432; time-series only</span>' +
      // ---- VS comparison (YoY / MoM / Custom) ----
      '<span class="dr-vs" style="display:inline-flex;align-items:center;gap:6px;margin-left:16px">' +
        '<label>VS</label><span class="gf-seg-group">' +
        ["yoy", "mom", "custom"].map(function (m) {
          return '<button class="gf-seg' + (cmpMode === m ? " active" : "") + '" data-vs="' + m + '">' +
            { yoy: "YoY", mom: "MoM", custom: "Custom" }[m] + "</button>";
        }).join("") + "</span>" +
        '<span id="vsCustom" style="display:' + (cmpMode === "custom" ? "inline-flex" : "none") + ';gap:6px;align-items:center">' +
          '<input type="month" id="vsFrom" value="' + cmpFrom + '"><input type="month" id="vsTo" value="' + cmpTo + '">' +
          '<button class="dr-apply" id="vsApply">Apply</button></span>' +
      "</span>";
    function go(from, to) {
      var u = new URLSearchParams(location.search);
      u.set("client", META.client_id);
      if (from) u.set("from", from); else u.delete("from");
      if (to) u.set("to", to); else u.delete("to");
      refresh(u);
    }
    function setCompare(mode, cf, ct) {
      var u = new URLSearchParams(location.search);
      u.set("client", META.client_id);
      if (mode && mode !== "yoy") u.set("compare", mode); else u.delete("compare");
      if (mode === "custom" && cf) u.set("cfrom", cf); else u.delete("cfrom");
      if (mode === "custom" && ct) u.set("cto", ct); else u.delete("cto");
      refresh(u);
    }
    document.getElementById("drSel").addEventListener("change", function () {
      document.getElementById("drCustom").style.display = this.value === "custom" ? "flex" : "none";
      document.getElementById("drDays").style.display = this.value === "days" ? "inline-flex" : "none";
      if (this.value === "custom" || this.value === "days") return;   // wait for that control's Apply
      var pr = presets[this.value]; go(pr.from, pr.to);
    });
    document.getElementById("drApply").addEventListener("click", function () {
      go(document.getElementById("drFrom").value, document.getElementById("drTo").value);
    });
    document.getElementById("drDaysApply").addEventListener("click", function () {
      var n = Math.max(1, parseInt(document.getElementById("drNdays").value, 10) || 1);
      var end = document.getElementById("drUpto").value === "today" ? now : yst;
      go(ymd(addDays(end, -(n - 1))), ymd(end));
    });
    host.querySelectorAll("[data-vs]").forEach(function (b) {
      b.addEventListener("click", function () {
        var m = b.dataset.vs;
        if (m === "custom") {   // reveal the range inputs; apply commits it
          host.querySelectorAll("[data-vs]").forEach(function (x) { x.classList.toggle("active", x === b); });
          document.getElementById("vsCustom").style.display = "inline-flex";
          return;
        }
        setCompare(m);
      });
    });
    var vsApply = document.getElementById("vsApply");
    if (vsApply) vsApply.addEventListener("click", function () {
      setCompare("custom", document.getElementById("vsFrom").value, document.getElementById("vsTo").value);
    });
  }
  renderDateRange();

  // ---- global filter bar (All/BR/NB buttons + Campaign/Region/Category/Brand dropdowns) ----
  function renderFilters() {
    var host = document.getElementById("globalFilters");
    if (!host || !META.client_id || !META.filters_meta) return;   // computed clients only
    var fm = META.filters_meta || {};
    var cur = META.filters || {};
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    if (!document.getElementById("gfStyle")) {
      var st = document.createElement("style"); st.id = "gfStyle";
      st.textContent =
        ".global-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap}" +
        ".gf-seg-group{display:inline-flex;border:1px solid var(--line,#e6e6e0);border-radius:8px;overflow:hidden}" +
        ".gf-seg{border:0;background:#fff;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;color:var(--grey,#666)}" +
        ".gf-seg.active{background:var(--ink,#1a1a1a);color:var(--lime,#CFFF04)}" +
        ".gf-ctl{display:inline-flex;align-items:center;gap:5px}" +
        ".gf-lbl{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--grey,#888)}" +
        ".gf-sel{font-size:12px;padding:5px 7px;border:1px solid var(--line,#e6e6e0);border-radius:7px;background:#fff;max-width:180px}";
      document.head.appendChild(st);
    }
    function go(k, v) {
      var u = new URLSearchParams(location.search);
      u.set("client", META.client_id);
      if (v && v !== "all") u.set(k, v); else u.delete(k);
      refresh(u);
    }
    var seg = cur.seg || "all";
    var segBtns = [["all", "All"], ["br", "BR"], ["nb", "NB"]].map(function (o) {
      return '<button class="gf-seg' + (seg === o[0] ? " active" : "") + '" data-seg="' + o[0] + '">' + o[1] + "</button>";
    }).join("");
    function dd(key, label, opts, curv) {
      var options = '<option value="all">All</option>' + (opts || []).map(function (o) {
        return '<option value="' + esc(o) + '"' + (curv === o ? " selected" : "") + ">" + esc(o) + "</option>";
      }).join("");
      return '<span class="gf-ctl"><span class="gf-lbl">' + label + '</span><select class="gf-sel" data-key="' + key + '">' + options + "</select></span>";
    }
    host.innerHTML =
      '<span class="gf-ctl"><span class="gf-lbl">Segment</span><span class="gf-seg-group">' + segBtns + "</span></span>" +
      dd("campaign", "Campaign", fm.campaigns, cur.campaign) +
      dd("region", "Region", fm.regions, cur.region) +
      dd("category", "Category", fm.categories, cur.category) +
      dd("brand", "Brand", fm.brands, cur.brand);
    host.querySelectorAll("[data-seg]").forEach(function (b) { b.addEventListener("click", function () { go("seg", b.dataset.seg); }); });
    host.querySelectorAll(".gf-sel").forEach(function (s) { s.addEventListener("change", function () { go(s.dataset.key, s.value); }); });
    // our server-side Brand filter replaces the static demo brand switcher
    var bf = document.getElementById("brandFilter"); if (bf) bf.style.display = "none";
  }
  renderFilters();

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
