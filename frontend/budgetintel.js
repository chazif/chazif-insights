/* Budget Intelligence page (Module 2) — self-contained, no dependencies on
   app.js/dashviews.js so it can't conflict with parallel frontend work.
   API: backend/budget_intel_routes.py */
(function () {
  const $ = (id) => document.getElementById(id);
  const fmt$ = (v) => v == null ? "—" : "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmt2 = (v) => v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const fmt0 = (v) => v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const delta = (v, invert) => {
    if (v == null || !isFinite(v)) return "";
    const cls = (v >= 0) !== !!invert ? "up" : "down";
    const sign = v >= 0 ? "+" : "";
    return `<span class="${cls}">${sign}${fmt2(v)}</span>`;
  };
  const cid = () => $("client").value;
  const api = (path, opts) =>
    fetch(`/api/clients/${encodeURIComponent(cid())}/budget-intel${path}`, opts)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.detail || r.statusText);
        return body;
      });
  const msg = (text, isErr) => {
    $("msg").textContent = text || "";
    $("msg").style.color = isErr ? "var(--bad)" : "var(--grey-400)";
  };

  async function loadClients() {
    const r = await fetch("/api/clients").then((x) => x.json());
    const list = r.clients || r || [];
    const want = new URLSearchParams(location.search).get("client");
    $("client").innerHTML = list.map((c) => {
      const id = c.client_id || c.id || c;
      const name = c.name || id;
      return `<option value="${id}"${id === want ? " selected" : ""}>${name}</option>`;
    }).join("");
    if (want) $("client").value = want;   // preselect the client passed from the console nav
  }

  async function refreshSetup() {
    if (!cid()) return;
    try {
      const m = await api("/mappings");
      $("unmapped").innerHTML = m.unmapped.length
        ? `<div class="warn">⚠ ${m.unmapped.length} unmapped campaign(s) — runs are blocked until mapped.</div>
           <div style="margin:6px 0">` +
          m.suggestions.map((s, i) =>
            `<div class="row" style="margin-bottom:4px" data-i="${i}">
               <span style="min-width:220px;font-size:12px">${s.campaign}</span>
               <input style="width:80px" placeholder="brand" value="${s.brand || ""}" data-f="brand">
               <input style="width:100px" placeholder="region" value="${s.region || ""}" data-f="region">
               <input style="width:100px" placeholder="category" value="${s.category || ""}" data-f="category">
             </div>`).join("") +
          `</div><button id="savemaps">Save mappings</button>`
        : `<div class="muted" style="font-size:12px">All campaigns mapped ✓</div>`;
      $("mappings").textContent = m.mappings.length
        ? `${m.mappings.length} mapping(s): ` + m.mappings.slice(0, 8).map((x) =>
            `${x.campaign} → ${x.brand}/${x.region}/${x.category}`).join(" · ")
          + (m.mappings.length > 8 ? " · …" : "")
        : "No mappings yet.";
      if ($("savemaps")) $("savemaps").onclick = saveMappings(m.suggestions);
      const cv = await api("/curves");
      $("curvestatus").textContent = cv.active
        ? "Active curves ✓ (account-level fit)"
        : "No curves yet — paste simulator points and fit.";
    } catch (e) { msg(e.message, true); }
  }

  const saveMappings = (suggestions) => async () => {
    const rows = [...$("unmapped").querySelectorAll("[data-i]")].map((div) => {
      const s = suggestions[Number(div.dataset.i)];
      const val = (f) => div.querySelector(`[data-f="${f}"]`).value.trim() || null;
      return { campaign: s.campaign, brand: val("brand"), region: val("region"),
               category: val("category"), engine: s.engine, camp_type: s.camp_type };
    });
    try {
      await api("/mappings", { method: "PUT",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(rows) });
      msg("Mappings saved.");
      refreshSetup();
    } catch (e) { msg(e.message, true); }
  };

  $("savepoints").onclick = async () => {
    const points = $("simpoints").value.split("\n").map((line) => {
      const [is_share, spend_week, leads_week] = line.split(/[,\t]+/).map((x) => parseFloat(x));
      return { is_share, spend_week, leads_week };
    }).filter((p) => isFinite(p.is_share) && isFinite(p.spend_week) && isFinite(p.leads_week));
    if (points.length < 4) return msg("Need at least 4 rows (IS%, spend/week, conv/week).", true);
    try {
      const r = await api("/simulator-snapshots", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points }) });
      const d = r.fit && r.fit.diagnostics;
      msg(`Saved ${r.saved} points; curves fitted (R² leads ${d ? fmt2(d.r2_leads) : "—"}, CPL ${d ? fmt2(d.r2_cpl) : "—"}).`);
      refreshSetup();
    } catch (e) { msg(e.message, true); }
  };

  $("run").onclick = async () => {
    msg("Running…");
    $("run").disabled = true;
    try {
      const body = {
        goal: $("goal").value,
        budget: parseFloat($("budget").value) || 0,
        mode: $("mode").value,
        max_change_pct: $("maxchange").value === "" ? null : parseFloat($("maxchange").value),
      };
      const r = await api("/runs", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      renderResults(r);
      msg(`Run #${r.run_id} complete (draft).`);
    } catch (e) { msg(e.message, true); }
    $("run").disabled = false;
  };

  function renderResults(r) {
    const rows = r.results.slice().sort((a, b) =>
      (b.rec_spend - b.lw_spend) - (a.rec_spend - a.lw_spend));
    const tot = (f) => rows.reduce((s, x) => s + (x[f] || 0), 0);
    $("results").innerHTML = `
      <div class="panel">
        <h2 style="margin-top:0">Run #${r.run_id} — recommended weekly allocation
          <button id="finalize" style="float:right;font-size:12px">Finalize run</button></h2>
        <table>
          <tr><th>Cell</th><th>Score</th><th>LW spend</th><th>Rec spend</th><th>Δ spend</th>
              <th>LW IS%</th><th>Exp IS%</th><th>LW CPA</th><th>Exp CPA</th>
              <th>tCPA now</th><th>tCPA Δ</th><th>LW cars</th><th>Exp cars</th>
              <th>Exp GP−spend</th></tr>
          ${rows.map((x) => `
            <tr>
              <td>${x.brand} / ${x.region} / ${x.category}</td>
              <td>${fmt2(x.opp_score)}</td>
              <td>${fmt$(x.lw_spend)}</td><td><b>${fmt$(x.rec_spend)}</b></td>
              <td>${delta(x.rec_spend - x.lw_spend)}</td>
              <td>${fmt0(x.lw_is)}</td><td>${fmt0(x.expected_is)}</td>
              <td>${fmt2(x.lw_cpa)}</td><td>${fmt2(x.expected_cpa)}</td>
              <td>${fmt2(x.tcpa_current)}</td>
              <td>${delta(x.tcpa_recommended - x.tcpa_current, true)}</td>
              <td>${fmt0(x.lw_cars)}</td><td>${fmt0(x.expected_cars)}</td>
              <td>${fmt$(x.expected_adroi)}</td>
            </tr>`).join("")}
          <tr style="font-weight:600">
            <td>TOTAL</td><td></td>
            <td>${fmt$(tot("lw_spend"))}</td><td>${fmt$(tot("rec_spend"))}</td>
            <td>${delta(tot("rec_spend") - tot("lw_spend"))}</td>
            <td colspan="6"></td>
            <td>${fmt0(tot("lw_cars"))}</td><td>${fmt0(tot("expected_cars"))}</td>
            <td>${fmt$(tot("expected_adroi"))}</td>
          </tr>
        </table>
        <div class="muted" style="font-size:11.5px;margin-top:8px">
          Expected values are curve estimates (constant cost-per-conversion assumption —
          treat large increases as optimistic). tCPA Δ = expected CPA − current tCPA:
          the bid-strategy change to apply with the budget move.
        </div>
      </div>`;
    $("finalize").onclick = async () => {
      try {
        await api(`/runs/${r.run_id}/finalize`, { method: "POST" });
        msg(`Run #${r.run_id} finalized — predictions stamped for calibration.`);
        $("finalize").disabled = true;
      } catch (e) { msg(e.message, true); }
    };
  }

  loadClients().then(refreshSetup);
  $("client").onchange = refreshSetup;
})();
