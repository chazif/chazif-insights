// Workspace admin section — Clients / Upload Data / Data Inventory.
// Loaded after app.js; registers into its `views`, `labels`, and nav.
(function () {
  "use strict";

  async function api(method, path, opts) {
    opts = opts || {};
    const init = { method };
    if (opts.json) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(opts.json); }
    if (opts.form) init.body = opts.form;
    const r = await fetch(path, init);
    const ct = r.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await r.json() : await r.text();
    if (!r.ok) throw new Error((data && data.detail) || ("HTTP " + r.status));
    return data;
  }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const REPORT_COUNT = 12; // expected report set size

  // ---- scoped styles (reuse the app's CSS vars, with fallbacks) ----
  const css = document.createElement("style");
  css.textContent = `
    .ws h2{font-size:22px;margin:0 0 4px} .ws .sub{color:var(--grey,#6B7280);font-size:14px;margin-bottom:20px}
    .ws-panel{background:#fff;border:1px solid var(--line,#E5E7EB);border-radius:14px;padding:20px;margin-bottom:18px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .ws-panel h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--grey,#6B7280);margin:0 0 14px}
    .ws-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .ws-input,.ws-select{font:inherit;font-size:14px;padding:9px 12px;border:1px solid var(--line,#D1D5DB);border-radius:9px;background:#fff;color:var(--ink,#1A1A1A);min-width:180px}
    .ws-input:focus,.ws-select:focus{outline:2px solid var(--lime,#CFFF04);outline-offset:1px}
    .ws-btn{font:inherit;font-weight:600;font-size:14px;padding:9px 16px;border-radius:9px;border:1px solid var(--line,#D1D5DB);background:#fff;color:var(--ink,#1A1A1A);cursor:pointer}
    .ws-btn:hover{background:#F9FAFB}
    .ws-btn.primary{background:var(--lime,#CFFF04);border-color:var(--lime,#CFFF04);color:#1A1A1A}
    .ws-btn.primary:hover{filter:brightness(.96)} .ws-btn:disabled{opacity:.5;cursor:not-allowed}
    .ws-table{width:100%;border-collapse:collapse;font-size:13.5px}
    .ws-table th{text-align:left;color:var(--grey,#6B7280);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid var(--line,#E5E7EB)}
    .ws-table td{padding:9px 10px;border-bottom:1px solid var(--line,#F3F4F6)}
    .ws-table tr:hover td{background:#FAFAF7}
    .ws-num{text-align:right;font-variant-numeric:tabular-nums}
    .ws-drop{border:2px dashed var(--line,#D1D5DB);border-radius:12px;padding:26px;text-align:center;color:var(--grey,#6B7280);cursor:pointer;transition:.15s}
    .ws-drop.over{border-color:var(--lime,#CFFF04);background:#FCFEF0}
    .ws-chip{display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:100px;margin:3px 4px 0 0}
    .ws-ok{background:#E7F6EC;color:#1E7F45} .ws-miss{background:#FDECEC;color:#B42318}
    .ws-cov{height:8px;border-radius:100px;background:var(--line,#EEE);overflow:hidden;margin:6px 0 2px}
    .ws-cov>span{display:block;height:100%;background:var(--lime,#CFFF04)}
    .ws-note{font-size:13px;color:var(--grey,#6B7280)} .ws-err{color:#B42318;font-size:13px;margin-top:8px}
    .ws-empty{padding:28px;text-align:center;color:var(--grey,#6B7280)}
  `;
  document.head.appendChild(css);

  function coverageBar(present) {
    const pct = Math.round((present / REPORT_COUNT) * 100);
    return `<div class="ws-cov"><span style="width:${pct}%"></span></div><div class="ws-note">${present} of ${REPORT_COUNT} reports</div>`;
  }
  function invTables(inv) {
    const rows = inv.reports.map(r => `<tr>
        <td>${esc(r.report_type)}</td><td>${esc(r.source_file || "")}</td>
        <td>${esc(r.window || "")}</td><td class="ws-num">${(r.rows || 0).toLocaleString()}</td></tr>`).join("");
    const miss = inv.missing.length
      ? inv.missing.map(m => `<span class="ws-chip ws-miss">${esc(m)}</span>`).join("")
      : `<span class="ws-chip ws-ok">complete</span>`;
    return `
      ${coverageBar(inv.present.length)}
      <div style="margin:14px 0 6px" class="ws-note"><strong>Missing:</strong></div>${miss}
      <table class="ws-table" style="margin-top:14px"><thead><tr>
        <th>Report</th><th>Source file</th><th>Window</th><th class="ws-num">Rows</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="ws-empty">No reports loaded yet.</td></tr>`}</tbody></table>`;
  }

  // ---------- Clients ----------
  async function renderWsClients(el) {
    el.className = "view ws";
    el.innerHTML = `<div class="view-head"><div><h2>Clients</h2><div class="sub">Create a client, then upload its Google Ads exports.</div></div></div>
      <div class="ws-panel"><h3>Add client</h3>
        <div class="ws-row">
          <input class="ws-input" id="wsName" placeholder="Client name (e.g. Chiarelli's Religious Goods)" style="flex:1"/>
          <button class="ws-btn primary" id="wsAdd">Create client</button>
        </div><div class="ws-err" id="wsAddErr" style="display:none"></div>
      </div>
      <div class="ws-panel"><h3>All clients</h3><div id="wsList" class="ws-note">Loading…</div></div>`;

    function openDash(cid) { try { sessionStorage.setItem("chz_nav", "1"); } catch (e) {} location.href = "/?client=" + encodeURIComponent(cid); }
    async function refresh() {
      try {
        const list = await api("GET", "/api/clients");
        const box = el.querySelector("#wsList");
        box.innerHTML = list.length === 0
          ? `<div class="ws-empty">No clients yet — add your first one above.</div>`
          : `<table class="ws-table"><thead><tr><th>Name</th><th>ID</th>
               <th class="ws-num">Reports</th><th>Last upload</th></tr></thead><tbody>${
              list.map(c => `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.client_id)}</td>
                <td class="ws-num">${c.reports_loaded}/${REPORT_COUNT}</td>
                <td>${c.last_upload ? esc(c.last_upload.slice(0, 16).replace("T", " ")) : "—"}</td></tr>`).join("")
            }</tbody></table>`;
      } catch (e) { el.querySelector("#wsList").innerHTML = `<div class="ws-err">${esc(e.message)}</div>`; }
    }
    const errEl = el.querySelector("#wsAddErr");
    el.querySelector("#wsAdd").addEventListener("click", async () => {
      const name = el.querySelector("#wsName").value.trim();
      errEl.style.display = "none";
      if (!name) { errEl.textContent = "Enter a client name."; errEl.style.display = "block"; return; }
      try {
        await api("POST", "/api/clients", { json: { name } });
        el.querySelector("#wsName").value = "";
        refresh();
      } catch (e) { errEl.textContent = e.message; errEl.style.display = "block"; }
    });
    refresh();
  }

  // ---------- Upload ----------
  async function renderWsUpload(el) {
    el.className = "view ws";
    let clients = [];
    try { clients = await api("GET", "/api/clients"); } catch (e) { /* shown below */ }
    if (!clients.length) {
      el.innerHTML = `<div class="view-head"><div><h2>Upload Data</h2></div></div>
        <div class="ws-panel"><div class="ws-empty">No clients yet. Add a client on the <a href="#" id="goClients">Clients</a> tab first.</div></div>`;
      el.querySelector("#goClients").addEventListener("click", e => { e.preventDefault(); setView("ws-clients"); });
      return;
    }
    const now = new Date();
    const defPeriod = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    el.innerHTML = `<div class="view-head"><div><h2>Upload Data</h2>
        <div class="sub">Select a client and reporting period, then drop the Google Ads CSV exports.</div></div></div>
      <div class="ws-panel">
        <div class="ws-row" style="margin-bottom:14px">
          <select class="ws-select" id="wsClient">${clients.map(c => `<option value="${esc(c.client_id)}">${esc(c.name)}</option>`).join("")}</select>
          <input class="ws-input" id="wsPeriod" value="${defPeriod}" placeholder="YYYY-MM" style="min-width:120px"/>
        </div>
        <div class="ws-drop" id="wsDrop">
          <div><strong>Drop CSV exports here</strong> or click to choose</div>
          <div class="ws-note" id="wsFiles" style="margin-top:8px">No files selected</div>
          <input type="file" id="wsFileInput" accept=".csv" multiple style="display:none"/>
        </div>
        <div class="ws-row" style="margin-top:14px">
          <button class="ws-btn primary" id="wsUpload" disabled>Upload &amp; ingest</button>
          <span class="ws-note" id="wsStatus"></span>
        </div>
        <div class="ws-err" id="wsUpErr" style="display:none"></div>
      </div>
      <div class="ws-panel" id="wsResult" style="display:none"><h3>Result</h3><div id="wsResultBody"></div></div>`;

    let files = [];
    const drop = el.querySelector("#wsDrop"), input = el.querySelector("#wsFileInput");
    const filesEl = el.querySelector("#wsFiles"), btn = el.querySelector("#wsUpload");
    function setFiles(list) {
      files = Array.from(list).filter(f => f.name.toLowerCase().endsWith(".csv"));
      filesEl.textContent = files.length ? files.length + " CSV file(s): " + files.map(f => f.name).join(", ") : "No files selected";
      btn.disabled = files.length === 0;
    }
    drop.addEventListener("click", () => input.click());
    input.addEventListener("change", () => setFiles(input.files));
    ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", e => setFiles(e.dataTransfer.files));

    btn.addEventListener("click", async () => {
      const errEl = el.querySelector("#wsUpErr"); errEl.style.display = "none";
      const status = el.querySelector("#wsStatus");
      const fd = new FormData();
      fd.append("client", el.querySelector("#wsClient").value);
      fd.append("period", el.querySelector("#wsPeriod").value.trim() || "unspecified");
      files.forEach(f => fd.append("files", f, f.name));
      btn.disabled = true; status.textContent = "Uploading & ingesting…";
      try {
        const res = await api("POST", "/api/upload", { form: fd });
        status.textContent = "Done.";
        const loaded = res.loaded.map(r => `<tr><td>${esc(r.report_type)}</td><td class="ws-num">${(r.rows || 0).toLocaleString()}</td></tr>`).join("");
        el.querySelector("#wsResult").style.display = "";
        el.querySelector("#wsResultBody").innerHTML = `
          <div class="ws-note" style="margin-bottom:10px">Loaded <strong>${res.loaded.length}</strong> report(s)${res.unmapped.length ? `, skipped ${res.unmapped.length} unmapped file(s)` : ""}.</div>
          <table class="ws-table" style="margin-bottom:16px"><thead><tr><th>Report</th><th class="ws-num">Rows</th></tr></thead><tbody>${loaded}</tbody></table>
          <h3>Coverage</h3>${invTables(res.inventory)}`;
      } catch (e) { errEl.textContent = e.message; errEl.style.display = "block"; status.textContent = ""; }
      finally { btn.disabled = files.length === 0; }
    });
  }

  // ---------- Inventory ----------
  async function renderWsInventory(el) {
    el.className = "view ws";
    let clients = [];
    try { clients = await api("GET", "/api/clients"); } catch (e) {}
    el.innerHTML = `<div class="view-head"><div><h2>Data Inventory</h2>
        <div class="sub">Report coverage per client — drives which dashboard views can render.</div></div></div>
      <div class="ws-panel">
        ${clients.length ? `<div class="ws-row" style="margin-bottom:16px">
          <label class="ws-note">Client</label>
          <select class="ws-select" id="wsInvClient">${clients.map(c => `<option value="${esc(c.client_id)}">${esc(c.name)}</option>`).join("")}</select>
        </div><div id="wsInv"></div>` : `<div class="ws-empty">No clients yet.</div>`}
      </div>`;
    if (!clients.length) return;
    async function load(cid) {
      const box = el.querySelector("#wsInv"); box.innerHTML = `<div class="ws-note">Loading…</div>`;
      try { box.innerHTML = invTables(await api("GET", "/api/inventory?client=" + encodeURIComponent(cid))); }
      catch (e) { box.innerHTML = `<div class="ws-err">${esc(e.message)}</div>`; }
    }
    const sel = el.querySelector("#wsInvClient");
    sel.addEventListener("change", () => load(sel.value));
    load(sel.value);
  }

  // ---------- Business Context ----------
  async function renderWsContext(el) {
    el.className = "view ws";
    let clients = [];
    try { clients = await api("GET", "/api/clients"); } catch (e) {}
    if (!clients.length) {
      el.innerHTML = `<div class="view-head"><div><h2>Business Context</h2></div></div>
        <div class="ws-panel"><div class="ws-empty">Add a client on the <a href="#" id="goC">Clients</a> tab first.</div></div>`;
      el.querySelector("#goC").addEventListener("click", e => { e.preventDefault(); setView("ws-clients"); });
      return;
    }
    el.innerHTML = `<div class="view-head"><div><h2>Business Context</h2>
        <div class="sub">Brand &amp; competitor knowledge and thresholds the analysis obeys — overrides the defaults.</div></div></div>
      <div class="ws-panel">
        <div class="ws-row" style="margin-bottom:16px">
          <label class="ws-note">Client</label>
          <select class="ws-select" id="wsCtxClient">${clients.map(c => `<option value="${esc(c.client_id)}">${esc(c.name)}</option>`).join("")}</select>
        </div>
        <div id="wsCtxForm" class="ws-note">Loading…</div>
      </div>`;

    const ta = (id, label, val, ph) => `<div style="margin-bottom:14px">
        <label class="ws-note" style="display:block;font-weight:600;margin-bottom:5px">${label}</label>
        <textarea class="ws-input" id="${id}" rows="2" style="width:100%;resize:vertical" placeholder="${ph||''}">${esc((val||[]).join(", "))}</textarea></div>`;
    const nf = (id, label, val) => `<div><label class="ws-note" style="display:block;font-weight:600;margin-bottom:5px">${label}</label>
        <input class="ws-input" id="${id}" type="number" step="any" value="${val==null?'':val}" style="width:120px"/></div>`;

    async function load(cid) {
      const box = el.querySelector("#wsCtxForm");
      let cfg;
      try { cfg = await api("GET", "/api/clients/" + encodeURIComponent(cid) + "/config"); }
      catch (e) { box.innerHTML = `<div class="ws-err">${esc(e.message)}</div>`; return; }
      const th = cfg.thresholds || {};
      const seasonText = (cfg.seasonality || []).map(w => (w.label || "") + ": " + ((w.months || []).join(", "))).join("\n");
      box.innerHTML =
        ta("ctxBrand", "Brand terms", cfg.brand_terms, "chiarelli, chiarelli's") +
        ta("ctxProducts", "Product categories (what you sell — drives search-term relevance)", cfg.product_categories, "candles, incense, rosaries, communion wafers") +
        ta("ctxFriendly", "Friendly competitors (never conquest/negate)", cfg.competitors_friendly, "Catholic Supply, St. Jude Shop") +
        ta("ctxConquest", "Conquest competitors (real targets)", cfg.competitors_conquest, "F.C. Ziegler, Autom") +
        ta("ctxExcl", "Waste exclusions (terms never flagged as waste)", cfg.waste_exclusions, "hours, phone number") +
        `<div class="ws-row" style="margin:6px 0 16px;gap:18px">
           ${nf("ctxFloor", "Smart Bidding floor (conv/mo)", th.smart_bidding_floor)}
           ${nf("ctxLowConv", "Low-volume conv", th.low_vol_conv)}
           ${nf("ctxLowSpend", "Low-volume spend $", th.low_vol_spend)}
           ${nf("ctxQs", "QS danger-zone ceiling", th.qs_floor)}
           ${nf("ctxBudget", "Monthly budget $", th.monthly_budget)}
         </div>
         <div style="margin-bottom:14px"><label class="ws-note" style="display:block;font-weight:600;margin-bottom:5px">Seasonality — suppress trend alarms in known troughs (one per line: <em>Label: Month, Month</em>)</label>
           <textarea class="ws-input" id="ctxSeason" rows="2" style="width:100%;resize:vertical" placeholder="Post-Easter trough: May">${esc(seasonText)}</textarea></div>
         <div style="margin-bottom:14px"><label class="ws-note" style="display:block;font-weight:600;margin-bottom:5px">Notes</label>
           <textarea class="ws-input" id="ctxNotes" rows="2" style="width:100%;resize:vertical">${esc(cfg.notes || "")}</textarea></div>
         <div class="ws-row"><button class="ws-btn primary" id="ctxSave">Save context</button><span class="ws-note" id="ctxStatus"></span></div>
         <div class="ws-err" id="ctxErr" style="display:none"></div>`;

      el.querySelector("#ctxSave").addEventListener("click", async () => {
        const v = id => (el.querySelector(id).value || "").trim();
        const numOrNull = id => { const x = el.querySelector(id).value; return x === "" ? null : Number(x); };
        const parseSeason = txt => (txt || "").split("\n").map(line => {
          line = line.trim(); if (!line) return null;
          const i = line.indexOf(":");
          const label = i >= 0 ? line.slice(0, i).trim() : "Seasonal trough";
          const months = (i >= 0 ? line.slice(i + 1) : line).split(",").map(s => s.trim()).filter(Boolean);
          return months.length ? { label: label, months: months } : null;
        }).filter(Boolean);
        const payload = {
          brand_terms: v("#ctxBrand"), product_categories: v("#ctxProducts"),
          competitors_friendly: v("#ctxFriendly"),
          competitors_conquest: v("#ctxConquest"), waste_exclusions: v("#ctxExcl"),
          seasonality: parseSeason(v("#ctxSeason")), notes: v("#ctxNotes"),
          thresholds: {
            smart_bidding_floor: numOrNull("#ctxFloor"), low_vol_conv: numOrNull("#ctxLowConv"),
            low_vol_spend: numOrNull("#ctxLowSpend"), qs_floor: numOrNull("#ctxQs"),
            monthly_budget: numOrNull("#ctxBudget"),
          },
        };
        const st = el.querySelector("#ctxStatus"), er = el.querySelector("#ctxErr");
        er.style.display = "none"; st.textContent = "Saving…";
        try {
          await api("PUT", "/api/clients/" + encodeURIComponent(cid) + "/config", { json: payload });
          st.textContent = "Saved. Reload this client's dashboard to see the analysis update.";
        } catch (e) { er.textContent = e.message; er.style.display = "block"; st.textContent = ""; }
      });
    }
    const sel = el.querySelector("#wsCtxClient");
    sel.addEventListener("change", () => load(sel.value));
    load(sel.value);
  }

  // ---- register views + labels + nav ----
  views["ws-clients"] = renderWsClients;
  views["ws-upload"] = renderWsUpload;
  views["ws-inventory"] = renderWsInventory;
  views["ws-context"] = renderWsContext;
  labels["ws-clients"] = "Clients";
  labels["ws-upload"] = "Upload Data";
  labels["ws-inventory"] = "Data Inventory";
  labels["ws-context"] = "Business Context";
  ["ws-clients", "ws-upload", "ws-inventory", "ws-context"].forEach(v => BRAND_FILTER_HIDDEN_VIEWS.add(v));

  const sidebar = document.getElementById("sidebar");
  if (sidebar) {
    const first = sidebar.querySelector(".nav-section");
    const items = [
      ["ws-clients", "Clients"], ["ws-upload", "Upload Data"],
      ["ws-inventory", "Data Inventory"], ["ws-context", "Business Context"],
    ];
    const nodes = [];
    const head = document.createElement("div"); head.className = "nav-section"; head.textContent = "Settings"; nodes.push(head);
    items.forEach(([v, label]) => {
      const d = document.createElement("div");
      d.className = "nav-item"; d.dataset.view = v;
      d.innerHTML = `<span class="nav-dot"></span>${label}`;
      d.addEventListener("click", () => setView(v));
      nodes.push(d);
    });
    nodes.forEach(n => sidebar.insertBefore(n, first));
  }
})();
