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
  // YoY % change spans — up-is-good (spend/conv) and down-is-good (CPA, inverted coloring)
  const yoyUp = v => v == null ? '<span class="muted">New</span>' : `<span class="chg ${v >= 0 ? "up" : "dn"}">${(v >= 0 ? "+" : "") + (v * 100).toFixed(1)}%</span>`;
  const yoyDn = v => v == null ? '<span class="muted">—</span>' : `<span class="chg ${v <= 0 ? "up" : "dn"}">${(v >= 0 ? "+" : "") + (v * 100).toFixed(1)}%</span>`;

  // ---- chart helpers (Chart.js is loaded by the page; match the reference style) ----
  const PALETTE = ["#CFFF04", "#1A1A1A", "#2F7D4F", "#dc2626", "#9CA3AF", "#6366f1", "#f59e0b", "#0ea5e9", "#a855f7", "#14b8a6"];
  function donut(id, labels, data) {
    const c = document.getElementById(id);
    if (!c || typeof Chart === "undefined") return;
    new Chart(c, { type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: PALETTE, borderWidth: 1, borderColor: "#fff" }] },
      options: { responsive: true, maintainAspectRatio: true, cutout: "58%",
        plugins: { legend: { position: "right", labels: { color: "#1A1A1A", font: { family: "Inter", size: 11 }, boxWidth: 10, padding: 8 } } } } });
  }
  function bars(id, labels, data, label, color) {
    const c = document.getElementById(id);
    if (!c || typeof Chart === "undefined") return;
    const opt = (typeof chartOpts === "function") ? chartOpts({}) : { responsive: true, maintainAspectRatio: true };
    if (opt.plugins && opt.plugins.legend) opt.plugins.legend.display = false;
    new Chart(c, { type: "bar",
      data: { labels, datasets: [{ label: label || "", data, backgroundColor: color || "#CFFF04", borderColor: "#1A1A1A", borderWidth: 1 }] },
      options: opt });
  }
  // grouped prior-vs-current bars (grey / lime) — matches the reference YoY chart
  function groupedBars(id, labels, prior, cur, priorLabel, curLabel, moneyAxis) {
    const c = document.getElementById(id);
    if (!c || typeof Chart === "undefined") return;
    const opt = (typeof chartOpts === "function") ? chartOpts({ moneyAxis: !!moneyAxis }) : { responsive: true, maintainAspectRatio: true };
    if (opt.plugins && opt.plugins.legend) { opt.plugins.legend.display = true; opt.plugins.legend.position = "top"; }
    new Chart(c, { type: "bar",
      data: { labels, datasets: [
        { label: priorLabel, data: prior, backgroundColor: "#9CA3AF", borderRadius: 4 },
        { label: curLabel, data: cur, backgroundColor: "#CFFF04", borderColor: "#1A1A1A", borderWidth: 1, borderRadius: 4 },
      ] },
      options: opt });
  }

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
      <div class="panel"><h3>Spend by campaign · ${esc(cp.month)}</h3><canvas id="campChart" height="170"></canvas></div>
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
    bars("campChart", cp.rows.map(r => r.campaign), cp.rows.map(r => r.cost), "Cost");
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
        <td class="num" data-sort="${r.cost}">${fmt.money(r.cost)}</td>
        <td class="num" data-sort="${r.impr}">${fmt.num(r.impr)}</td>
        <td class="num" data-sort="${r.clicks}">${fmt.num(r.clicks)}</td>
        <td class="num" data-sort="${r.ctr}">${fmt.pct(r.ctr, 2)}</td>
        <td class="num" data-sort="${r.conv}">${fmt.num(r.conv, 1)}</td>
        <td class="num" data-sort="${r.cpa}">${fmt.money(r.cpa, 2)}</td>
        <td class="num" data-sort="${r.conv_value}">${fmt.money(r.conv_value)}</td></tr>`).join("");
    const t = g.totals || {};
    el.innerHTML = `
      <div class="view-head"><div><h2>Geo Performance</h2>
        <div class="muted">By ${esc(g.dimension)} · cost derived from CPA×conv (Geographic export carries no cost column)</div></div></div>
      <div class="panel"><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>${esc(g.dimension)}</th><th class="num">Cost*</th><th class="num">Impr</th>
          <th class="num">Clicks</th><th class="num">CTR</th><th class="num">Conv</th>
          <th class="num">Cost/conv.</th><th class="num">Conv Value</th></tr></thead>
        <tbody>${body}
          <tr class="strong"><td>Total</td>
            <td class="num">${fmt.money(t.cost)}</td><td class="num">${fmt.num(t.impr)}</td>
            <td class="num">${fmt.num(t.clicks)}</td><td></td>
            <td class="num">${fmt.num(t.conv, 1)}</td><td></td><td class="num">${fmt.money(t.conv_value)}</td></tr>
        </tbody></table></div></div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Budget (composition) ----------
  const capWord = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  function renderBudget(el) {
    el.className = "view";
    const b = (typeof DATA !== "undefined" && DATA.budget_section) || {};
    if (b.total_monthly == null) {
      el.innerHTML = stHead("Budget", "Monthly budget composition") +
        `<div class="panel">No budget set yet. Add one in <a href="#" id="bGo">Budget Input</a>.</div>`;
      const go = el.querySelector("#bGo"); if (go) go.addEventListener("click", e => { e.preventDefault(); setView("budget-input"); });
      return;
    }
    const srcLabel = { file: "from uploaded file", manual: "manual entry" }[b.source] || "";
    const cards = `<div class="stat-grid">
        <div class="stat hl"><div class="stat-label">Monthly Budget</div><div class="stat-value">${fmt.money(b.total_monthly)}</div><div class="stat-chg">${esc(srcLabel)}</div></div>
        ${b.source === "file" ? `<div class="stat"><div class="stat-label">Budget Lines</div><div class="stat-value">${fmt.num(b.line_count)}</div><div class="stat-chg">dimensional</div></div>` : ""}
      </div>`;
    let panels = "";
    if (b.source === "file") {
      const rollups = Object.keys(b.rollups || {}).map(dim => {
        const rows = b.rollups[dim].map(r => `<tr><td class="strong">${esc(r.key)}</td><td class="num">${fmt.money(r.monthly)}</td></tr>`).join("");
        return `<div class="panel"><h3>By ${esc(capWord(dim))}</h3><div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>${esc(capWord(dim))}</th><th class="num">Monthly</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
      }).join("");
      const lineRows = b.lines.map(l => `<tr>
          <td>${l.brand ? esc(l.brand) : '<span class="muted">—</span>'}</td>
          <td>${l.region ? esc(l.region) : '<span class="muted">—</span>'}</td>
          <td>${l.category ? esc(l.category) : '<span class="muted">—</span>'}</td>
          <td class="num">${fmt.money(l.monthly)}</td></tr>`).join("");
      panels = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px">${rollups}</div>
        <div class="panel"><h3>Budget lines</h3><div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>Brand</th><th>Region</th><th>Category</th><th class="num">Monthly</th></tr></thead>
          <tbody>${lineRows}<tr class="strong"><td>Total</td><td></td><td></td><td class="num">${fmt.money(b.total_monthly)}</td></tr></tbody></table></div></div>`;
    }
    // ---- reconciliation: budget vs actual for the latest complete month ----
    const R = b.reconciliation;
    let recon = "";
    if (R) {
      const statusTag = s => ({ "on-track": '<span class="tag lime">On track</span>', "over": '<span class="tag bad">Over budget</span>', "under": '<span class="tag warn">Under budget</span>' }[s] || '<span class="muted">—</span>');
      const varCell = v => `<span class="chg ${v <= 0 ? "up" : "dn"}">${v >= 0 ? "+" : ""}${fmt.money(v)}</span>`;
      const catRows = (R.by_category || []).map(r => `<tr>
          <td class="strong">${esc(r.category)}</td>
          <td class="num">${fmt.money(r.budget)}</td><td class="num">${fmt.money(r.actual)}</td>
          <td class="num">${varCell(r.variance)}</td>
          <td class="num">${r.pct == null ? "—" : (r.pct * 100).toFixed(0) + "%"}</td>
          <td>${statusTag(r.status)}</td></tr>`).join("");
      recon = `
        <div class="panel"><h3>Reconciliation <span class="muted" style="font-weight:400">· budget vs actual · ${esc(R.month)}</span></h3>
          <div class="stat-grid">
            <div class="stat"><div class="stat-label">Budgeted</div><div class="stat-value">${fmt.money(R.total_budget)}</div></div>
            <div class="stat"><div class="stat-label">Actual spend</div><div class="stat-value">${fmt.money(R.total_actual)}</div><div class="stat-chg">${R.pct == null ? "" : (R.pct * 100).toFixed(0) + "% of budget"}</div></div>
            <div class="stat"><div class="stat-label">Variance</div><div class="stat-value" style="font-size:22px">${varCell(R.variance)}</div></div>
            <div class="stat"><div class="stat-label">Status</div><div class="stat-value" style="font-size:20px">${statusTag(R.status)}</div></div>
          </div>
          ${R.by_category ? `<div class="muted" style="margin:12px 0 6px">By category — actual bucketed from campaign names (approximate).</div>
            <div class="tbl-wrap"><table class="sortable">
              <thead><tr><th>Category</th><th class="num">Budgeted</th><th class="num">Actual</th><th class="num">Variance</th><th class="num">% of Budget</th><th>Status</th></tr></thead>
              <tbody>${catRows}
                <tr class="strong"><td>Total</td><td class="num">${fmt.money(R.total_budget)}</td><td class="num">${fmt.money(R.total_actual)}</td>
                  <td class="num">${varCell(R.variance)}</td><td class="num">${R.pct == null ? "—" : (R.pct * 100).toFixed(0) + "%"}</td><td>${statusTag(R.status)}</td></tr>
              </tbody></table></div>` : ""}
        </div>`;
    }
    el.innerHTML = stHead("Budget", "Monthly budget composition & reconciliation — account-wide (not affected by the top-bar filters)") + cards + recon + panels;
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Pacing (spend vs budget) ----------
  function renderPacing(el) {
    el.className = "view";
    const b = (typeof DATA !== "undefined" && DATA.budget_pacing) || null;
    if (!b || !b.months || !b.months.length) {
      el.innerHTML = stHead("Pacing", "") + `<div class="panel">No spend data.</div>`;
      return;
    }
    const hasBudget = b.monthly_budget != null;
    const L = b.latest || {};
    const statusTag = { "on-track": '<span class="tag lime">On track</span>', "over": '<span class="tag bad">Over budget</span>', "under": '<span class="tag warn">Under-pacing</span>' }[b.status] || "";
    const header = hasBudget
      ? `<div class="stat-grid">
           <div class="stat hl"><div class="stat-label">${esc(L.month)} spend</div><div class="stat-value">${fmt.money(L.spend)}</div><div class="stat-chg">of ${fmt.money(b.monthly_budget)} budget</div></div>
           <div class="stat"><div class="stat-label">Variance</div><div class="stat-value">${fmt.money(L.variance)}</div><div class="stat-chg ${L.variance <= 0 ? "up" : "dn"}">${(L.pct * 100).toFixed(0)}% of budget</div></div>
           <div class="stat"><div class="stat-label">Status</div><div class="stat-value" style="font-size:20px">${statusTag}</div></div>
         </div>`
      : `<div class="panel" style="background:#FCFEF0"><strong>No monthly budget set.</strong> Add one in <a href="#" id="bpGo">Budget Input</a> to see pacing vs target. Showing spend by month below.</div>`;
    const body = b.months.slice().reverse().map(m => `<tr>
        <td class="strong">${esc(m.month)}</td>
        <td class="num">${fmt.money(m.spend)}</td>
        <td class="num">${m.budget == null ? "—" : fmt.money(m.budget)}</td>
        <td class="num ${m.variance == null ? "" : (m.variance <= 0 ? "chg up" : "chg dn")}">${m.variance == null ? "—" : fmt.money(m.variance)}</td>
        <td class="num">${m.pct == null ? "—" : (m.pct * 100).toFixed(0) + "%"}</td></tr>`).join("");
    el.innerHTML = stHead("Pacing", "Monthly spend vs budget · intra-month daily pacing needs day-segmented exports") +
      header +
      `<div class="panel"><div class="tbl-wrap"><table>
        <thead><tr><th>Month</th><th class="num">Spend</th><th class="num">Budget</th>
          <th class="num">Variance</th><th class="num">% of Budget</th></tr></thead>
        <tbody>${body}</tbody></table></div></div>`;
    const go = el.querySelector("#bpGo");
    if (go) go.addEventListener("click", e => { e.preventDefault(); setView("budget-input"); });
  }

  // ---------- Budget Input (manual entry + file upload) ----------
  function renderBudgetInput(el) {
    el.className = "view";
    const b = (typeof DATA !== "undefined" && DATA.budget_section) || {};
    const meta = (window.__BUNDLE__ && window.__BUNDLE__.meta) || {};
    const cid = meta.client_id;
    const curPanel = () => {
      if (b.total_monthly == null) return `<div class="muted">No budget set yet.</div>`;
      const src = { file: "Calculated from an uploaded file", manual: "Manual entry" }[b.source] || "";
      let t = `<div style="margin-bottom:8px"><strong style="font-size:20px">${fmt.money(b.total_monthly)}</strong> / month <span class="muted">· ${esc(src)}</span></div>`;
      if (b.source === "file" && b.lines.length) {
        t += `<div class="tbl-wrap" style="max-height:280px;overflow:auto"><table class="sortable"><thead><tr><th>Brand</th><th>Region</th><th>Category</th><th class="num">Monthly</th></tr></thead><tbody>` +
          b.lines.map(l => `<tr><td>${l.brand ? esc(l.brand) : '<span class="muted">—</span>'}</td><td>${l.region ? esc(l.region) : '<span class="muted">—</span>'}</td><td>${l.category ? esc(l.category) : '<span class="muted">—</span>'}</td><td class="num">${fmt.money(l.monthly)}</td></tr>`).join("") +
          `</tbody></table></div>`;
      }
      return t;
    };
    el.innerHTML = stHead("Budget Input", "Set the monthly budget manually, or upload a file to calculate it by Brand / Region / Category") +
      `<div class="two-col">
        <div class="panel"><h3>Manual monthly budget</h3>
          <div class="muted" style="margin-bottom:10px">Direct entry — one figure for the whole account. Saving this clears any uploaded budget lines.</div>
          <div class="ws-row" style="gap:10px;align-items:center;flex-wrap:wrap">
            <input type="number" id="bmVal" class="ws-input" style="max-width:200px" placeholder="e.g. 5000" value="${b.manual != null ? b.manual : ""}"/>
            <button class="ws-btn primary" id="bmSave">Save budget</button>
            <span class="muted" id="bmStatus"></span>
          </div>
        </div>
        <div class="panel"><h3>Upload budget file</h3>
          <div class="muted" style="margin-bottom:10px">CSV or Excel with any of Brand / Region / Category columns plus an amount column. It's auto-detected and summed to a monthly figure.</div>
          <div class="ws-row" style="gap:10px;align-items:center;flex-wrap:wrap">
            <input type="file" id="bfFile" accept=".csv,.xlsx"/>
            <label class="gf-lbl">Amount is</label>
            <select id="bfPeriod" class="gf-sel"><option value="monthly">Monthly</option><option value="annual">Annual</option><option value="total">Total (spread)</option></select>
            <span id="bfWinWrap" style="display:none"><label class="gf-lbl">over</label><input type="number" id="bfWin" class="ws-input" style="max-width:80px" value="12"/><label class="gf-lbl">months</label></span>
            <button class="ws-btn primary" id="bfUpload">Upload &amp; calculate</button>
          </div>
          <div class="muted" id="bfStatus" style="margin-top:10px"></div>
        </div>
      </div>
      <div class="panel"><h3>Current budget</h3><div id="bCur">${curPanel()}</div></div>`;

    const bmSave = el.querySelector("#bmSave");
    bmSave.addEventListener("click", async () => {
      const val = el.querySelector("#bmVal").value;
      const st = el.querySelector("#bmStatus"); st.textContent = "Saving…";
      try {
        const r = await fetch("/api/clients/" + encodeURIComponent(cid) + "/config", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thresholds: { monthly_budget: val === "" ? null : Number(val) }, budget_lines: [] }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        st.textContent = "Saved.";
        if (window.chzRefresh) window.chzRefresh();
      } catch (e) { st.textContent = "Error: " + e.message; }
    });

    const bfPeriod = el.querySelector("#bfPeriod");
    bfPeriod.addEventListener("change", () => { el.querySelector("#bfWinWrap").style.display = bfPeriod.value === "total" ? "inline" : "none"; });
    el.querySelector("#bfUpload").addEventListener("click", async () => {
      const f = el.querySelector("#bfFile").files[0];
      const st = el.querySelector("#bfStatus");
      if (!f) { st.textContent = "Choose a CSV or Excel file first."; return; }
      const fd = new FormData();
      fd.append("file", f); fd.append("period", bfPeriod.value); fd.append("window_months", el.querySelector("#bfWin").value || "12");
      st.textContent = "Parsing…";
      try {
        const r = await fetch("/api/clients/" + encodeURIComponent(cid) + "/budget", { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || ("HTTP " + r.status));
        st.innerHTML = `Parsed ${fmt.num(d.count)} lines across ${esc((d.dimensions || []).join(", "))} → <strong>${fmt.money(d.total_monthly)}/mo</strong>. Saved.`;
        if (window.chzRefresh) setTimeout(window.chzRefresh, 700);
      } catch (e) { st.textContent = "Error: " + e.message; }
    });
  }

  // ---------- Quality Score Overview ----------
  const qsBarColor = qs => qs <= 3 ? "#dc2626" : qs <= 5 ? "#f59e0b" : qs <= 7 ? "#9CA3AF" : "#2F7D4F";
  function renderQsDetail(el) {
    el.className = "view";
    const q = (typeof DATA !== "undefined" && DATA.quality_score) || null;
    if (!q || !q.per_qs) { el.innerHTML = `<div class="view-head"><div><h2>Quality Score</h2></div></div><div class="panel">No Quality Score data.</div>`; return; }
    const scope = q.non_brand ? "non-brand" : "";
    const P = q.per_qs, T = q.totals, sv = q.savings;
    const bucketRows = q.buckets.map(b => `<tr>
        <td class="strong" style="border-left:4px solid ${b.color};padding-left:12px">${esc(b.label)}</td>
        <td class="num">${fmt.num(b.keywords)}</td><td class="num">${fmt.pct(b.kw_share, 1)}</td>
        <td class="num">${fmt.money(b.cost)}</td><td class="num">${fmt.pct(b.spend_share, 1)}</td>
        <td class="num">${fmt.money(b.cpc, 2)}</td><td class="num">${fmt.pct(b.ctr, 2)}</td>
        <td class="num">${fmt.pct(b.conv_rate, 2)}</td><td class="num">${b.cpa ? fmt.money(b.cpa, 2) : "—"}</td>
        <td class="num">${fmt.num(b.conv, 0)}</td></tr>`).join("");
    const qsRows = P.map(r => `<tr>
        <td class="strong">QS ${r.qs}</td>
        <td class="num">${fmt.num(r.keywords)}</td><td class="num">${fmt.pct(r.kw_share, 2)}</td>
        <td class="num">${fmt.money(r.cost)}</td><td class="num">${fmt.pct(r.spend_share, 2)}</td>
        <td class="num">${fmt.num(r.clicks)}</td><td class="num">${fmt.money(r.cpc, 2)}</td>
        <td class="num">${fmt.pct(r.ctr, 2)}</td><td class="num">${fmt.pct(r.conv_rate, 2)}</td>
        <td class="num">${r.cpa ? fmt.money(r.cpa, 2) : "—"}</td><td class="num">${fmt.num(r.conv, 0)}</td></tr>`).join("");
    el.innerHTML = `
      <div class="view-head">
        <div><h2>Quality Score Overview${scope ? " · Non-Brand Portfolio" : ""}</h2>
          <div class="muted">${q.month ? q.month + " · " : ""}Distribution of QS across ${fmt.num(q.total_keywords)} ${scope ? scope + " " : ""}keywords and the CPC differential each score carries</div></div>
        <div><span class="tag lime">Avg QS ${q.avg_qs}</span></div>
      </div>
      <div class="stat-grid">
        <div class="stat hl"><div class="stat-label">Avg Quality Score</div><div class="stat-value">${q.avg_qs}</div><div class="stat-chg">${scope ? scope + " keywords" : "keywords"}</div></div>
        <div class="stat"><div class="stat-label">${scope ? "NB " : ""}Keywords</div><div class="stat-value">${fmt.num(q.total_keywords)}</div><div class="stat-chg">graded${q.month ? " in " + q.month : ""}</div></div>
        <div class="stat"><div class="stat-label">QS ≤ 5 (Weak)</div><div class="stat-value">${fmt.pct(q.pct_weak, 0)}</div><div class="stat-chg dn">of portfolio</div></div>
        <div class="stat"><div class="stat-label">QS ≥ 7 (Strong)</div><div class="stat-value">${fmt.pct(q.pct_strong, 0)}</div><div class="stat-chg up">of portfolio</div></div>
        <div class="stat"><div class="stat-label">Est. Monthly Savings</div><div class="stat-value">${fmt.money(sv.amount)}</div><div class="stat-chg">if QS ≤ 5 → QS 7</div></div>
      </div>
      <div class="panel" style="background:#FCFEF0">If keywords at QS ≤ 5 could be improved to QS 7, the portfolio would save an estimated <strong>${fmt.money(sv.amount)}/mo</strong> based on the CPC differential (${fmt.money(sv.cpc_weak, 2)} → ${fmt.money(sv.cpc_qs7, 2)}).</div>
      <div class="two-col">
        <div class="panel"><h3>QS distribution — keywords &amp; spend share</h3><div style="position:relative;height:300px"><canvas id="qsDistChart"></canvas></div></div>
        <div class="panel"><h3>Avg CPC &amp; CTR by QS</h3><div style="position:relative;height:300px"><canvas id="qsCpcChart"></canvas></div></div>
      </div>
      <div class="panel"><h3>QS bucket summary</h3><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>Bucket</th><th class="num">Keywords</th><th class="num">% of KWs</th><th class="num">Spend</th>
          <th class="num">% of Spend</th><th class="num">Avg CPC</th><th class="num">CTR</th>
          <th class="num">Conv Rate</th><th class="num">Avg CPA</th><th class="num">Conversions</th></tr></thead>
        <tbody>${bucketRows}</tbody></table></div></div>
      <div class="panel"><h3>QS vs CPC detail (QS 1 – QS 10)</h3><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>QS</th><th class="num">Keywords</th><th class="num">% of Total</th><th class="num">Spend</th>
          <th class="num">% of Spend</th><th class="num">Clicks</th><th class="num">Avg CPC</th><th class="num">CTR</th>
          <th class="num">Conv Rate</th><th class="num">CPA</th><th class="num">Conversions</th></tr></thead>
        <tbody>${qsRows}
          <tr class="strong"><td>Total</td><td class="num">${fmt.num(T.keywords)}</td><td class="num">100%</td>
            <td class="num">${fmt.money(T.cost)}</td><td class="num">100%</td><td class="num">${fmt.num(T.clicks)}</td>
            <td class="num">${fmt.money(T.cpc, 2)}</td><td class="num">${fmt.pct(T.ctr, 2)}</td>
            <td class="num">${fmt.pct(T.conv_rate, 2)}</td><td class="num">${fmt.money(T.cpa, 2)}</td>
            <td class="num">${fmt.num(T.conv, 0)}</td></tr>
        </tbody></table></div></div>`;
    // combo: keyword bars (bucket-colored) + % of spend line on a right axis
    if (typeof Chart !== "undefined") {
      const dc = document.getElementById("qsDistChart");
      if (dc) new Chart(dc, { data: { labels: P.map(r => "QS " + r.qs), datasets: [
          { type: "bar", label: "Keywords", data: P.map(r => r.keywords), backgroundColor: P.map(r => qsBarColor(r.qs)), yAxisID: "y", order: 2 },
          { type: "line", label: "% of Spend", data: P.map(r => +(r.spend_share * 100).toFixed(2)), borderColor: "#1A1A1A", backgroundColor: "#1A1A1A", yAxisID: "y1", tension: 0.35, pointRadius: 2, fill: false, order: 1 } ] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
          scales: { y: { position: "left", title: { display: true, text: "Keywords" } },
            y1: { position: "right", title: { display: true, text: "% of Spend" }, grid: { drawOnChartArea: false }, ticks: { callback: v => v + "%" } } },
          plugins: { legend: { position: "bottom", labels: { font: { family: "Inter", size: 11 }, boxWidth: 12 } } } } });
      const cc = document.getElementById("qsCpcChart");
      if (cc) new Chart(cc, { type: "line", data: { labels: P.map(r => "QS " + r.qs), datasets: [
          { label: "Avg CPC", data: P.map(r => r.cpc), borderColor: "#1A1A1A", backgroundColor: "#1A1A1A", yAxisID: "y", tension: 0.35, pointRadius: 2, fill: false },
          { label: "CTR", data: P.map(r => +(r.ctr * 100).toFixed(2)), borderColor: "#CFFF04", backgroundColor: "#CFFF04", yAxisID: "y1", tension: 0.35, pointRadius: 2, fill: false } ] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
          scales: { y: { position: "left", title: { display: true, text: "Avg CPC" }, ticks: { callback: v => "$" + v } },
            y1: { position: "right", title: { display: true, text: "CTR" }, grid: { drawOnChartArea: false }, ticks: { callback: v => v + "%" } } },
          plugins: { legend: { position: "bottom", labels: { font: { family: "Inter", size: 11 }, boxWidth: 12 } } } } });
    }
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Search Terms ----------
  function renderSearchTerms(el) {
    el.className = "view";
    const s = (typeof DATA !== "undefined" && DATA.search_terms) || null;
    if (!s) { el.innerHTML = `<div class="view-head"><div><h2>Search Terms</h2></div></div><div class="panel">No search-term data.</div>`; return; }
    const relCell = t => {
      if (t.relevant == null) return `<td>—</td>`;
      return `<td class="chg ${t.relevant ? "up" : "dn"}">${t.relevant ? "Relevant" : "Irrelevant"}<span class="muted" style="font-weight:400"> · ${esc(t.category || "")}</span></td>`;
    };
    const waste = s.top_waste.map(t => `<tr>
        <td class="strong">${esc(t.term)}</td><td>${esc(t.match)}</td>
        <td class="num" data-sort="${t.clicks}">${fmt.num(t.clicks)}</td>
        <td class="num" data-sort="${t.cost}">${fmt.money(t.cost)}</td>
        ${relCell(t)}</tr>`).join("");
    const conv = s.top_converting.map(t => `<tr>
        <td class="strong">${esc(t.term)}</td>
        <td class="num" data-sort="${t.clicks}">${fmt.num(t.clicks)}</td>
        <td class="num" data-sort="${t.cost}">${fmt.money(t.cost)}</td>
        <td class="num" data-sort="${t.conv}">${fmt.num(t.conv, 1)}</td>
        <td class="num" data-sort="${t.cpa}">${fmt.money(t.cpa, 2)}</td></tr>`).join("");
    const rel = s.relevance;
    const relBanner = rel ? `<div class="panel" style="background:#FCFEF0">
        <strong>Relevance (${esc(rel.source)}):</strong>
        ${fmt.money(rel.irrelevant_waste)} confirmed irrelevant → <span class="chg dn">negate</span> ·
        ${fmt.money(rel.relevant_waste)} relevant but not converting → <span class="chg up">fix quality, don't negate</span>
        <span class="muted"> (top ${rel.classified} waste terms classified)</span></div>` : "";
    el.innerHTML = `
      <div class="view-head"><div><h2>Search Terms</h2>
        <div class="muted">${fmt.num(s.total_terms)} terms · ${fmt.money(s.waste_total)} on zero-conversion terms</div></div></div>
      ${relBanner}
      <div class="panel"><h3>Top zero-conversion terms — negative-keyword candidates</h3><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>Search term</th><th>Match</th><th class="num">Clicks</th><th class="num">Cost</th><th>Relevance</th></tr></thead>
        <tbody>${waste}</tbody></table></div></div>
      <div class="panel"><h3>Top converting terms</h3><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>Search term</th><th class="num">Clicks</th><th class="num">Cost</th><th class="num">Conv</th><th class="num">CPA</th></tr></thead>
        <tbody>${conv}</tbody></table></div></div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Search Terms section (shared helpers) ----------
  const gradeCls = g => (g && g[0] === "A") ? "up" : (g && g[0] === "F") ? "dn" : "";
  const intentCell = t => t.relevant == null ? `<td>—</td>` : `<td class="chg ${t.relevant ? "up" : "dn"}">${esc(t.intent || "")}</td>`;
  const termTable = (rows, withIntent) => `<div class="tbl-wrap"><table class="sortable">
      <thead><tr><th>Search term</th><th>Match</th><th class="num">Clicks</th><th class="num">Cost</th>
        <th class="num">Conv</th><th>Grade</th>${withIntent ? "<th>Intent</th>" : ""}</tr></thead>
      <tbody>${rows.map(t => `<tr>
        <td class="strong">${esc(t.term)}</td><td>${esc(t.match)}</td>
        <td class="num" data-sort="${t.clicks}">${fmt.num(t.clicks)}</td>
        <td class="num" data-sort="${t.cost}">${fmt.money(t.cost)}</td>
        <td class="num" data-sort="${t.conv}">${fmt.num(t.conv, 1)}</td>
        <td class="chg ${gradeCls(t.grade)}">${esc(t.grade)}</td>
        ${withIntent ? intentCell(t) : ""}</tr>`).join("")}</tbody></table></div>`;
  const stData = () => (typeof DATA !== "undefined" && DATA.search_terms_section) || null;
  // Campaign/Region can't be resolved for search terms (no campaign or ad-group column)
  const stFilterNote = s => {
    const ig = (s && s.filters_ignored) || [];
    if (!ig.length) return "";
    return `<div class="panel" style="background:#FCFEF0">The <strong>${ig.join("</strong> and <strong>")}</strong> filter${ig.length > 1 ? "s are" : " is"} not applied on this tab — the search-terms export carries no campaign or ad-group column. Segment, Category and Brand filters do apply.</div>`;
  };
  const stHead = (title, sub) => `<div class="view-head"><div><h2>${title}</h2><div class="muted">${sub}</div></div></div>`;

  const stGradePill = g => {
    const c = String(g)[0];
    const st = (c === "A" || c === "B") ? "background:#DCFCE7;color:#166534"
      : c === "C" ? "background:#FEF3C7;color:#92660A"
      : c === "D" ? "background:#FCE7CE;color:#9A5B1E"
      : c === "F" ? "background:#FEE2E2;color:#991B1B" : "background:#eee;color:#555";
    return `<span class="tag" style="${st};font-size:10.5px">${esc(g)}</span>`;
  };
  function renderStIntent(el) {
    el.className = "view"; const s = stData();
    if (!s) { el.innerHTML = stHead("Intent &amp; Grades", "") + `<div class="panel">No search-term data.</div>`; return; }
    const seg = s.intent_segments || [];
    const cards = seg.map((g, i) => `<div class="stat ${i === 0 ? "hl" : ""}">
        <div class="stat-label">${esc(g.name)}</div><div class="stat-value">${fmt.num(g.terms)}</div>
        <div class="stat-chg ${g.name === "Irrelevant" ? "dn" : ""}">${fmt.pct(g.spend_share, 1)} of spend</div></div>`).join("");
    const gradeRows = (s.grades || []).map(g => `<tr>
        <td>${stGradePill(g.grade)}</td><td class="num">${fmt.num(g.terms)}</td><td class="num">${fmt.money(g.spend)}</td>
        <td class="num">${fmt.pct(g.spend_share, 1)}</td><td class="num">${fmt.num(g.conv, 0)}</td>
        <td class="num">${g.cpa ? fmt.money(g.cpa, 2) : "—"}</td></tr>`).join("");
    const methodRows = (s.grade_method || []).map(m => `<tr>
        <td>${stGradePill(m.grade)}</td><td class="num">${esc(m.threshold)}</td><td>${esc(m.interpretation)}</td></tr>`).join("");
    const comp = s.competitor_breakdown || [];
    const compPanel = comp.length ? `
      <div class="panel"><h3>Competitor brand breakdown</h3>
        <div class="muted" style="margin-bottom:8px">Paid-search spend on queries that target named competitor brands.</div>
        <div style="position:relative;height:${Math.max(160, comp.length * 42)}px"><canvas id="stCompChart"></canvas></div></div>` : "";
    el.innerHTML = stHead("Search Term · Intent &amp; Grades", `${fmt.num(s.total_terms)} terms · ${fmt.money(s.total_spend)} spend`) +
      stFilterNote(s) +
      `<div class="stat-grid">${cards}</div>
       <div class="two-col">
         <div class="panel"><h3>Service categories by spend</h3><canvas id="stSvcChart" height="230"></canvas></div>
         <div class="panel"><h3>Performance grades · term counts</h3>
           <div class="muted" style="margin-bottom:8px">Grades assigned by CVR thresholds on non-brand search terms.</div>
           <div class="tbl-wrap"><table class="sortable">
             <thead><tr><th>Grade</th><th class="num">Terms</th><th class="num">Spend</th><th class="num">% of Spend</th><th class="num">Conv</th><th class="num">CPA</th></tr></thead>
             <tbody>${gradeRows}</tbody></table></div></div>
       </div>
       <div class="panel"><h3>How grades are calculated</h3>
         <div class="muted" style="margin-bottom:8px">Non-brand search terms with $1+ spend are graded by conversion rate (CVR = conversions / clicks). Brand &amp; competitor terms are excluded.</div>
         <div class="tbl-wrap"><table>
           <thead><tr><th>Grade</th><th class="num">CVR Threshold</th><th>Interpretation</th></tr></thead>
           <tbody>${methodRows}</tbody></table></div></div>
       ${compPanel}`;
    donut("stSvcChart", s.service_categories.map(c => c.category), s.service_categories.map(c => Math.round(c.spend)));
    if (comp.length && typeof Chart !== "undefined") {
      const cc = document.getElementById("stCompChart");
      if (cc) new Chart(cc, { type: "bar",
        data: { labels: comp.map(c => c.segment), datasets: [{ data: comp.map(c => Math.round(c.spend)), backgroundColor: "#1A1A1A", borderRadius: 3 }] },
        options: { indexAxis: "y", responsive: true, maintainAspectRatio: false,
          scales: { x: { ticks: { callback: v => "$" + v.toLocaleString() } } }, plugins: { legend: { display: false } } } });
    }
    if (typeof enableSortable === "function") enableSortable(el);
  }
  const stStatusBadge = st => {
    const m = { "Recommend to Add": "background:#1A1A1A;color:#CFFF04", "Already Added": "background:#DBEAFE;color:#1E40AF",
      "Review": "background:#FEF3C7;color:#92660A", "Excluded": "background:#FEE2E2;color:#991B1B", "Unassigned": "background:#eee;color:#555" };
    return `<span class="tag" style="${m[st] || ""};font-size:10px">${esc(st)}</span>`;
  };
  const stGradeRow = g => `<tr><td>${stGradePill(g.grade)}</td><td class="num">${fmt.num(g.terms)}</td>
      <td class="num">${fmt.money(g.spend)}</td><td class="num">${fmt.pct(g.spend_share, 1)}</td>
      <td class="num">${fmt.num(g.conv, 0)}</td><td class="num">${g.cpa ? fmt.money(g.cpa, 2) : "—"}</td></tr>`;
  const stGradePanel = s => `<div class="panel"><h3>Performance grades · term counts</h3>
      <div class="muted" style="margin-bottom:8px">Grades assigned by CVR thresholds on non-brand search terms.</div>
      <div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>Grade</th><th class="num">Terms</th><th class="num">Spend</th><th class="num">% of Spend</th><th class="num">Conv</th><th class="num">CPA</th></tr></thead>
        <tbody>${(s.grades || []).map(stGradeRow).join("")}</tbody></table></div></div>`;
  let STR_CAT = "all", STR_FILTER = "";
  function renderStRelevant(el) {
    el.className = "view"; const s = stData();
    if (!s) { el.innerHTML = stHead("Relevant Terms", "") + `<div class="panel">No data.</div>`; return; }
    const ks = s.keyword_status || [];
    const cards = ks.map((k, i) => `<div class="stat ${i === 0 ? "hl" : ""}">
        <div class="stat-label">${esc(k.status)}</div><div class="stat-value">${fmt.num(k.terms)}</div>
        <div class="stat-chg">${fmt.money(k.spend)} · ${fmt.pct(k.spend_share, 1)} of spend</div></div>`).join("");
    const rows = s.relevant_terms || [];
    const rowFn = r => `<tr>
        <td class="strong">${esc(r.term)}</td>
        <td>${r.category === "Uncategorized" ? '<span class="muted">Uncategorized</span>' : esc(r.category)}</td>
        <td>${stGradePill(r.grade)}</td><td>${stStatusBadge(r.status)}</td>
        <td class="num">${fmt.money(r.spend)}</td><td class="num">${fmt.num(r.clicks)}</td>
        <td class="num">${fmt.num(r.conv, 1)}</td><td class="num">${fmt.pct(r.cvr, 2)}</td><td class="num">${fmt.money(r.cpc, 2)}</td></tr>`;
    const filterRows = () => {
      let rws = rows;
      if (STR_CAT !== "all") rws = rws.filter(r => r.category === STR_CAT);
      if (STR_FILTER) { const f = STR_FILTER.toLowerCase(); rws = rws.filter(r => (r.term + " " + r.category).toLowerCase().indexOf(f) >= 0); }
      return rws;
    };
    const shown = filterRows();
    const catOpts = ['<option value="all">All categories</option>'].concat((s.relevant_categories || []).map(c => `<option value="${esc(c)}"${STR_CAT === c ? " selected" : ""}>${esc(c)}</option>`)).join("");
    el.innerHTML = stHead("Relevant Terms", `Top ${fmt.num(rows.length)} Intent=Relevant terms by spend`) +
      stFilterNote(s) +
      `<div class="stat-grid">${cards}</div>
       <div class="two-col">
         <div class="panel"><h3>Service categories by spend</h3><canvas id="strSvcChart" height="230"></canvas></div>
         ${stGradePanel(s)}
       </div>
       <div class="panel">
         <div class="toolbar">
           <input type="text" id="strFilter" placeholder="Filter term…" value="${esc(STR_FILTER)}" style="min-width:240px"/>
           <label>Category:</label><select id="strCat">${catOpts}</select>
           <span class="muted" id="strCount" style="margin-left:auto">Showing ${fmt.num(shown.length)} of ${fmt.num(s.relevant_total)}</span>
         </div>
         <div class="tbl-wrap"><table class="sortable">
           <thead><tr><th>Search Term</th><th>Category</th><th>Grade</th><th>Status</th><th class="num">Spend</th>
             <th class="num">Clicks</th><th class="num">Conv</th><th class="num">CVR</th><th class="num">CPC</th></tr></thead>
           <tbody id="strBody">${shown.map(rowFn).join("")}</tbody></table></div>
       </div>`;
    donut("strSvcChart", s.service_categories.map(c => c.category), s.service_categories.map(c => Math.round(c.spend)));
    const cf = el.querySelector("#strCat"); if (cf) cf.addEventListener("change", () => { STR_CAT = cf.value; setView("st-relevant", { preserveScroll: true }); });
    const tf = el.querySelector("#strFilter");
    if (tf) tf.addEventListener("input", () => {
      STR_FILTER = tf.value; const rws = filterRows();
      const body = el.querySelector("#strBody"); if (body) body.innerHTML = rws.map(rowFn).join("");
      const cnt = el.querySelector("#strCount"); if (cnt) cnt.textContent = `Showing ${fmt.num(rws.length)} of ${fmt.num(s.relevant_total)}`;
    });
    if (typeof enableSortable === "function") enableSortable(el);
  }
  let STC_FILTER = "";
  function renderStCompetitor(el) {
    el.className = "view"; const s = stData();
    if (!s) { el.innerHTML = stHead("Competitor Terms", "") + `<div class="panel">No data.</div>`; return; }
    const summary = s.competitor_summary || [], rows = s.competitor_terms || [];
    if (!rows.length) {
      el.innerHTML = stHead("Competitor Terms", "Search terms targeting competitor brands") +
        `<div class="panel"><div class="ws-empty" style="padding:24px;text-align:center;color:var(--grey)">No competitor terms — add competitors in Business Context.</div></div>`;
      return;
    }
    const compPill = c => `<span class="tag info" style="font-size:10.5px">${esc(String(c).toLowerCase().replace(/\s+/g, "_"))}</span>`;
    const sumRows = summary.map(r => `<tr>
        <td>${compPill(r.type)}</td><td class="num">${fmt.num(r.terms)}</td><td class="num">${fmt.money(r.spend)}</td>
        <td class="num">${fmt.pct(r.spend_share, 1)}</td><td class="num">${fmt.num(r.conv, 0)}</td>
        <td class="num">${r.cpa ? fmt.money(r.cpa, 2) : "—"}</td></tr>`).join("");
    const rowFn = r => `<tr>
        <td class="strong">${esc(r.term)}</td><td>${compPill(r.competitor)}</td>
        <td class="num">${fmt.money(r.spend)}</td><td class="num">${fmt.num(r.clicks)}</td>
        <td class="num">${fmt.num(r.conv, 1)}</td><td class="num">${fmt.pct(r.cvr, 2)}</td>
        <td class="num">${r.cpa ? fmt.money(r.cpa, 2) : "—"}</td></tr>`;
    const filterRows = () => STC_FILTER ? rows.filter(r => (r.term + " " + r.competitor).toLowerCase().indexOf(STC_FILTER.toLowerCase()) >= 0) : rows;
    const shown = filterRows();
    el.innerHTML = stHead("Competitor Terms", `Top ${fmt.num(rows.length)} search terms targeting competitor brands`) +
      stFilterNote(s) +
      `<div class="two-col">
         <div class="panel"><h3>Competitor types by spend</h3><canvas id="stcDonut" height="230"></canvas></div>
         <div class="panel"><h3>Competitor type summary</h3>
           <div class="muted" style="margin-bottom:8px">Paid-search spend on competitor-intent terms by segment. Portfolio-wide — each term counted once.</div>
           <div class="tbl-wrap"><table class="sortable">
             <thead><tr><th>Competitor Type</th><th class="num">Terms</th><th class="num">Spend</th><th class="num">% of Spend</th><th class="num">Conv</th><th class="num">CPA</th></tr></thead>
             <tbody>${sumRows}</tbody></table></div></div>
       </div>
       <div class="panel">
         <div class="toolbar"><input type="text" id="stcFilter" placeholder="Filter term…" value="${esc(STC_FILTER)}" style="min-width:240px"/>
           <span class="muted" id="stcCount" style="margin-left:auto">Showing ${fmt.num(shown.length)} of ${fmt.num(s.competitor_total)}</span></div>
         <div class="tbl-wrap"><table class="sortable">
           <thead><tr><th>Search Term</th><th>Competitor</th><th class="num">Spend</th><th class="num">Clicks</th>
             <th class="num">Conv</th><th class="num">CVR</th><th class="num">CPA</th></tr></thead>
           <tbody id="stcBody">${shown.map(rowFn).join("")}</tbody></table></div>
       </div>`;
    donut("stcDonut", summary.map(r => r.type), summary.map(r => Math.round(r.spend)));
    const tf = el.querySelector("#stcFilter");
    if (tf) tf.addEventListener("input", () => {
      STC_FILTER = tf.value; const rws = filterRows();
      const body = el.querySelector("#stcBody"); if (body) body.innerHTML = rws.map(rowFn).join("");
      const cnt = el.querySelector("#stcCount"); if (cnt) cnt.textContent = `Showing ${fmt.num(rws.length)} of ${fmt.num(s.competitor_total)}`;
    });
    if (typeof enableSortable === "function") enableSortable(el);
  }
  let STF_FILTER = "";
  function renderStFlagged(el) {
    el.className = "view"; const s = stData();
    if (!s) { el.innerHTML = stHead("Flagged / Needs Review", "") + `<div class="panel">No data.</div>`; return; }
    const rows = s.flagged_terms || [];
    if (!rows.length) {
      el.innerHTML = stHead("Flagged / Needs Review", "Terms flagged for review based on intent/relevance") +
        `<div class="panel"><div class="ws-empty" style="padding:24px;text-align:center;color:var(--grey)">No terms need review.</div></div>`;
      return;
    }
    const intentPill = i => `<span class="tag" style="background:#E0EAFB;color:#1E40AF;font-size:10.5px">${esc(i)}</span>`;
    const rowFn = r => `<tr>
        <td class="strong">${esc(r.term)}</td><td>${intentPill(r.intent)}</td><td>${stStatusBadge(r.status)}</td>
        <td class="num">${fmt.money(r.spend)}</td><td class="num">${fmt.num(r.clicks)}</td>
        <td class="num">${fmt.num(r.conv, 1)}</td><td class="num">${fmt.pct(r.cvr, 2)}</td>
        <td class="num">${r.cpa ? fmt.money(r.cpa, 2) : "—"}</td></tr>`;
    const filterRows = () => STF_FILTER ? rows.filter(r => r.term.toLowerCase().indexOf(STF_FILTER.toLowerCase()) >= 0) : rows;
    const shown = filterRows();
    el.innerHTML = stHead("Flagged / Needs Review", `Top ${fmt.num(rows.length)} terms flagged for review based on intent/relevance`) +
      stFilterNote(s) +
      `<div class="panel">
         <div class="toolbar"><input type="text" id="stfFilter" placeholder="Filter term…" value="${esc(STF_FILTER)}" style="min-width:240px"/>
           <span class="muted" id="stfCount" style="margin-left:auto">Showing ${fmt.num(shown.length)} of ${fmt.num(s.flagged_total)}</span></div>
         <div class="tbl-wrap"><table class="sortable">
           <thead><tr><th>Search Term</th><th>Intent</th><th>Status</th><th class="num">Spend</th><th class="num">Clicks</th>
             <th class="num">Conv</th><th class="num">CVR</th><th class="num">CPA</th></tr></thead>
           <tbody id="stfBody">${shown.map(rowFn).join("")}</tbody></table></div>
       </div>`;
    const tf = el.querySelector("#stfFilter");
    if (tf) tf.addEventListener("input", () => {
      STF_FILTER = tf.value; const rws = filterRows();
      const body = el.querySelector("#stfBody"); if (body) body.innerHTML = rws.map(rowFn).join("");
      const cnt = el.querySelector("#stfCount"); if (cnt) cnt.textContent = `Showing ${fmt.num(rws.length)} of ${fmt.num(s.flagged_total)}`;
    });
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Keyword section ----------
  // Heatmap state (used when a region-segmented keyword export is present)
  let KWD_TYPE = "nonbranded", KWD_CRIT = "spend", KWD_GRID = "spend";
  (function injectKwdStyle() {
    const s = document.createElement("style");
    s.textContent = `
      .kwd-grid{border-collapse:separate;border-spacing:0;font-size:12.5px;white-space:nowrap}
      .kwd-grid th,.kwd-grid td{padding:6px 10px;border-bottom:1px solid var(--line,#eee);text-align:right}
      .kwd-grid th:nth-child(-n+2),.kwd-grid td:nth-child(-n+2){text-align:left}
      .kwd-grid thead th{position:sticky;top:0;background:var(--ink,#1a1a1a);color:#fff;font-size:11px;letter-spacing:.02em;z-index:2}
      .kwd-grid td.kwd-kwcell{position:sticky;left:0;background:#fff;z-index:1}
      .kwd-grid .kwd-kw{font-weight:600;color:var(--ink,#1a1a1a)}
      .kwd-grid .kwd-tags{margin-top:2px;display:flex;gap:4px}
      .kwd-grid .kwd-tags .tag{font-size:9.5px;padding:1px 6px}
      .kwd-grid td.kwd-empty{color:#cfd4cb;text-align:center}
      .kwd-brandhead td{background:var(--ink,#1a1a1a);color:var(--lime,#CFFF04);font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase;position:sticky;left:0}
      .kwd-ctls{display:flex;gap:26px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
      .kwd-ctl label.lbl{display:block;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--grey,#888);margin-bottom:5px}
      .qsb-grouphead td{background:var(--ink,#1a1a1a);color:#fff;font-weight:700;font-size:11px;letter-spacing:.04em;padding:9px 12px;text-transform:uppercase}
      .qsb-badge{display:inline-block;background:var(--lime,#CFFF04);color:var(--ink,#1a1a1a);font-weight:800;border-radius:4px;padding:1px 7px;margin-right:8px}
      .qsb-grid{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
      .qsb-grid th,.qsb-grid td{padding:9px 12px;border-bottom:1px solid var(--line,#eee)}
      .qsb-grid thead th.qsb-hd{background:var(--ink,#1a1a1a);color:#fff;font-size:11px;letter-spacing:.03em;text-transform:uppercase}
      .qsb-grid thead th{background:#FAFAF7;text-align:right}
      .qsb-grid thead th:first-child{text-align:left}
      .qsb-grid td.qsb-ectr{vertical-align:middle;background:#FAFAF7;border-right:2px solid var(--line,#eee)}
      .qsb-grid td.qsb-cell{text-align:center;font-variant-numeric:tabular-nums}
      .qsb-grid td.pair-cell{text-align:right;font-variant-numeric:tabular-nums}`;
    document.head.appendChild(s);
  })();
  // t in [0,1] -> green(low) → yellow(mid) → red(high) background style
  function heatT(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [[226, 240, 217], [255, 229, 153], [229, 115, 115]];
    const seg = t < 0.5 ? 0 : 1, u = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const a = stops[seg], b = stops[seg + 1];
    const c = a.map((x, i) => Math.round(x + (b[i] - x) * u));
    return `background:rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function kwHeat(v, max) {
    if (!(v > 0) || !(max > 0)) return "";
    return heatT(Math.sqrt(v / max));
  }
  function renderKwHeatmap(el, kr) {
    const branded = KWD_TYPE === "branded";
    const metric = KWD_GRID, crit = KWD_CRIT;
    const tot = branded ? kr.totals.branded : kr.totals.nonbranded;
    const regions = kr.regions || [];
    const fmtV = v => metric === "conv" ? fmt.num(v, 0) : fmt.money(v);
    let rows = kr.keywords.filter(kw => !!kw.branded === branded)
      .sort((a, b) => (b.overall[crit] || 0) - (a.overall[crit] || 0)).slice(0, 50);
    let maxCell = 0, maxOverall = 0;
    rows.forEach(kw => {
      maxOverall = Math.max(maxOverall, kw.overall[metric] || 0);
      regions.forEach(rg => { const c = kw.cells[rg.name]; if (c) maxCell = Math.max(maxCell, c[metric] || 0); });
    });
    const seg = (val, cur, attr, l) => `<button class="seg-pill ${cur === val ? "active" : ""}" data-${attr}="${val}">${l}</button>`;
    const regionHead = regions.map(rg => `<th>${esc(rg.name)}</th>`).join("");
    const body = rows.map((kw, i) => {
      const cells = regions.map(rg => {
        const c = kw.cells[rg.name];
        if (!c || !(c[metric] > 0)) return `<td class="kwd-empty">·</td>`;
        return `<td style="${kwHeat(c[metric], maxCell)}">${fmtV(c[metric])}</td>`;
      }).join("");
      return `<tr>
        <td>${i + 1}</td>
        <td class="kwd-kwcell"><div class="kwd-kw">${esc(kw.keyword)}</div>
          <div class="kwd-tags"><span class="tag">${esc(kw.brand)}</span>${kw.category ? `<span class="tag info">${esc(kw.category)}</span>` : ""}</div></td>
        <td style="${kwHeat(kw.overall[metric], maxOverall)}"><strong>${fmtV(kw.overall[metric])}</strong></td>
        ${cells}</tr>`;
    }).join("");
    const gridLabel = metric === "conv" ? "Conversions" : "Spend";
    el.innerHTML = `
      <div class="view-head">
        <div><h2>Keyword Deep Dive</h2>
          <div class="muted">Top ${branded ? "branded" : "non-branded"} keywords (by ${crit === "conv" ? "conversions" : "spend"}) × regions · cells show ${gridLabel}</div></div>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">Keywords</div><div class="stat-value">${fmt.num(tot.keywords)}</div></div>
        <div class="stat"><div class="stat-label">Regions</div><div class="stat-value">${fmt.num(kr.totals.regions)}</div></div>
        <div class="stat"><div class="stat-label">Spend</div><div class="stat-value">${fmt.money(tot.spend)}</div></div>
        <div class="stat"><div class="stat-label">Conversions</div><div class="stat-value">${fmt.num(tot.conv, 0)}</div></div>
      </div>
      <div class="panel">
        <div class="kwd-ctls">
          <div class="kwd-ctl"><label class="lbl">Keyword type</label><div class="seg-group">${seg("nonbranded", KWD_TYPE, "kwtype", "Non-branded")}${seg("branded", KWD_TYPE, "kwtype", "Branded")}</div></div>
          <div class="kwd-ctl"><label class="lbl">Top-keyword criteria</label><div class="seg-group">${seg("spend", KWD_CRIT, "kwcrit", "Spend")}${seg("conv", KWD_CRIT, "kwcrit", "Main Conversions")}</div></div>
          <div class="kwd-ctl"><label class="lbl">Metric in grid</label>
            <select id="kwGrid"><option value="spend"${metric === "spend" ? " selected" : ""}>Spend</option><option value="conv"${metric === "conv" ? " selected" : ""}>Conversions</option></select></div>
        </div>
        <div class="tbl-wrap" style="max-height:640px;overflow:auto">
          <table class="kwd-grid">
            <thead><tr><th>Rank</th><th>Keyword</th><th>Overall</th>${regionHead}</tr></thead>
            <tbody>
              <tr class="kwd-brandhead"><td colspan="${3 + regions.length}">${esc(kr.brand)} · Top ${rows.length} ${branded ? "branded" : "non-branded"} keywords by ${crit === "conv" ? "conversions" : "spend"}</td></tr>
              ${body || `<tr><td colspan="${3 + regions.length}" class="muted" style="padding:16px">No ${branded ? "branded" : "non-branded"} keywords.</td></tr>`}
            </tbody></table>
        </div>
      </div>`;
    el.querySelectorAll("[data-kwtype]").forEach(b => b.addEventListener("click", () => { KWD_TYPE = b.dataset.kwtype; setView("kw-deep-dive", { preserveScroll: true }); }));
    el.querySelectorAll("[data-kwcrit]").forEach(b => b.addEventListener("click", () => { KWD_CRIT = b.dataset.kwcrit; setView("kw-deep-dive", { preserveScroll: true }); }));
    const gsel = el.querySelector("#kwGrid");
    if (gsel) gsel.addEventListener("change", () => { KWD_GRID = gsel.value; setView("kw-deep-dive", { preserveScroll: true }); });
  }
  function renderKwDeepDive(el) {
    el.className = "view";
    const kr = (typeof DATA !== "undefined" && DATA.keyword_regions_section) || null;
    if (kr && kr.keywords && kr.keywords.length) { renderKwHeatmap(el, kr); return; }
    // fallback: flat keyword table (no region-segmented export uploaded)
    const k = (typeof DATA !== "undefined" && DATA.keyword_section) || null;
    if (!k) { el.innerHTML = stHead("Keyword Deep Dive", "") + `<div class="panel">No keyword data.</div>`; return; }
    const rows = k.deep_dive.map(d => `<tr>
        <td class="strong">${esc(d.keyword)}</td><td>${esc(d.match)}</td>
        <td class="num" data-sort="${d.qs || 0}">${d.qs || "—"}</td>
        <td class="num" data-sort="${d.clicks}">${fmt.num(d.clicks)}</td>
        <td class="num" data-sort="${d.cost}">${fmt.money(d.cost)}</td>
        <td class="num" data-sort="${d.conv}">${fmt.num(d.conv, 1)}</td>
        <td class="num" data-sort="${d.cpa}">${fmt.money(d.cpa, 2)}</td></tr>`).join("");
    el.innerHTML = stHead("Keyword Deep Dive", "Top keywords by spend · upload a region-segmented keyword export to unlock the keyword × region heatmap") +
      `<div class="panel"><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>Keyword</th><th>Match</th><th class="num">QS</th><th class="num">Clicks</th>
          <th class="num">Cost</th><th class="num">Conv</th><th class="num">CPA</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }
  let QSB_METRIC = "cpc", QSB_CAT = "all", QSB_REG = "all", QSB_FILTER = "";
  const QSB_RATINGS = ["Above average", "Average", "Below average"];
  const qsPill = r => {
    const st = r === "Above average" ? "background:#DCFCE7;color:#166534"
      : r === "Below average" ? "background:#FCE7CE;color:#9A5B1E"
      : r === "Average" ? "background:#FEF3C7;color:#92660A" : "background:#eee;color:#666";
    return `<span class="tag" style="${st};font-size:10px">${esc(r)}</span>`;
  };
  function renderQsBreakdown(el) {
    el.className = "view";
    const q = (typeof DATA !== "undefined" && DATA.qs_breakdown_section) || null;
    if (!q) { el.innerHTML = stHead("Quality Score Breakdown", "") + `<div class="panel">No Quality Score component data.</div>`; return; }
    if (!document.getElementById("qsbStyle")) {
      const s = document.createElement("style"); s.id = "qsbStyle";
      s.textContent = `
        .qsb-grouphead td{background:var(--ink,#1a1a1a);color:#fff;font-weight:700;font-size:11px;letter-spacing:.04em;padding:9px 12px;text-transform:uppercase}
        .qsb-badge{display:inline-block;background:var(--lime,#CFFF04);color:var(--ink,#1a1a1a);font-weight:800;border-radius:4px;padding:1px 7px;margin-right:8px}
        .qsb-grid{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
        .qsb-grid th,.qsb-grid td{padding:9px 12px;border-bottom:1px solid var(--line,#eee)}
        .qsb-grid thead th.qsb-hd{background:var(--ink,#1a1a1a);color:#fff;font-size:11px;letter-spacing:.03em;text-transform:uppercase}
        .qsb-grid td.qsb-ectr{vertical-align:middle;background:#FAFAF7;border-right:2px solid var(--line,#eee)}
        .qsb-grid td.qsb-cell{text-align:center;font-variant-numeric:tabular-nums}`;
      document.head.appendChild(s);
    }
    const scope = q.non_brand ? "non-brand" : "";
    const vsAvg = v => v == null ? "—" : `<span class="chg ${v <= 0 ? "up" : "dn"}">${(v >= 0 ? "+" : "") + (v * 100).toFixed(1)}%</span>`;

    // ---- Section 1: component analysis ----
    const compTable = `
      <div class="panel">
        <h3>Quality Score Component Analysis <span class="muted" style="font-weight:400">· portfolio total</span></h3>
        <div class="muted" style="margin-bottom:10px">All three Quality Score components stacked in one table. Each component breaks keywords into Above / Average / Below average ratings with performance context.</div>
        <div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>Rating</th><th class="num">Keywords</th><th class="num">% of KWs</th><th class="num">Spend</th>
            <th class="num">Avg CPC</th><th class="num">CTR</th><th class="num">Conv Rate</th><th class="num">CPA</th>
            <th class="num">Conversions</th><th class="num">CPC vs Avg</th></tr></thead>
          <tbody>${q.components.map(c => `
            <tr class="qsb-grouphead"><td colspan="10"><span class="qsb-badge">${c.num}</span>${esc(c.label)}</td></tr>
            ${c.ratings.map(r => `<tr>
              <td>${qsPill(r.rating)}</td>
              <td class="num">${fmt.num(r.keywords)}</td><td class="num">${fmt.pct(r.kw_share, 1)}</td>
              <td class="num">${fmt.money(r.spend)}</td><td class="num">${fmt.money(r.cpc, 2)}</td>
              <td class="num">${fmt.pct(r.ctr, 2)}</td><td class="num">${fmt.pct(r.conv_rate, 2)}</td>
              <td class="num">${r.cpa ? fmt.money(r.cpa, 2) : "—"}</td><td class="num">${fmt.num(r.conv, 0)}</td>
              <td class="num">${vsAvg(r.cpc_vs_avg)}</td></tr>`).join("")}`).join("")}
          </tbody></table></div>
      </div>`;

    // ---- Section 2: 27-combination grid ----
    const G = {};
    q.grid.forEach(c => { (G[c.ectr] = G[c.ectr] || {}); (G[c.ectr][c.lp_exp] = G[c.ectr][c.lp_exp] || {}); G[c.ectr][c.lp_exp][c.ad_rel] = c; });
    const mk = QSB_METRIC, higherGood = mk === "qs";
    const gvals = q.grid.filter(c => c.keywords > 0).map(c => c[mk]);
    const mn = gvals.length ? Math.min(...gvals) : 0, mx = gvals.length ? Math.max(...gvals) : 0;
    const fmtCell = v => mk === "cpc" ? fmt.money(v, 2) : mk === "spend" ? fmt.money(v) : v.toFixed(1);
    const cellHtml = (ectr, lp, ad) => {
      const c = G[ectr] && G[ectr][lp] && G[ectr][lp][ad];
      if (!c || !c.keywords) return `<td class="qsb-cell" style="color:#cbd0c7">·</td>`;
      const v = c[mk], t = mx > mn ? (higherGood ? 1 - (v - mn) / (mx - mn) : (v - mn) / (mx - mn)) : 0.5;
      return `<td class="qsb-cell" style="${heatT(t)}" title="${c.keywords} kw">${fmtCell(v)}</td>`;
    };
    const seg = (v, l) => `<button class="seg-pill ${QSB_METRIC === v ? "active" : ""}" data-qsb="${v}">${l}</button>`;
    const gridBody = QSB_RATINGS.map(ectr => QSB_RATINGS.map((lp, li) => `<tr>
        ${li === 0 ? `<td rowspan="3" class="qsb-ectr"><strong>${esc(ectr)}</strong><div class="muted" style="font-size:11px">${fmt.pct(q.grid_meta.ectr_spend_share[ectr], 1)} of spend</div></td>` : ""}
        <td>${qsPill(lp)}</td>${QSB_RATINGS.map(ad => cellHtml(ectr, lp, ad)).join("")}</tr>`).join("")).join("");
    const gridPanel = `
      <div class="panel">
        <h3>All three components: Expected CTR × LP Experience × Ad Relevance</h3>
        <div class="muted" style="margin-bottom:12px">All 27 component combinations. Row-pairs group by Expected CTR; within each group rows are LP Experience and columns are Ad Relevance. Toggle the metric to see avg CPC, spend volume, or the resulting average Quality Score.</div>
        <div class="seg-group" style="margin-bottom:12px">${seg("cpc", "Avg CPC")}${seg("spend", "Spend")}${seg("qs", "Avg Quality Score")}</div>
        <div class="tbl-wrap"><table class="qsb-grid">
          <thead>
            <tr><th class="qsb-hd">Expected CTR</th><th class="qsb-hd">LP Experience</th><th class="qsb-hd" colspan="3" style="text-align:center">Ad Relevance →</th></tr>
            <tr><th></th><th></th>${QSB_RATINGS.map(ad => `<th style="text-align:center">${qsPill(ad)}</th>`).join("")}</tr>
          </thead>
          <tbody>${gridBody}</tbody></table></div>
        <div class="muted" style="text-align:right;margin-top:8px">${higherGood ? "Higher = better" : "Higher = more expensive"} &nbsp; <span class="tag" style="background:#DCFCE7">Good</span> <span class="tag" style="background:#FEF3C7">Mid</span> <span class="tag" style="background:#F3C9BF">Costly</span></div>
      </div>`;

    // ---- Section 3: savings by brand ----
    const sv = q.savings_by_brand;
    const svT = sv.reduce((a, r) => { a.kws += r.kws_weak; a.sp += r.spend_weak; a.sav += r.savings; return a; }, { kws: 0, sp: 0, sav: 0 });
    const savPanel = `
      <div class="panel">
        <h3>Estimated monthly savings by brand <span class="muted" style="font-weight:400">if QS ≤ 5 → QS 7</span></h3>
        <div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>Brand</th><th class="num">KWs at QS ≤ 5</th><th class="num">Spend at QS ≤ 5</th>
            <th class="num">Current CPC</th><th class="num">Target CPC (QS 7)</th><th class="num">Est. Savings</th>
            <th class="num">% of Brand Spend</th><th>Primary Component Gap</th></tr></thead>
          <tbody>${sv.map(r => `<tr>
            <td class="strong">${esc(r.brand)}</td><td class="num">${fmt.num(r.kws_weak)}</td>
            <td class="num">${fmt.money(r.spend_weak)}</td><td class="num">${fmt.money(r.cpc_current, 2)}</td>
            <td class="num">${fmt.money(r.cpc_target, 2)}</td><td class="num">${fmt.money(r.savings)}</td>
            <td class="num">${fmt.pct(r.pct_brand_spend, 2)}</td><td>${esc(r.primary_gap)}</td></tr>`).join("")}
            <tr class="strong"><td>Total</td><td class="num">${fmt.num(svT.kws)}</td><td class="num">${fmt.money(svT.sp)}</td>
              <td></td><td></td><td class="num">${fmt.money(svT.sav)}</td><td></td><td></td></tr>
          </tbody></table></div>
      </div>`;

    // ---- Section 4: top optimization keywords ----
    const ok = q.opt_keywords;
    const optRow = r => `<tr>
        <td class="strong">${esc(r.keyword)}</td><td>${esc(r.brand)}</td>
        <td>${r.region === "—" ? '<span class="muted">—</span>' : esc(r.region)}</td>
        <td>${r.category === "—" ? '<span class="muted">—</span>' : `<span class="tag info">${esc(r.category)}</span>`}</td>
        <td class="num">${r.qs}</td><td class="num">${fmt.money(r.spend)}</td><td class="num">${fmt.money(r.cpc, 2)}</td>
        <td class="num">${fmt.num(r.clicks)}</td><td>${qsPill(r.ectr)}</td><td>${qsPill(r.ad_rel)}</td>
        <td>${qsPill(r.lp_exp)}</td><td class="num">${fmt.num(r.conv, 1)}</td></tr>`;
    const filterRows = () => {
      let rws = ok.rows;
      if (QSB_CAT !== "all") rws = rws.filter(r => r.category === QSB_CAT);
      if (QSB_REG !== "all") rws = rws.filter(r => r.region === QSB_REG);
      if (QSB_FILTER) { const f = QSB_FILTER.toLowerCase(); rws = rws.filter(r => (r.keyword + " " + r.region + " " + r.category).toLowerCase().indexOf(f) >= 0); }
      return rws;
    };
    const shown = filterRows();
    const catOpts = ['<option value="all">All categories</option>'].concat(ok.categories.map(c => `<option value="${esc(c)}"${QSB_CAT === c ? " selected" : ""}>${esc(c)}</option>`)).join("");
    const regOpts = ['<option value="all">All regions</option>'].concat(ok.regions.map(c => `<option value="${esc(c)}"${QSB_REG === c ? " selected" : ""}>${esc(c)}</option>`)).join("");
    const optPanel = `
      <div class="panel">
        <h3>Top optimization keywords <span class="muted" style="font-weight:400">QS ≤ 6, sorted by spend</span></h3>
        <div class="toolbar">
          <input type="text" id="qsbFilter" placeholder="Filter keyword, region, category…" value="${esc(QSB_FILTER)}" style="min-width:240px"/>
          <label>Category:</label><select id="qsbCat">${catOpts}</select>
          ${ok.has_region ? `<label>Region:</label><select id="qsbReg">${regOpts}</select>` : ""}
          <span class="muted" id="qsbCount" style="margin-left:auto">Showing ${fmt.num(shown.length)} of ${fmt.num(ok.total)}${ok.total > ok.shown ? ` · top ${ok.shown} loaded` : ""}</span>
        </div>
        <div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>Keyword</th><th>Brand</th><th>Region</th><th>Category</th><th class="num">QS</th>
            <th class="num">Spend</th><th class="num">CPC</th><th class="num">Clicks</th><th>eCTR</th><th>Ad Rel</th><th>LP Exp</th><th class="num">Conv</th></tr></thead>
          <tbody id="qsbOptBody">${shown.map(optRow).join("")}</tbody></table></div>
      </div>`;

    el.innerHTML = stHead("Quality Score Breakdown", `Component-level ratings (eCTR, Ad Relevance, LP Experience) and the top optimization opportunities${scope ? " · " + scope + " keywords" : ""}`) +
      compTable + gridPanel + savPanel + optPanel;

    el.querySelectorAll("[data-qsb]").forEach(b => b.addEventListener("click", () => { QSB_METRIC = b.dataset.qsb; setView("qs-breakdown", { preserveScroll: true }); }));
    const cf = el.querySelector("#qsbCat"); if (cf) cf.addEventListener("change", () => { QSB_CAT = cf.value; setView("qs-breakdown", { preserveScroll: true }); });
    const rf = el.querySelector("#qsbReg"); if (rf) rf.addEventListener("change", () => { QSB_REG = rf.value; setView("qs-breakdown", { preserveScroll: true }); });
    const tf = el.querySelector("#qsbFilter");
    if (tf) tf.addEventListener("input", () => {                     // live filter without losing focus
      QSB_FILTER = tf.value; const rws = filterRows();
      const body = el.querySelector("#qsbOptBody"); if (body) body.innerHTML = rws.map(optRow).join("");
      const cnt = el.querySelector("#qsbCount"); if (cnt) cnt.textContent = `Showing ${fmt.num(rws.length)} of ${fmt.num(ok.total)}${ok.total > ok.shown ? ` · top ${ok.shown} loaded` : ""}`;
    });
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Region & Category — CPC by component rating ----------
  let RC_COMP = "exp_ctr", RC_CAT = "all", RC_REG = "all", RC_FILTER = "";
  function renderRegionCategory(el) {
    el.className = "view";
    const rc = (typeof DATA !== "undefined" && DATA.region_category_section) || null;
    if (!rc || !rc.components || !rc.components.length) {
      el.innerHTML = stHead("Region &amp; Category", "") + `<div class="panel">Upload a region-segmented keyword export (joined to Quality Score data) to unlock the Brand × Region × Category CPC breakdown.</div>`;
      return;
    }
    const comp = rc.components.find(c => c.key === RC_COMP) || rc.components[0];
    RC_COMP = comp.key;
    const money = v => v == null ? '<span class="muted">—</span>' : fmt.money(v, 2);
    const spread = v => v == null ? '<span class="muted">—</span>' : `<span class="chg ${v >= 0 ? "dn" : "up"}">${(v >= 0 ? "+" : "") + fmt.money(v, 2)}</span>`;
    const rowFn = r => `<tr>
        <td class="strong">${esc(r.brand)}</td><td>${esc(r.region)}</td>
        <td>${r.category === "Uncategorized" ? '<span class="muted">Uncategorized</span>' : `<span class="tag info">${esc(r.category)}</span>`}</td>
        <td class="num">${fmt.money(r.total_spend)}</td>
        <td class="num">${money(r.below_cpc)}</td><td class="num">${fmt.num(r.below_clicks)}</td>
        <td class="num">${money(r.avg_cpc)}</td><td class="num">${fmt.num(r.avg_clicks)}</td>
        <td class="num">${money(r.above_cpc)}</td><td class="num">${fmt.num(r.above_clicks)}</td>
        <td class="num">${spread(r.spread)}</td></tr>`;
    const filterRows = () => {
      let rws = comp.rows;
      if (RC_CAT !== "all") rws = rws.filter(r => r.category === RC_CAT);
      if (RC_REG !== "all") rws = rws.filter(r => r.region === RC_REG);
      if (RC_FILTER) { const f = RC_FILTER.toLowerCase(); rws = rws.filter(r => (r.brand + " " + r.region + " " + r.category).toLowerCase().indexOf(f) >= 0); }
      return rws;
    };
    const shown = filterRows();
    const cbtn = c => `<button class="seg-pill ${RC_COMP === c.key ? "active" : ""}" data-rc="${c.key}">${esc(c.label)}</button>`;
    const catOpts = ['<option value="all">All categories</option>'].concat(rc.categories.map(c => `<option value="${esc(c)}"${RC_CAT === c ? " selected" : ""}>${esc(c)}</option>`)).join("");
    const regOpts = ['<option value="all">All regions</option>'].concat(rc.regions.map(c => `<option value="${esc(c)}"${RC_REG === c ? " selected" : ""}>${esc(c)}</option>`)).join("");
    el.innerHTML = stHead("Region &amp; Category · CPC by component rating",
        "For each Brand × Region × Category slice, compare avg CPC when the keyword's component rating is Below Avg, Average, or Above Avg.") +
      `<div class="seg-group" style="margin-bottom:14px">${rc.components.map(cbtn).join("")}</div>
       <div class="panel">
         <div class="toolbar">
           <input type="text" id="rcFilter" placeholder="Filter brand, region, category…" value="${esc(RC_FILTER)}" style="min-width:240px"/>
           <label>Category:</label><select id="rcCat">${catOpts}</select>
           <label>Region:</label><select id="rcReg">${regOpts}</select>
           <span class="muted" id="rcCount" style="margin-left:auto">Showing ${fmt.num(shown.length)} of ${fmt.num(comp.total)}</span>
         </div>
         <div class="muted" style="margin-bottom:8px">Showing: <strong>${esc(comp.label)}</strong>. "CPC Spread" = Below CPC − Above CPC. Larger spread = higher financial pain when a component drops to Below Avg.</div>
         <div class="tbl-wrap"><table class="sortable">
           <thead><tr><th>Brand</th><th>Region</th><th>Category</th><th class="num">Total Spend</th>
             <th class="num">Below CPC</th><th class="num">Below Clicks</th><th class="num">Avg CPC</th><th class="num">Avg Clicks</th>
             <th class="num">Above CPC</th><th class="num">Above Clicks</th><th class="num">CPC Spread</th></tr></thead>
           <tbody id="rcBody">${shown.map(rowFn).join("")}</tbody></table></div>
       </div>`;
    el.querySelectorAll("[data-rc]").forEach(b => b.addEventListener("click", () => { RC_COMP = b.dataset.rc; setView("region-category", { preserveScroll: true }); }));
    const cf = el.querySelector("#rcCat"); if (cf) cf.addEventListener("change", () => { RC_CAT = cf.value; setView("region-category", { preserveScroll: true }); });
    const rf = el.querySelector("#rcReg"); if (rf) rf.addEventListener("change", () => { RC_REG = rf.value; setView("region-category", { preserveScroll: true }); });
    const tf = el.querySelector("#rcFilter");
    if (tf) tf.addEventListener("input", () => {
      RC_FILTER = tf.value; const rws = filterRows();
      const body = el.querySelector("#rcBody"); if (body) body.innerHTML = rws.map(rowFn).join("");
      const cnt = el.querySelector("#rcCount"); if (cnt) cnt.textContent = `Showing ${fmt.num(rws.length)} of ${fmt.num(comp.total)}`;
    });
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Ad Copy section ----------
  let AC_GROUP = "nonbranded", AC_CAT = "all", AC_REG = "all", AC_GRADE = "all", AC_FILTER = "";
  function renderAdCopy(el) {
    el.className = "view"; const a = (typeof DATA !== "undefined" && DATA.ads_section) || null;
    const ac = a && a.ad_copy;
    if (!ac) { el.innerHTML = stHead("Ad Copy", "") + `<div class="panel">No ad data.</div>`; return; }
    if (!ac[AC_GROUP]) AC_GROUP = ac.nonbranded ? "nonbranded" : "branded";
    const g = ac[AC_GROUP];
    const label = AC_GROUP === "branded" ? "Branded" : "Non-Branded";
    const gseg = k => `<button class="seg-pill ${AC_GROUP === k ? "active" : ""}" data-acg="${k}">${k === "branded" ? "Branded" : "Non-Branded"}</button>`;
    const gradeRows = g.grades.map(r => `<tr>
        <td>${stGradePill(r.grade)}</td><td class="num">${fmt.num(r.ads)}</td><td class="num">${fmt.num(r.impr)}</td>
        <td class="num">${fmt.num(r.clicks)}</td><td class="num">${fmt.pct(r.ctr, 2)}</td><td class="num">${fmt.money(r.spend)}</td>
        <td class="num">${fmt.pct(r.spend_share, 1)}</td><td class="num">${fmt.num(r.conv, 0)}</td><td class="num">${fmt.pct(r.cvr, 2)}</td></tr>`).join("");
    const rowFn = r => `<tr>
        <td class="strong">${esc(r.brand)}</td>
        <td>${r.category === "Uncategorized" ? '<span class="muted">Uncategorized</span>' : `<span class="tag info">${esc(r.category)}</span>`}</td>
        <td>${r.region === "—" ? '<span class="muted">—</span>' : esc(r.region)}</td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.ad_group)}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="muted" style="font-size:11.5px">${esc(r.headline)}</span></td>
        <td>${stGradePill(r.grade)}</td><td class="num">${fmt.pct(r.ctr, 2)}</td><td class="num">${fmt.num(r.impr)}</td>
        <td class="num">${fmt.num(r.clicks)}</td><td class="num">${fmt.money(r.cpc, 2)}</td><td class="num">${fmt.money(r.spend)}</td>
        <td class="num">${fmt.num(r.conv, 1)}</td><td class="num">${fmt.pct(r.cvr, 2)}</td></tr>`;
    const filterRows = () => {
      let rws = g.rows;
      if (AC_CAT !== "all") rws = rws.filter(r => r.category === AC_CAT);
      if (AC_REG !== "all") rws = rws.filter(r => r.region === AC_REG);
      if (AC_GRADE !== "all") rws = rws.filter(r => r.grade === AC_GRADE);
      if (AC_FILTER) { const f = AC_FILTER.toLowerCase(); rws = rws.filter(r => (r.ad_group + " " + r.headline + " " + r.region + " " + r.category).toLowerCase().indexOf(f) >= 0); }
      return rws;
    };
    const shown = filterRows();
    const opts = (list, cur) => ['<option value="all">All</option>'].concat(list.map(x => `<option value="${esc(x)}"${cur === x ? " selected" : ""}>${esc(x)}</option>`)).join("");
    el.innerHTML = `
      <div class="view-head"><div><h2>Ad Copy · ${label}</h2>
        <div class="muted">Ad-level performance graded by CTR. Branded and non-branded are graded on different scales (branded CTRs are naturally much higher).</div></div>
        <div class="seg-group">${gseg("nonbranded")}${gseg("branded")}</div></div>
      <div class="panel"><h3>Performance grades · ad counts · ${label}</h3>
        <div class="muted" style="margin-bottom:8px">${esc(ac.thresholds[AC_GROUP])}</div>
        <div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>Grade</th><th class="num">Ads</th><th class="num">Impressions</th><th class="num">Clicks</th><th class="num">CTR</th>
            <th class="num">Spend</th><th class="num">% of Spend</th><th class="num">Conv</th><th class="num">CVR</th></tr></thead>
          <tbody>${gradeRows}</tbody></table></div></div>
      <div class="panel">
        <div class="toolbar">
          <input type="text" id="acFilter" placeholder="Filter ad group / headline / region…" value="${esc(AC_FILTER)}" style="min-width:240px"/>
          <label>Category:</label><select id="acCat">${opts(g.categories, AC_CAT)}</select>
          ${g.has_region ? `<label>Region:</label><select id="acReg">${opts(g.regions, AC_REG)}</select>` : ""}
          <label>Grade:</label><select id="acGrade">${opts(g.grade_labels, AC_GRADE)}</select>
          <span class="muted" id="acCount" style="margin-left:auto">Showing ${fmt.num(shown.length)} of ${fmt.num(g.count)}${g.count > g.rows.length ? ` · top ${g.rows.length} by spend` : ""}</span>
        </div>
        <div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>Brand</th><th>Category</th><th>Region</th><th>Ad Group</th><th>Headline</th><th>Grade</th>
            <th class="num">CTR</th><th class="num">Impr</th><th class="num">Clicks</th><th class="num">CPC</th><th class="num">Spend</th><th class="num">Conv</th><th class="num">CVR</th></tr></thead>
          <tbody id="acBody">${shown.map(rowFn).join("")}</tbody></table></div>
      </div>`;
    el.querySelectorAll("[data-acg]").forEach(b => b.addEventListener("click", () => { AC_GROUP = b.dataset.acg; AC_CAT = "all"; AC_REG = "all"; AC_GRADE = "all"; setView("ad-copy", { preserveScroll: true }); }));
    const bind = (id, set) => { const e = el.querySelector(id); if (e) e.addEventListener("change", () => { set(e.value); setView("ad-copy", { preserveScroll: true }); }); };
    bind("#acCat", v => AC_CAT = v); bind("#acReg", v => AC_REG = v); bind("#acGrade", v => AC_GRADE = v);
    const tf = el.querySelector("#acFilter");
    if (tf) tf.addEventListener("input", () => {
      AC_FILTER = tf.value; const rws = filterRows();
      const body = el.querySelector("#acBody"); if (body) body.innerHTML = rws.map(rowFn).join("");
      const cnt = el.querySelector("#acCount"); if (cnt) cnt.textContent = `Showing ${fmt.num(rws.length)} of ${fmt.num(g.count)}${g.count > g.rows.length ? ` · top ${g.rows.length} by spend` : ""}`;
    });
    if (typeof enableSortable === "function") enableSortable(el);
  }
  const kmoney = v => { const n = Math.round(v || 0); return n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" : "$" + n; };
  const pairStyle = (ctr, cvr) => {
    const cS = ctr[0] === "A" || ctr[0] === "B", cW = ctr[0] === "D" || ctr[0] === "F";
    const vS = cvr[0] === "A" || cvr[0] === "B", vW = cvr[0] === "D" || cvr[0] === "F";
    if (cS && vS) return "background:#DCFCE7"; if (cS && vW) return "background:#FEE2E2";
    if (cW && vS) return "background:#FEF3C7"; return "";
  };
  let ALP_GROUP = "nonbranded", ALP_CAT = "all", ALP_REG = "all", ALP_FILTER = "", ALP_CELL = null;
  function renderAdLp(el) {
    el.className = "view"; const a = (typeof DATA !== "undefined" && DATA.ads_section) || null;
    const ac = a && a.ad_copy;
    if (!ac) { el.innerHTML = stHead("Ad &harr; LP Pairing", "") + `<div class="panel">No ad data.</div>`; return; }
    if (!ac[ALP_GROUP]) ALP_GROUP = ac.nonbranded ? "nonbranded" : "branded";
    const g = ac[ALP_GROUP], P = g.pairing, S = g.stats, label = ALP_GROUP === "branded" ? "Branded" : "Non-Branded";
    const gseg = k => `<button class="seg-pill ${ALP_GROUP === k ? "active" : ""}" data-alpg="${k}">${k === "branded" ? "Branded" : "Non-Branded"}</button>`;
    // stat cards
    const cards = `
      <div class="stat"><div class="stat-label">Total ads</div><div class="stat-value">${fmt.num(S.total)}</div></div>
      <div class="stat hl"><div class="stat-label">Aligned · A/B ad + A/B LP</div><div class="stat-value">${fmt.num(S.aligned)}</div><div class="stat-chg">${fmt.pct(S.aligned_pct, 1)} of ads</div></div>
      <div class="stat"><div class="stat-label">Good ad · weak LP <span class="tag" style="background:#FEE2E2;color:#991B1B">FIX LP</span></div><div class="stat-value">${fmt.num(S.fix_lp)}</div><div class="stat-chg">A/B ad CTR → D/F LP CVR</div></div>
      <div class="stat"><div class="stat-label">Weak ad · good LP <span class="tag" style="background:#FEF3C7;color:#92660A">FIX AD</span></div><div class="stat-value">${fmt.num(S.fix_ad)}</div><div class="stat-chg">D/F ad CTR · A/B LP CVR</div></div>
      <div class="stat"><div class="stat-label">Low Volume</div><div class="stat-value">${fmt.num(S.low_vol)}</div><div class="stat-chg">&lt; 100 imp or &lt; 5 clicks</div></div>`;
    // pairing grid
    const headCols = P.grades.map(c => `<th>${stGradePill(c)}</th>`).join("");
    const bodyRows = P.rows.map(row => `<tr>
        <td>${stGradePill(row.ctr_grade)}</td>
        ${row.cols.map(c => {
          const sel = ALP_CELL && ALP_CELL[0] === row.ctr_grade && ALP_CELL[1] === c.cvr_grade;
          if (!c.ads) return `<td class="pair-cell muted" style="text-align:center">·</td>`;
          return `<td class="pair-cell" data-ctr="${esc(row.ctr_grade)}" data-cvr="${esc(c.cvr_grade)}" style="${pairStyle(row.ctr_grade, c.cvr_grade)};cursor:pointer${sel ? ";outline:2px solid #1A1A1A;outline-offset:-2px" : ""}">
            <strong>${fmt.num(c.ads)}</strong> <span class="muted">(${kmoney(c.spend)})</span><div class="muted" style="font-size:10px">${(c.pct * 100).toFixed(1)}% of ads</div></td>`;
        }).join("")}
        <td class="num strong">${fmt.num(row.total_ads)}<div class="muted" style="font-size:10px">${kmoney(row.total_spend)}</div></td></tr>`).join("");
    const totalRow = `<tr class="strong"><td>Total</td>${P.col_totals.map(c => `<td class="num">${fmt.num(c.ads)}<div class="muted" style="font-size:10px">${kmoney(c.spend)}</div></td>`).join("")}<td class="num">${fmt.num(P.grand_ads)}<div class="muted" style="font-size:10px">${kmoney(P.grand_spend)}</div></td></tr>`;
    // ad list
    const rowFn = r => `<tr>
        <td class="strong">${esc(r.brand)}</td>
        <td>${r.category === "Uncategorized" ? '<span class="muted">Uncategorized</span>' : `<span class="tag info">${esc(r.category)}</span>`}</td>
        <td>${r.region === "—" ? '<span class="muted">—</span>' : esc(r.region)}</td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.ad_group)}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="muted" style="font-size:11.5px">${esc(r.headline)}</span></td>
        <td>${stGradePill(r.grade)}</td><td class="num">${fmt.pct(r.ctr, 2)}</td><td class="num">${fmt.num(r.impr)}</td>
        <td class="num">${fmt.num(r.clicks)}</td><td class="num">${fmt.money(r.cpc, 2)}</td><td class="num">${fmt.money(r.spend)}</td>
        <td class="num">${fmt.num(r.conv, 1)}</td><td class="num">${fmt.pct(r.cvr, 2)}</td></tr>`;
    const filterRows = () => {
      let rws = g.rows;
      if (ALP_CELL) rws = rws.filter(r => r.ctr_grade === ALP_CELL[0] && r.lp_grade === ALP_CELL[1]);
      if (ALP_CAT !== "all") rws = rws.filter(r => r.category === ALP_CAT);
      if (ALP_REG !== "all") rws = rws.filter(r => r.region === ALP_REG);
      if (ALP_FILTER) { const f = ALP_FILTER.toLowerCase(); rws = rws.filter(r => (r.ad_group + " " + r.headline + " " + r.region + " " + r.category).toLowerCase().indexOf(f) >= 0); }
      return rws;
    };
    const shown = filterRows();
    const opts = (list, cur) => ['<option value="all">All</option>'].concat(list.map(x => `<option value="${esc(x)}"${cur === x ? " selected" : ""}>${esc(x)}</option>`)).join("");
    const cellLabel = ALP_CELL ? `${ALP_CELL[0].split(" ")[0]} ad × ${ALP_CELL[1].split(" ")[0]} LP` : "All cells";
    el.innerHTML = `
      <div class="view-head"><div><h2>Ad &harr; LP Pairing · ${label}</h2>
        <div class="muted">Ad performance graded by CTR × landing-page performance graded by CVR (from ad-level conversion). Click any grid cell to filter the ad list below.</div></div>
        <div class="seg-group">${gseg("nonbranded")}${gseg("branded")}</div></div>
      <div class="stat-grid">${cards}</div>
      <div class="panel"><h3>Pairing grid · ads by Ad-CTR grade (rows) × LP-CVR grade (cols) · ${label}</h3>
        <div class="tbl-wrap"><table class="qsb-grid">
          <thead><tr><th>AD CTR ↓ &nbsp; LP CVR →</th>${headCols}<th>Total</th></tr></thead>
          <tbody>${bodyRows}${totalRow}</tbody></table></div>
        <div class="muted" style="margin-top:8px"><span class="tag" style="background:#DCFCE7">Aligned</span> both strong · <span class="tag" style="background:#FEE2E2">Fix LP</span> high-CTR ad on low-converting LP · <span class="tag" style="background:#FEF3C7">Fix Ad</span> good LP, weak ad copy</div></div>
      <div class="panel">
        <div class="toolbar">
          <button class="multi-btn" id="alpAll">${esc(cellLabel)}${ALP_CELL ? " ✕" : ""}</button>
          <input type="text" id="alpFilter" placeholder="Filter ad group / headline / region…" value="${esc(ALP_FILTER)}" style="min-width:220px"/>
          <label>Category:</label><select id="alpCat">${opts(g.categories, ALP_CAT)}</select>
          ${g.has_region ? `<label>Region:</label><select id="alpReg">${opts(g.regions, ALP_REG)}</select>` : ""}
          <span class="muted" id="alpCount" style="margin-left:auto">Showing ${fmt.num(shown.length)} of ${fmt.num(g.count)}${g.count > g.rows.length ? ` · top ${g.rows.length} by spend` : ""}</span>
        </div>
        <div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>Brand</th><th>Category</th><th>Region</th><th>Ad Group</th><th>Headline</th><th>Grade</th>
            <th class="num">CTR</th><th class="num">Impr</th><th class="num">Clicks</th><th class="num">CPC</th><th class="num">Spend</th><th class="num">Conv</th><th class="num">CVR</th></tr></thead>
          <tbody id="alpBody">${shown.map(rowFn).join("")}</tbody></table></div>
      </div>`;
    el.querySelectorAll("[data-alpg]").forEach(b => b.addEventListener("click", () => { ALP_GROUP = b.dataset.alpg; ALP_CELL = null; ALP_CAT = "all"; ALP_REG = "all"; setView("ad-lp", { preserveScroll: true }); }));
    el.querySelectorAll(".pair-cell[data-ctr]").forEach(c => c.addEventListener("click", () => { ALP_CELL = [c.dataset.ctr, c.dataset.cvr]; setView("ad-lp", { preserveScroll: true }); }));
    const allBtn = el.querySelector("#alpAll"); if (allBtn) allBtn.addEventListener("click", () => { ALP_CELL = null; setView("ad-lp", { preserveScroll: true }); });
    const bind = (id, set) => { const e = el.querySelector(id); if (e) e.addEventListener("change", () => { set(e.value); setView("ad-lp", { preserveScroll: true }); }); };
    bind("#alpCat", v => ALP_CAT = v); bind("#alpReg", v => ALP_REG = v);
    const tf = el.querySelector("#alpFilter");
    if (tf) tf.addEventListener("input", () => {
      ALP_FILTER = tf.value; const rws = filterRows();
      const body = el.querySelector("#alpBody"); if (body) body.innerHTML = rws.map(rowFn).join("");
      const cnt = el.querySelector("#alpCount"); if (cnt) cnt.textContent = `Showing ${fmt.num(rws.length)} of ${fmt.num(g.count)}${g.count > g.rows.length ? ` · top ${g.rows.length} by spend` : ""}`;
    });
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Landing Pages section ----------
  const lpScoreBadge = s => {
    const m = { "Excellent": "background:#DCFCE7;color:#166534", "Strong": "background:#D1FAE5;color:#065F46",
      "Average": "background:#DBEAFE;color:#1E40AF", "Below Avg": "background:#FEF3C7;color:#92660A" };
    return `<span class="tag" style="${m[s] || "background:#eee;color:#666"};font-size:10.5px">${esc(s)}</span>`;
  };
  let LPP_FILTER = "";
  function renderLpPerf(el) {
    el.className = "view"; const l = (typeof DATA !== "undefined" && DATA.landing_pages_section) || null;
    const perf = l && l.performance;
    if (!perf || !perf.length) {   // fallback: LP-report rows (no conversions)
      if (!l) { el.innerHTML = stHead("Landing Page Performance", "") + `<div class="panel">No landing-page data.</div>`; return; }
      const rows = l.rows.map(r => { const u = r.url || ""; return `<tr>
          <td class="strong" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>` : "—"}</td>
          <td class="num">${fmt.num(r.clicks)}</td><td class="num">${fmt.num(r.impr)}</td>
          <td class="num">${fmt.pct(r.ctr, 2)}</td><td class="num">${fmt.money(r.cost)}</td>
          <td class="num">${r.speed == null ? "—" : r.speed}</td></tr>`; }).join("");
      el.innerHTML = stHead("Landing Page Performance", `${l.count} landing pages · by spend`) +
        `<div class="panel"><div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>URL</th><th class="num">Clicks</th><th class="num">Impr</th><th class="num">CTR</th><th class="num">Cost</th><th class="num">Mobile speed</th></tr></thead>
          <tbody>${rows}</tbody></table></div></div>`;
      if (typeof enableSortable === "function") enableSortable(el);
      return;
    }
    const rowFn = r => { const u = r.url || ""; return `<tr>
        <td class="strong" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>` : "—"}</td>
        <td class="num">${fmt.money(r.cost)}</td><td class="num">${fmt.num(r.clicks)}</td><td class="num">${fmt.num(r.conv, 0)}</td>
        <td class="num">${fmt.pct(r.cvr, 2)}</td><td class="num">${r.cpa ? fmt.money(r.cpa, 2) : "—"}</td>
        <td>${lpScoreBadge(r.score)}</td></tr>`; };
    const filterRows = () => LPP_FILTER ? perf.filter(r => (r.url || "").toLowerCase().indexOf(LPP_FILTER.toLowerCase()) >= 0) : perf;
    const shown = filterRows();
    el.innerHTML = stHead("Landing Page Performance", `Top ${fmt.num(perf.length)} landing pages by spend · quality score`) +
      `<div class="panel">
         <div class="toolbar"><input type="text" id="lppFilter" placeholder="Filter URL…" value="${esc(LPP_FILTER)}" style="min-width:260px"/>
           <span class="muted" id="lppCount" style="margin-left:auto">Showing ${fmt.num(shown.length)} of ${fmt.num(perf.length)}</span></div>
         <div class="tbl-wrap"><table class="sortable">
           <thead><tr><th>URL</th><th class="num">Cost</th><th class="num">Clicks</th><th class="num">Conv</th>
             <th class="num">CVR</th><th class="num">CPA</th><th>Score</th></tr></thead>
           <tbody id="lppBody">${shown.map(rowFn).join("")}</tbody></table></div>
       </div>`;
    const tf = el.querySelector("#lppFilter");
    if (tf) tf.addEventListener("input", () => {
      LPP_FILTER = tf.value; const rws = filterRows();
      const body = el.querySelector("#lppBody"); if (body) body.innerHTML = rws.map(rowFn).join("");
      const cnt = el.querySelector("#lppCount"); if (cnt) cnt.textContent = `Showing ${fmt.num(rws.length)} of ${fmt.num(perf.length)}`;
    });
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // CVR heat: red (poor) → yellow → lime (excellent)
  const cvrHeat = cvr => {
    if (cvr == null) return "";
    const t = Math.max(0, Math.min(1, cvr / 0.45));
    const stops = [[251, 215, 215], [254, 243, 199], [207, 255, 4]];
    const seg = t < 0.5 ? 0 : 1, u = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const a = stops[seg], b = stops[seg + 1];
    const c = a.map((x, i) => Math.round(x + (b[i] - x) * u));
    return `background:rgb(${c[0]},${c[1]},${c[2]})`;
  };
  const cvrBadge = cvr => cvr == null ? '<span class="muted">—</span>' : `<span class="tag" style="${cvrHeat(cvr)};font-size:10.5px">${(cvr * 100).toFixed(1)}%</span>`;
  const shortUrl = u => String(u || "").replace(/^https?:\/\//, "").replace(/^www\./, "");
  let LPC_FILTER = "";
  function renderLpCategory(el) {
    el.className = "view"; const l = (typeof DATA !== "undefined" && DATA.landing_pages_section) || null;
    const g = l && l.category_grid;
    if (!g || !g.rows) { el.innerHTML = stHead("LP Category Grid", "") + `<div class="panel">No landing-page data.</div>`; return; }
    const S = g.stats;
    const cols = g.categories.slice(0, 10);   // matrix columns (top categories by spend)
    const cards = `
      <div class="stat"><div class="stat-label">Landing Pages</div><div class="stat-value">${fmt.num(S.landing_pages)}</div><div class="stat-chg">avg ${S.avg_cats} categories each</div></div>
      <div class="stat"><div class="stat-label">Spend</div><div class="stat-value">${fmt.money(S.spend)}</div><div class="stat-chg">across ${fmt.num(S.landing_pages)} LPs</div></div>
      <div class="stat"><div class="stat-label">Clicks</div><div class="stat-value">${fmt.num(S.clicks)}</div><div class="stat-chg">driven to LPs</div></div>
      <div class="stat"><div class="stat-label">Conversions</div><div class="stat-value">${fmt.num(S.conversions, 0)}</div><div class="stat-chg">total tracked conv</div></div>
      <div class="stat hl"><div class="stat-label">Weighted CVR</div><div class="stat-value">${fmt.pct(S.weighted_cvr, 2)}</div><div class="stat-chg">conv ÷ clicks (all LPs)</div></div>`;
    const sumRows = g.summary.map(r => `<tr>
        <td class="strong">${esc(r.category)}</td><td class="num">${fmt.num(r.lps_running)}</td><td class="num">${fmt.money(r.spend)}</td>
        <td>${cvrBadge(r.min_cvr)}</td><td>${cvrBadge(r.median_cvr)}</td><td>${cvrBadge(r.max_cvr)}</td>
        <td class="muted" style="font-size:11.5px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(shortUrl(r.best_lp))}</td>
        <td class="muted" style="font-size:11.5px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(shortUrl(r.worst_lp))}</td></tr>`).join("");
    const matrixRow = r => `<tr>
        <td class="strong" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(shortUrl(r.url))}</a></td>
        <td class="num">${fmt.money(r.cost)}</td><td class="num">${fmt.num(r.clicks)}</td><td class="num">${fmt.num(r.conv, 0)}</td>
        <td class="num">${fmt.pct(r.overall_cvr, 2)}</td><td class="num">${r.n_cats}</td>
        ${cols.map(c => `<td class="num">${cvrBadge(r.cvr_by_cat[c] == null ? null : r.cvr_by_cat[c])}</td>`).join("")}</tr>`;
    const filterRows = () => LPC_FILTER ? g.rows.filter(r => (r.url || "").toLowerCase().indexOf(LPC_FILTER.toLowerCase()) >= 0) : g.rows;
    const shown = filterRows();
    el.innerHTML = stHead("LP Category Grid", `${fmt.num(g.total)} landing pages · CVR by category (heat-coded: lime = excellent, red = poor)`) +
      `<div class="stat-grid">${cards}</div>
       <div class="panel"><h3>Category summary <span class="muted" style="font-weight:400">CVR stats across LPs running each category</span></h3>
         <div class="tbl-wrap"><table class="sortable">
           <thead><tr><th>Category</th><th class="num">LPs Running</th><th class="num">Spend (LPs Running)</th>
             <th>Min CVR</th><th>Median CVR</th><th>Max CVR</th><th>Best LP</th><th>Worst LP</th></tr></thead>
           <tbody>${sumRows}</tbody></table></div></div>
       <div class="panel">
         <div class="toolbar"><input type="text" id="lpcFilter" placeholder="Filter URL…" value="${esc(LPC_FILTER)}" style="min-width:260px"/>
           <span class="muted" id="lpcCount" style="margin-left:auto">Showing ${fmt.num(shown.length)} of ${fmt.num(g.total)}</span></div>
         <div class="tbl-wrap"><table class="sortable">
           <thead><tr><th>URL</th><th class="num">Cost</th><th class="num">Clicks</th><th class="num">Conv</th><th class="num">Overall CVR</th><th class="num"># Cats</th>
             ${cols.map(c => `<th class="num">${esc(c)}</th>`).join("")}</tr></thead>
           <tbody id="lpcBody">${shown.map(matrixRow).join("")}</tbody></table></div></div>`;
    const tf = el.querySelector("#lpcFilter");
    if (tf) tf.addEventListener("input", () => {
      LPC_FILTER = tf.value; const rws = filterRows();
      const body = el.querySelector("#lpcBody"); if (body) body.innerHTML = rws.map(matrixRow).join("");
      const cnt = el.querySelector("#lpcCount"); if (cnt) cnt.textContent = `Showing ${fmt.num(rws.length)} of ${fmt.num(g.total)}`;
    });
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Non-Brand Categories (Performance) — campaign-derived YoY ----------
  let NBC_METRIC = "spend";
  function renderNbCats(el) {
    el.className = "view";
    const n = (typeof DATA !== "undefined" && DATA.nb_categories_section) || null;
    if (!n || !n.rows || !n.rows.length) {
      el.innerHTML = stHead("Non-Brand Categories", "") +
        `<div class="panel">No non-brand campaign data.</div>`;
      return;
    }
    const M = NBC_METRIC === "conv"
      ? { prior: "conv_prior", cur: "conv_cur", money: false, donut: "conversions share", bar: "YoY Conversions" }
      : { prior: "spend_prior", cur: "spend_cur", money: true, donut: "spend share", bar: "YoY Spend" };
    const pill = (v, l) => `<button class="seg-pill ${NBC_METRIC === v ? "active" : ""}" data-nbc="${v}">${l}</button>`;
    // Spend/Conv: up is good (green). CPA: down is good (invert).
    const rowHtml = (r, strong) => `<tr${strong ? ' class="strong"' : ""}>
        <td>${strong ? esc(r.category) : `<span class="tag info">${esc(r.category)}</span>`}</td>
        <td class="num">${fmt.money(r.spend_prior)}</td><td class="num">${fmt.money(r.spend_cur)}</td><td class="num">${yoyUp(r.spend_chg)}</td>
        <td class="num">${fmt.num(r.conv_prior, 1)}</td><td class="num">${fmt.num(r.conv_cur, 1)}</td><td class="num">${yoyUp(r.conv_chg)}</td>
        <td class="num">${fmt.money(r.cpa_prior, 2)}</td><td class="num">${fmt.money(r.cpa_cur, 2)}</td><td class="num">${yoyDn(r.cpa_chg)}</td></tr>`;
    const P = esc(n.prior_label), C = esc(n.cur_label);
    const cmp = (String(n.prior_label).slice(-4) !== String(n.cur_label).slice(-4)) ? "YoY" : "period-over-period";
    el.innerHTML = `
      <div class="view-head">
        <div><h2>Non-Brand Categories</h2>
          <div class="muted">${cmp} by non-brand category · ${P} vs ${C} · bucketed from campaign structure</div></div>
        <div class="view-head-ctl"><label class="kdd-ctl-lbl">Chart metric</label>
          <div class="seg-group">${pill("spend", "Spend")}${pill("conv", "Conversions")}</div></div>
      </div>
      <div class="two-col">
        <div class="panel"><h3>${C} ${M.donut}</h3><canvas id="nbDonut" height="220"></canvas></div>
        <div class="panel"><h3>${M.bar}</h3><canvas id="nbBars" height="220"></canvas></div>
      </div>
      <div class="panel"><h3>Category YoY detail</h3><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>Category</th>
          <th class="num">${P} Spend</th><th class="num">${C} Spend</th><th class="num">Chg</th>
          <th class="num">${P} Conv</th><th class="num">${C} Conv</th><th class="num">Chg</th>
          <th class="num">${P} CPA</th><th class="num">${C} CPA</th><th class="num">Chg</th></tr></thead>
        <tbody>${n.rows.map(r => rowHtml(r, false)).join("")}
          ${rowHtml(n.totals, true)}
        </tbody></table></div></div>`;
    const labels = n.rows.map(r => r.category);
    donut("nbDonut", labels, n.rows.map(r => Math.round(r[M.cur])));
    groupedBars("nbBars", labels, n.rows.map(r => r[M.prior]), n.rows.map(r => r[M.cur]), n.prior_label, n.cur_label, M.money);
    el.querySelectorAll("[data-nbc]").forEach(b => b.addEventListener("click", () => {
      NBC_METRIC = b.dataset.nbc; setView("nb-cats", { preserveScroll: true });
    }));
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Regions (Performance) — campaign-derived YoY by region ----------
  let REG_CATS = null;  // Set of selected categories; null = all (initialized per bundle)
  function renderRegions(el) {
    el.className = "view";
    const rs = (typeof DATA !== "undefined" && DATA.regions_section) || null;
    if (!rs || !rs.cells || !rs.cells.length) {
      el.innerHTML = stHead("Regions", "") + `<div class="panel">No region-segmented non-brand campaign data.</div>`;
      return;
    }
    const allCats = rs.categories || [];
    // (re)initialize the filter when unset or stale for this bundle's categories
    if (REG_CATS === null || ![...REG_CATS].some(c => allCats.indexOf(c) >= 0)) REG_CATS = new Set(allCats);

    // aggregate cells -> per-region YoY, honoring the category filter
    const by = {};
    rs.cells.forEach(c => {
      if (!REG_CATS.has(c.category)) return;
      const r = by[c.region] || (by[c.region] = { spend_prior: 0, spend_cur: 0, conv_prior: 0, conv_cur: 0 });
      r.spend_prior += c.spend_prior; r.spend_cur += c.spend_cur;
      r.conv_prior += c.conv_prior; r.conv_cur += c.conv_cur;
    });
    const chg = (cur, prev) => prev ? (cur - prev) / prev : null;
    const cpa = (s, c) => c ? s / c : 0;
    let rows = Object.keys(by).map(region => {
      const r = by[region];
      return { region, ...r, spend_chg: chg(r.spend_cur, r.spend_prior), conv_chg: chg(r.conv_cur, r.conv_prior),
        cpa_prior: cpa(r.spend_prior, r.conv_prior), cpa_cur: cpa(r.spend_cur, r.conv_cur),
        cpa_chg: chg(cpa(r.spend_cur, r.conv_cur), cpa(r.spend_prior, r.conv_prior)) };
    }).sort((a, b) => b.spend_cur - a.spend_cur);

    // totals row
    const T = rows.reduce((a, r) => { a.spend_prior += r.spend_prior; a.spend_cur += r.spend_cur; a.conv_prior += r.conv_prior; a.conv_cur += r.conv_cur; return a; },
      { region: "Non-Brand Total", spend_prior: 0, spend_cur: 0, conv_prior: 0, conv_cur: 0 });
    T.spend_chg = chg(T.spend_cur, T.spend_prior); T.conv_chg = chg(T.conv_cur, T.conv_prior);
    T.cpa_prior = cpa(T.spend_prior, T.conv_prior); T.cpa_cur = cpa(T.spend_cur, T.conv_cur); T.cpa_chg = chg(T.cpa_cur, T.cpa_prior);

    const P = esc(rs.prior_label), C = esc(rs.cur_label);
    const cmp = (String(rs.prior_label).slice(-4) !== String(rs.cur_label).slice(-4)) ? "YoY" : "period-over-period";
    const top = rows.slice(0, 12);
    const rowHtml = (r, strong) => `<tr${strong ? ' class="strong"' : ""}>
        <td>${strong ? esc(r.region) : `<span class="tag info">${esc(r.region)}</span>`}</td>
        <td class="num">${fmt.money(r.spend_prior)}</td><td class="num">${fmt.money(r.spend_cur)}</td><td class="num">${yoyUp(r.spend_chg)}</td>
        <td class="num">${fmt.num(r.conv_prior, 1)}</td><td class="num">${fmt.num(r.conv_cur, 1)}</td><td class="num">${yoyUp(r.conv_chg)}</td>
        <td class="num">${fmt.money(r.cpa_prior, 2)}</td><td class="num">${fmt.money(r.cpa_cur, 2)}</td><td class="num">${yoyDn(r.cpa_chg)}</td></tr>`;
    const catLabel = REG_CATS.size === allCats.length ? "All categories" : `${REG_CATS.size} of ${allCats.length}`;
    const filterNote = REG_CATS.size === allCats.length ? "all categories" : [...REG_CATS].join(", ");
    el.innerHTML = `
      <div class="view-head"><div><h2>Regions</h2>
        <div class="muted">Non-Brand campaigns · ${cmp} by region · ${P} vs ${C}</div></div></div>
      <div class="panel">
        <div class="toolbar">
          <label>Categories:</label>
          <div class="multi">
            <button class="multi-btn" id="regCatBtn" type="button">${esc(catLabel)}</button>
            <div class="multi-menu hidden" id="regCatMenu">
              ${allCats.map(c => `<label><input type="checkbox" value="${esc(c)}" ${REG_CATS.has(c) ? "checked" : ""}> ${esc(c)}</label>`).join("")}
            </div>
          </div>
          <span class="muted" style="margin-left:12px">NB-campaign YoY · ${esc(filterNote)}</span>
        </div>
        <h3 style="margin-top:12px">Top ${top.length} regions by ${C} spend</h3>
        <canvas id="regChart" height="150"></canvas>
      </div>
      <div class="panel"><h3>Region YoY detail</h3><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>Region</th>
          <th class="num">${P} Spend</th><th class="num">${C} Spend</th><th class="num">Chg</th>
          <th class="num">${P} Conv</th><th class="num">${C} Conv</th><th class="num">Chg</th>
          <th class="num">${P} CPA</th><th class="num">${C} CPA</th><th class="num">Chg</th></tr></thead>
        <tbody>${rows.map(r => rowHtml(r, false)).join("")}
          ${rowHtml(T, true)}
        </tbody></table></div></div>`;
    groupedBars("regChart", top.map(r => r.region), top.map(r => r.spend_prior), top.map(r => r.spend_cur), rs.prior_label, rs.cur_label, true);
    // category multi-select
    const btn = el.querySelector("#regCatBtn"), menu = el.querySelector("#regCatMenu");
    if (btn) btn.addEventListener("click", () => menu.classList.toggle("hidden"));
    el.querySelectorAll("#regCatMenu input").forEach(cb => cb.addEventListener("change", () => {
      if (cb.checked) REG_CATS.add(cb.value); else REG_CATS.delete(cb.value);
      if (!REG_CATS.size) REG_CATS = new Set(allCats);   // never empty
      setView("regions", { preserveScroll: true });
    }));
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Recommendations (custom, with "See data" evidence modal) ----------
  (function injectModalStyle() {
    const s = document.createElement("style");
    s.textContent = `
      #chzModal .mb{position:fixed;inset:0;background:rgba(20,24,12,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px}
      #chzModal .mc{background:#fff;border-radius:14px;max-width:640px;width:100%;max-height:82vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)}
      #chzModal .mh{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line,#eee);position:sticky;top:0;background:#fff}
      #chzModal .mh strong{font-size:15px;flex:1;color:var(--ink,#1a1a1a)}
      #chzModal .mx{border:none;background:none;font-size:22px;line-height:1;cursor:pointer;color:var(--grey,#888)}
      #chzModal .mbody{padding:18px 20px}`;
    document.head.appendChild(s);
  })();
  function closeModal() { const w = document.getElementById("chzModal"); if (w) w.remove(); document.removeEventListener("keydown", escClose); }
  function escClose(e) { if (e.key === "Escape") closeModal(); }
  function showModal(title, bodyHtml) {
    closeModal();
    const w = document.createElement("div"); w.id = "chzModal";
    w.innerHTML = `<div class="mb"><div class="mc"><div class="mh"><strong>${esc(title)}</strong><button class="mx" aria-label="Close">&times;</button></div><div class="mbody">${bodyHtml}</div></div></div>`;
    document.body.appendChild(w);
    w.querySelector(".mx").addEventListener("click", closeModal);
    w.querySelector(".mb").addEventListener("click", e => { if (e.target.classList.contains("mb")) closeModal(); });
    document.addEventListener("keydown", escClose);
  }
  const recTag = p => {
    const s = String(p || "").toLowerCase();
    if (s.includes("high") || s.includes("p1")) return '<span class="tag bad">High</span>';
    if (s.includes("medium") || s.includes("p2")) return '<span class="tag warn">Medium</span>';
    if (s.includes("low") || s.includes("p3")) return '<span class="tag info">Low</span>';
    return `<span class="tag">${esc(p || "—")}</span>`;
  };
  function renderRecs(el) {
    el.className = "view";
    const all = (typeof DATA !== "undefined" && DATA.recommendations) || [];
    const evrow = (k, v) => v ? `<tr><td style="width:140px;color:var(--grey,#888);vertical-align:top;padding:8px 10px">${esc(k)}</td><td style="padding:8px 10px"><strong>${esc(v)}</strong></td></tr>` : "";
    const cards = all.map((r, i) => {
      const impact = r["Expected Impact"] || r.Impact || "", effort = r.Effort || "", hasEv = !!r.evidence;
      return `<div class="rec">
        <div class="rec-head">${recTag(r.Priority)}<div class="rec-title">${esc(r.Recommendation || r.title || "")}</div><div class="rec-meta">${esc(r.Category || "")}</div></div>
        <p>${esc(r.Rationale || r.Description || "")}</p>
        ${(impact || effort || hasEv) ? `<div class="rec-foot muted" style="margin-top:10px;font-size:12px;display:flex;align-items:center;gap:14px">
          ${impact ? `<span><strong style="color:var(--ink)">Impact:</strong> ${esc(impact)}</span>` : ""}
          ${effort ? `<span><strong style="color:var(--ink)">Effort:</strong> ${esc(effort)}</span>` : ""}
          ${hasEv ? `<button class="ws-btn" data-ev="${i}" style="margin-left:auto;padding:5px 12px">See data</button>` : ""}
        </div>` : ""}
      </div>`;
    }).join("");
    el.innerHTML = `<div class="view-head"><div><h2>Recommendations</h2><div class="muted">${all.length} recommendations · prioritized</div></div></div>` +
      (all.length ? cards : `<div class="panel">No recommendations.</div>`);
    el.querySelectorAll("[data-ev]").forEach(b => b.addEventListener("click", () => {
      const r = all[+b.dataset.ev], ev = r.evidence || {};
      const d = ev.data;
      const cell = c => esc(typeof c === "number" ? c.toLocaleString() : c);
      const dataTable = (d && d.rows && d.rows.length)
        ? `<div class="tbl-wrap" style="max-height:360px;overflow:auto;border:1px solid var(--line,#eee);border-radius:8px">
             <table class="ws-table" style="width:100%">
               <thead><tr>${d.columns.map(c => `<th${d.columns.indexOf(c) > 0 ? ' class="ws-num"' : ""}>${esc(c)}</th>`).join("")}</tr></thead>
               <tbody>${d.rows.map(row => `<tr>${row.map((c, i) => `<td${i > 0 ? ' class="ws-num"' : ""}>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
             <div class="muted" style="padding:8px 10px;font-size:11.5px">${d.rows.length} row${d.rows.length === 1 ? "" : "s"}</div></div>`
        : `<div class="muted">No row-level data is attached to this recommendation.</div>`;
      showModal(r.Recommendation || "Recommendation",
        `<div class="muted" style="margin-bottom:12px;font-size:13px">${esc(ev.observation || "")}</div>
         ${dataTable}
         <div class="muted" style="margin-top:12px;font-size:12px">${esc(ev.magnitude || "")}${ev.timing ? " · " + esc(ev.timing) : ""}</div>`);
    }));
  }

  // ---- register renderers ----
  const REG = {
    "recs": ["Recommendations", renderRecs],
    "nb-cats": ["Non-Brand Categories", renderNbCats],
    "regions": ["Regions", renderRegions],
    "campaign-perf": ["Campaign Performance", renderCampaignPerf],
    "budget": ["Budget", renderBudget],
    "pacing": ["Pacing", renderPacing],
    "budget-input": ["Budget Input", renderBudgetInput],
    "geo-perf": ["Geo Performance", renderGeoPerf],
    "qs-detail": ["QS Overview", renderQsDetail],
    "kw-deep-dive": ["Keyword Deep Dive", renderKwDeepDive],
    "qs-breakdown": ["QS Breakdown", renderQsBreakdown],
    "region-category": ["Region & Category", renderRegionCategory],
    "ad-copy": ["Ad Copy", renderAdCopy],
    "ad-lp": ["Ad ↔ LP Pairing", renderAdLp],
    "lp-perf": ["LP Performance", renderLpPerf],
    "lp-category": ["LP Category Grid", renderLpCategory],
    "st-intent": ["Intent & Grades", renderStIntent],
    "st-relevant": ["Relevant Terms", renderStRelevant],
    "st-competitor": ["Competitor Terms", renderStCompetitor],
    "st-flagged": ["Flagged / Review", renderStFlagged],
  };
  Object.keys(REG).forEach(v => { views[v] = REG[v][1]; labels[v] = REG[v][0]; });

  // ---- rebuild a collapsible sectioned nav for computed clients ----
  const meta = (window.__BUNDLE__ && window.__BUNDLE__.meta) || null;
  if (meta && Array.isArray(meta.views)) {
    // Recommendations first, Settings last; every section collapses (closed by default).
    const SECTIONS = [
      ["Recommendations", ["recs"]],
      ["Business", ["overview", "trends", "nb-cats", "regions"]],
      ["Budget", ["budget", "pacing", "budget-input"]],
      ["Campaign", ["campaign-perf"]],
      ["Keyword", ["kw-deep-dive", "qs-detail", "qs-breakdown", "region-category"]],
      ["Search Terms", ["st-intent", "st-relevant", "st-competitor", "st-flagged"]],
      ["Ad Copy", ["ad-copy", "ad-lp"]],
      ["Landing Pages", ["lp-perf", "lp-category"]],
      ["Geo", ["geo-perf"]],
    ];
    if (!document.getElementById("navGroupStyle")) {
      const s = document.createElement("style"); s.id = "navGroupStyle";
      s.textContent = `
        .nav-section{cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none}
        .nav-section .nav-caret{display:inline-block;transition:transform .15s;font-size:9px;color:var(--grey-400,#9aa0a6)}
        .nav-group:not(.open) .nav-group-items{display:none}
        .nav-group.open .nav-section .nav-caret{transform:rotate(90deg)}`;
      document.head.appendChild(s);
    }
    const sidebar = document.getElementById("sidebar");
    // capture the admin items admin.js inserted (keyed by view), then clear the whole nav
    const wsBy = {};
    Array.prototype.slice.call(sidebar.querySelectorAll(".nav-item")).forEach(n => {
      const v = n.dataset.view || "";
      if (v.indexOf("ws-") === 0) wsBy[v] = n;
    });
    const pickWs = keys => keys.map(k => wsBy[k]).filter(Boolean);
    Array.prototype.slice.call(sidebar.querySelectorAll(".nav-section, .nav-item, .nav-group")).forEach(n => n.remove());

    const makeGroup = (title, itemNodes) => {
      if (!itemNodes.length) return;
      const group = document.createElement("div"); group.className = "nav-group";
      const head = document.createElement("div"); head.className = "nav-section";
      head.innerHTML = `<span class="nav-caret">▶</span>${title}`;
      const body = document.createElement("div"); body.className = "nav-group-items";
      itemNodes.forEach(n => body.appendChild(n));
      head.addEventListener("click", () => group.classList.toggle("open"));
      group.appendChild(head); group.appendChild(body); sidebar.appendChild(group);
    };

    const allow = {}; meta.views.forEach(v => allow[v] = true);
    SECTIONS.forEach(([title, keys]) => {
      const nodes = keys.filter(v => allow[v]).map(v => {
        const d = document.createElement("div"); d.className = "nav-item"; d.dataset.view = v;
        d.innerHTML = `<span class="nav-dot"></span>${labels[v] || v}`;
        d.addEventListener("click", () => setView(v));
        return d;
      });
      makeGroup(title, nodes);
    });
    // admin modules last: Data (ingestion) then Settings (configuration)
    makeGroup("Data", pickWs(["ws-upload", "ws-inventory"]));
    makeGroup("Settings", pickWs(["ws-context", "ws-clients"]));
  }
})();
