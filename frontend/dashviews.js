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

  // ---------- Budget & Pacing ----------
  function renderBudgetPacing(el) {
    el.className = "view";
    const b = (typeof DATA !== "undefined" && DATA.budget_pacing) || null;
    if (!b || !b.months || !b.months.length) {
      el.innerHTML = `<div class="view-head"><div><h2>Budget &amp; Pacing</h2></div></div><div class="panel">No spend data.</div>`;
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
      : `<div class="panel" style="background:#FCFEF0"><strong>No monthly budget set.</strong> Add one in <a href="#" id="bpGo">Business Context</a> to see pacing vs target. Showing spend by month below.</div>`;
    const body = b.months.slice().reverse().map(m => `<tr>
        <td class="strong">${esc(m.month)}</td>
        <td class="num">${fmt.money(m.spend)}</td>
        <td class="num">${m.budget == null ? "—" : fmt.money(m.budget)}</td>
        <td class="num ${m.variance == null ? "" : (m.variance <= 0 ? "chg up" : "chg dn")}">${m.variance == null ? "—" : fmt.money(m.variance)}</td>
        <td class="num">${m.pct == null ? "—" : (m.pct * 100).toFixed(0) + "%"}</td></tr>`).join("");
    el.innerHTML = `
      <div class="view-head"><div><h2>Budget &amp; Pacing</h2>
        <div class="muted">Monthly spend vs budget · intra-month daily pacing needs day-segmented exports</div></div></div>
      ${header}
      <div class="panel"><div class="tbl-wrap"><table>
        <thead><tr><th>Month</th><th class="num">Spend</th><th class="num">Budget</th>
          <th class="num">Variance</th><th class="num">% of Budget</th></tr></thead>
        <tbody>${body}</tbody></table></div></div>`;
    const go = el.querySelector("#bpGo");
    if (go) go.addEventListener("click", e => { e.preventDefault(); setView("ws-context"); });
  }

  // ---------- Quality Score ----------
  function renderQsDetail(el) {
    el.className = "view";
    const q = (typeof DATA !== "undefined" && DATA.quality_score) || null;
    if (!q) { el.innerHTML = `<div class="view-head"><div><h2>Quality Score</h2></div></div><div class="panel">No Quality Score data.</div>`; return; }
    const maxk = Math.max.apply(null, q.distribution.map(d => d.keywords)) || 1;
    const dist = q.distribution.map(d => `<tr>
        <td class="strong">QS ${d.qs}</td>
        <td style="width:38%"><div style="background:var(--lime);height:12px;border-radius:6px;width:${(d.keywords / maxk * 100).toFixed(0)}%"></div></td>
        <td class="num">${d.keywords}</td><td class="num">${fmt.money(d.cost)}</td></tr>`).join("");
    const buckets = q.buckets.map(b => `<div class="stat">
        <div class="stat-label">${esc(b.label)}</div><div class="stat-value">${b.keywords}</div>
        <div class="stat-chg">${fmt.money(b.cost)}</div></div>`).join("");
    const low = q.top_low.map(k => `<tr>
        <td class="strong">${esc(k.keyword)}</td><td>${esc(k.match)}</td>
        <td class="num" data-sort="${k.qs}">${k.qs}</td>
        <td class="num" data-sort="${k.clicks}">${fmt.num(k.clicks)}</td>
        <td class="num" data-sort="${k.cost}">${fmt.money(k.cost)}</td></tr>`).join("");
    el.innerHTML = `
      <div class="view-head"><div><h2>Quality Score</h2>
        <div class="muted">Account avg QS ${q.avg_qs} · ${q.total_keywords} keywords with a Quality Score</div></div></div>
      <div class="stat-grid">${buckets}</div>
      <div class="two-col">
        <div class="panel"><h3>QS distribution</h3><div class="tbl-wrap"><table>
          <thead><tr><th>QS</th><th></th><th class="num">Keywords</th><th class="num">Cost</th></tr></thead>
          <tbody>${dist}</tbody></table></div></div>
        <div class="panel"><h3>Lowest-QS keywords by spend</h3><div class="tbl-wrap"><table class="sortable">
          <thead><tr><th>Keyword</th><th>Match</th><th class="num">QS</th><th class="num">Clicks</th><th class="num">Cost</th></tr></thead>
          <tbody>${low}</tbody></table></div></div>
      </div>`;
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
  const stHead = (title, sub) => `<div class="view-head"><div><h2>${title}</h2><div class="muted">${sub}</div></div></div>`;

  function renderStIntent(el) {
    el.className = "view"; const s = stData();
    if (!s) { el.innerHTML = stHead("Intent &amp; Grades", "") + `<div class="panel">No search-term data.</div>`; return; }
    const grades = s.grade_summary.map(g => `<div class="stat"><div class="stat-label">${esc(g.grade)}</div><div class="stat-value">${fmt.num(g.terms)}</div><div class="stat-chg">${fmt.money(g.cost)}</div></div>`).join("");
    const intents = s.intent_summary.map(i => `<tr><td class="strong">${esc(i.intent)}</td><td class="num">${i.terms}</td><td class="num">${fmt.money(i.cost)}</td></tr>`).join("");
    el.innerHTML = stHead("Intent &amp; Grades", `${fmt.num(s.total_terms)} terms · intent via ${esc(s.source)}`) +
      `<div class="stat-grid">${grades}</div>
       <div class="two-col">
         <div class="panel"><h3>Intent mix (top terms by spend)</h3><div class="tbl-wrap"><table>
           <thead><tr><th>Intent</th><th class="num">Terms</th><th class="num">Cost</th></tr></thead><tbody>${intents}</tbody></table></div></div>
         <div class="panel"><h3>Top terms by spend</h3>${termTable(s.top_graded, true)}</div></div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }
  function renderStRelevant(el) {
    el.className = "view"; const s = stData();
    if (!s) { el.innerHTML = stHead("Relevant Terms", "") + `<div class="panel">No data.</div>`; return; }
    el.innerHTML = stHead("Relevant Terms", `Terms relevant to the business (${esc(s.source)}), by spend`) +
      `<div class="panel">${termTable(s.relevant, true)}</div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }
  function renderStCompetitor(el) {
    el.className = "view"; const s = stData();
    if (!s) { el.innerHTML = stHead("Competitor Terms", "") + `<div class="panel">No data.</div>`; return; }
    el.innerHTML = stHead("Competitor Terms", `Search terms matching configured competitor names`) +
      `<div class="panel">${s.competitor.length ? termTable(s.competitor, false) : '<div class="ws-empty" style="padding:24px;text-align:center;color:var(--grey)">No competitor terms — add competitors in Business Context.</div>'}</div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }
  function renderStFlagged(el) {
    el.className = "view"; const s = stData();
    if (!s) { el.innerHTML = stHead("Flagged / Review", "") + `<div class="panel">No data.</div>`; return; }
    el.innerHTML = stHead("Flagged / Review", `Zero-conversion or irrelevant terms — negative-keyword candidates`) +
      `<div class="panel">${termTable(s.flagged, true)}</div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }

  // ---------- Keyword section ----------
  function renderKwDeepDive(el) {
    el.className = "view"; const k = (typeof DATA !== "undefined" && DATA.keyword_section) || null;
    if (!k) { el.innerHTML = stHead("Keyword Deep Dive", "") + `<div class="panel">No keyword data.</div>`; return; }
    const rows = k.deep_dive.map(d => `<tr>
        <td class="strong">${esc(d.keyword)}</td><td>${esc(d.match)}</td>
        <td class="num" data-sort="${d.qs || 0}">${d.qs || "—"}</td>
        <td class="num" data-sort="${d.clicks}">${fmt.num(d.clicks)}</td>
        <td class="num" data-sort="${d.cost}">${fmt.money(d.cost)}</td>
        <td class="num" data-sort="${d.conv}">${fmt.num(d.conv, 1)}</td>
        <td class="num" data-sort="${d.cpa}">${fmt.money(d.cpa, 2)}</td></tr>`).join("");
    el.innerHTML = stHead("Keyword Deep Dive", "Top keywords by spend") +
      `<div class="panel"><div class="tbl-wrap"><table class="sortable">
        <thead><tr><th>Keyword</th><th>Match</th><th class="num">QS</th><th class="num">Clicks</th>
          <th class="num">Cost</th><th class="num">Conv</th><th class="num">CPA</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
    if (typeof enableSortable === "function") enableSortable(el);
  }
  function renderQsBreakdown(el) {
    el.className = "view"; const k = (typeof DATA !== "undefined" && DATA.keyword_section) || null;
    if (!k) { el.innerHTML = stHead("QS Breakdown", "") + `<div class="panel">No data.</div>`; return; }
    const panels = Object.keys(k.components).map(name => {
      const rows = k.components[name].map(r => {
        const cls = r.rating === "Above average" ? "up" : r.rating === "Below average" ? "dn" : "";
        return `<tr><td class="chg ${cls}">${esc(r.rating)}</td><td class="num">${fmt.num(r.keywords)}</td><td class="num">${fmt.money(r.cost)}</td></tr>`;
      }).join("");
      return `<div class="panel"><h3>${esc(name)}</h3><div class="tbl-wrap"><table>
        <thead><tr><th>Rating</th><th class="num">Keywords</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }).join("");
    const banner = k.below_ctr_spend ? `<div class="panel" style="background:#FCFEF0"><strong>Modeled savings:</strong> ${fmt.money(k.below_ctr_spend)} runs on Below-average expected CTR → ~${fmt.money(k.savings_estimate)} modeled CPC penalty. Rework these keywords to cut it.</div>` : "";
    el.innerHTML = stHead("QS Breakdown", "Quality Score components across keywords") + banner +
      `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px">${panels}</div>`;
  }

  // ---- register renderers ----
  const REG = {
    "campaign-perf": ["Campaign Performance", renderCampaignPerf],
    "budget-pacing": ["Budget & Pacing", renderBudgetPacing],
    "geo-perf": ["Geo Performance", renderGeoPerf],
    "qs-detail": ["QS Overview", renderQsDetail],
    "kw-deep-dive": ["Keyword Deep Dive", renderKwDeepDive],
    "qs-breakdown": ["QS Breakdown", renderQsBreakdown],
    "st-intent": ["Intent & Grades", renderStIntent],
    "st-relevant": ["Relevant Terms", renderStRelevant],
    "st-competitor": ["Competitor Terms", renderStCompetitor],
    "st-flagged": ["Flagged / Review", renderStFlagged],
  };
  Object.keys(REG).forEach(v => { views[v] = REG[v][1]; labels[v] = REG[v][0]; });

  // ---- rebuild a sectioned dashboard nav for computed clients (mirrors the reference) ----
  const meta = (window.__BUNDLE__ && window.__BUNDLE__.meta) || null;
  if (meta && Array.isArray(meta.views)) {
    const SECTIONS = [
      ["Performance", ["overview", "trends", "campaign-perf", "budget-pacing"]],
      ["Keyword", ["kw-deep-dive", "qs-detail", "qs-breakdown"]],
      ["Search Terms", ["st-intent", "st-relevant", "st-competitor", "st-flagged"]],
      ["Geo", ["geo-perf"]],
      ["", ["recs"]],
    ];
    const sidebar = document.getElementById("sidebar");
    // clear the static (Mavis-demo) dashboard nav; keep the Workspace admin section
    Array.prototype.slice.call(sidebar.querySelectorAll(".nav-section, .nav-item")).forEach(n => {
      if (n.classList.contains("nav-item") && (n.dataset.view || "").indexOf("ws-") === 0) return;
      if (n.classList.contains("nav-section") && n.textContent === "Workspace") return;
      n.remove();
    });
    const allow = {}; meta.views.forEach(v => allow[v] = true);
    SECTIONS.forEach(([title, keys]) => {
      const items = keys.filter(v => allow[v]);
      if (!items.length) return;
      if (title) {
        const h = document.createElement("div"); h.className = "nav-section"; h.textContent = title;
        sidebar.appendChild(h);
      }
      items.forEach(v => {
        const d = document.createElement("div"); d.className = "nav-item"; d.dataset.view = v;
        d.innerHTML = `<span class="nav-dot"></span>${labels[v] || v}`;
        d.addEventListener("click", () => setView(v));
        sidebar.appendChild(d);
      });
    });
  }
})();
