// Extra dashboard views for computed clients (Campaign Performance, Geo, Budget).
// Loaded after app.js; registers into its `views`/`labels`, and inserts nav items
// only for the views this bundle actually populates (meta.views).
(function () {
  "use strict";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const chgCell = v => {
    if (v == null) return '<td class="num">—</td>';
    const cls = v >= 0 ? "up" : "dn";
    return `<td class="num chg ${cls}">${(v >= 0 ? "+" : "") + (v * 100).toFixed(0)}%</td>`;
  };

  // ---------- Campaign Performance ----------
  function renderCampaignPerf(el) {
    el.className = "view";
    const cp = (typeof DATA !== "undefined" && DATA.campaigns) || null;
    if (!cp || !cp.rows || !cp.rows.length) {
      el.innerHTML = `<div class="view-head"><div><h2>Campaign Performance</h2></div></div><div class="panel">No campaign data.</div>`;
      return;
    }
    const body = cp.rows.map(r => `<tr>
        <td class="strong">${esc(r.campaign)}</td>
        <td>${esc(r.type)}</td>
        <td class="num" data-sort="${r.clicks}">${fmt.num(r.clicks)}</td>
        <td class="num" data-sort="${r.cost}">${fmt.money(r.cost)}</td>
        <td class="num" data-sort="${r.conv}">${fmt.num(r.conv, 1)}</td>
        <td class="num" data-sort="${r.cpa}">${fmt.money(r.cpa, 2)}</td>
        <td class="num" data-sort="${r.cvr}">${fmt.pct(r.cvr, 2)}</td>
        <td class="num" data-sort="${r.share}">${(r.share * 100).toFixed(0)}%</td>
        ${chgCell(r.d_conv)}</tr>`).join("");
    el.innerHTML = `
      <div class="view-head"><div><h2>Campaign Performance</h2>
        <div class="muted">${esc(cp.month)} snapshot · Δ Conv vs ${esc(cp.prior_month)}</div></div></div>
      <div class="panel"><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>Campaign</th><th>Type</th><th class="num">Clicks</th><th class="num">Cost</th>
          <th class="num">Conv</th><th class="num">CPA</th><th class="num">CVR</th>
          <th class="num">% Spend</th><th class="num">Δ Conv</th></tr></thead>
        <tbody>${body}
          <tr class="strong"><td>Account total</td><td></td>
            <td class="num">${fmt.num(cp.totals.clicks)}</td>
            <td class="num">${fmt.money(cp.totals.cost)}</td>
            <td class="num">${fmt.num(cp.totals.conv, 1)}</td>
            <td></td><td></td><td class="num">100%</td><td></td></tr>
        </tbody></table></div></div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Geo Performance ----------
  function renderGeoPerf(el) {
    el.className = "view";
    const g = (typeof DATA !== "undefined" && DATA.geo_performance) || null;
    if (!g || !g.rows || !g.rows.length) {
      el.innerHTML = `<div class="view-head"><div><h2>Geo Performance</h2></div></div><div class="panel">No geographic data.</div>`;
      return;
    }
    const body = g.rows.map(r => `<tr>
        <td class="strong">${esc(r.location)}</td>
        <td class="num" data-sort="${r.clicks}">${fmt.num(r.clicks)}</td>
        <td class="num" data-sort="${r.impr}">${fmt.num(r.impr)}</td>
        <td class="num" data-sort="${r.ctr}">${fmt.pct(r.ctr, 2)}</td>
        <td class="num" data-sort="${r.conv}">${fmt.num(r.conv, 1)}</td>
        <td class="num" data-sort="${r.conv_value}">${fmt.money(r.conv_value)}</td>
        <td class="num" data-sort="${r.cost}">${fmt.money(r.cost)}</td>
        <td class="num" data-sort="${r.cpa}">${fmt.money(r.cpa, 2)}</td></tr>`).join("");
    const t = g.totals || {};
    el.innerHTML = `
      <div class="view-head"><div><h2>Geo Performance</h2>
        <div class="muted">By ${esc(g.dimension)} · cost derived from CPA×conv (Geographic export carries no cost column)</div></div></div>
      <div class="panel"><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>${esc(g.dimension)}</th><th class="num">Clicks</th><th class="num">Impr</th>
          <th class="num">CTR</th><th class="num">Conv</th><th class="num">Conv Value</th>
          <th class="num">Cost*</th><th class="num">CPA</th></tr></thead>
        <tbody>${body}
          <tr class="strong"><td>Total</td>
            <td class="num">${fmt.num(t.clicks)}</td><td class="num">${fmt.num(t.impr)}</td><td></td>
            <td class="num">${fmt.num(t.conv, 1)}</td><td class="num">${fmt.money(t.conv_value)}</td>
            <td class="num">${fmt.money(t.cost)}</td><td></td></tr>
        </tbody></table></div></div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---- register renderers ----
  const REG = {
    "campaign-perf": ["Campaign Performance", renderCampaignPerf],
    "geo-perf": ["Geo Performance", renderGeoPerf],
  };
  Object.keys(REG).forEach(v => { views[v] = REG[v][1]; labels[v] = REG[v][0]; });

  // ---- insert nav items for views this bundle populates, after "Monthly Trends" ----
  const meta = (window.__BUNDLE__ && window.__BUNDLE__.meta) || null;
  if (meta && Array.isArray(meta.views)) {
    const sidebar = document.getElementById("sidebar");
    let anchor = sidebar && sidebar.querySelector('.nav-item[data-view="trends"]');
    ["campaign-perf", "geo-perf"].forEach(v => {
      if (meta.views.indexOf(v) < 0 || !anchor) return;
      const d = document.createElement("div");
      d.className = "nav-item"; d.dataset.view = v;
      d.innerHTML = `<span class="nav-dot"></span>${labels[v]}`;
      d.addEventListener("click", () => setView(v));
      anchor.parentNode.insertBefore(d, anchor.nextSibling);
      anchor = d;  // keep order for subsequent inserts
    });
  }
})();
