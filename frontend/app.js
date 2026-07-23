// Auto-split from Mavis single-file dashboard. Data now arrives via the bundle loader.
const DATA = window.__BUNDLE__;

// Client-aware labels from the bundle meta (fall back to the Mavis demo defaults).
const META = (DATA && DATA.meta) || {};
const CLIENT_LABEL = META.name || 'Mavis Tire';
const PERIOD_LABEL = (META.periods && META.periods.current) || 'March 2026';
const PRIOR_LABEL  = (META.periods && META.periods.prior)   || 'Mar 2025';
const CUR_LABEL    = (META.periods && META.periods.current) || 'Mar 2026';



// ====== UTIL ======
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const fmt = {
  money: (v, d=0) => (v==null||isNaN(v))?'—':('$'+Number(v).toLocaleString('en-US',{maximumFractionDigits:d, minimumFractionDigits:d})),
  num:   (v, d=0) => (v==null||isNaN(v))?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:d, minimumFractionDigits:d}),
  pct:   (v, d=1) => (v==null||isNaN(v))?'—':(Number(v)*100).toFixed(d)+'%',
  chg:   (v, d=1) => { if(v==null||isNaN(v))return '—'; const p=(Number(v)*100).toFixed(d); return (v>=0?'+':'')+p+'%'; },
};

function unlock() {
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderAll();
}

// ====== VIEW ROUTING ======
const views = {
  overview:     renderOverview,
  trends:       renderTrends,
  'brands-all': renderBrandsAll,
  'brand-detail': renderBrandDetail,
  'nb-cats':    renderNbCats,
  regions:      renderRegions,
  'kw-deep-dive':      renderKwDeepDive,
  'qs-overview':       renderQsOverview,
  'qs-breakdown':      renderQsBreakdown,
  'qs-region-category':renderQsRegionCategory,
  intent:       renderIntent,
  relevant:     renderRelevantTerms,
  competitors:  renderCompetitors,
  flagged:      renderFlagged,
  'ad-copy':    renderAdCopy,
  'ad-lp-pairing': renderAdLpPairing,
  'lp-perf':    renderLpPerf,
  'lp-category': renderLpCategory,
  'lp-device':  renderLpDevice,
  'zip-overlap': renderZipOverlap,
  recs:         renderRecs,
};
const labels = {
  overview:'Overview', trends:'Monthly Trends', 'brands-all':'All Brands',
  'brand-detail':'Brand Detail', 'nb-cats':'NB Categories', regions:'Regions',
  'kw-deep-dive':'Keyword Deep Dive', 'qs-overview':'QS Overview', 'qs-breakdown':'QS Breakdown', 'qs-region-category':'Region & Category',
  intent:'Intent & Grades', relevant:'Relevant Terms', competitors:'Competitor Terms', flagged:'Flagged / Review',
  'ad-copy':'Ad Copy', 'ad-lp-pairing':'Ad ↔ LP Pairing',
  'lp-perf':'LP Performance', 'lp-category':'LP Category Grid', 'lp-device':'LP Device Grid',
  'zip-overlap':'ZIP Overlap Grid', recs:'Recommendations',
};

let CURRENT_VIEW = 'overview';
let BRAND = 'ALL'; // global brand filter
let AD_SEGMENT = 'NB'; // Ad Copy tabs: 'BR' or 'NB'
let PAIRING_CELL = null; // {ad, lp} selected cell on Ad↔LP Pairing tab
// Keyword Deep Dive view state (preserved across brand-filter re-renders)
let KDD_TYPE = 'NB';        // 'NB' | 'BR'
let KDD_CRITERIA = 'spend'; // 'spend' | 'conv'
let KDD_METRIC = 'spend';   // metric shown in the cells
// Non-Brand Categories chart metric (persisted across re-renders)
let NBC_METRIC = 'spend';   // 'spend' | 'conv'

// Views where brand filter does not affect anything (portfolio-only data)
const BRAND_FILTER_HIDDEN_VIEWS = new Set(['brands-all', 'qs-overview']);

function setView(name, opts) {
  opts = opts || {};
  const prevScroll = opts.preserveScroll ? window.scrollY : 0;
  CURRENT_VIEW = name;
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view===name));
  $('#crumb').textContent = labels[name] || name;
  // Hide brand filter on views where it has no effect
  const bf = $('#brandFilter');
  if (bf) bf.style.display = BRAND_FILTER_HIDDEN_VIEWS.has(name) ? 'none' : '';
  const root = $('#view-root');
  root.innerHTML = '<div class="view" id="view-pane"></div>';
  const pane = document.getElementById('view-pane');
  (views[name]||renderOverview)(pane);
  maybeDateNote(pane, name);
  window.scrollTo({top: prevScroll, behavior:'instant'});
}

// When a date range is applied but this view can't honour it (whole-window export,
// no per-row date), prepend a small note so the tab doesn't look "broken".
function maybeDateNote(pane, name) {
  const meta = (window.__BUNDLE__ && window.__BUNDLE__.meta) || {};
  const dr = meta.date_range || {};
  if (!dr.applied || (dr.windowed_views || []).indexOf(name) >= 0) return;
  const note = document.createElement('div');
  note.className = 'panel';
  note.style.cssText = 'background:#FCFEF0;border-left:3px solid var(--lime,#CFFF04);margin-bottom:14px;font-size:12.5px;color:var(--grey,#666)';
  note.innerHTML = 'This report is a single whole-window export with no per-row date, so it ignores the selected date range and shows the full window. The date range applies to the time-series views (Overview, Monthly Trends, Campaign Performance, Pacing, NB Categories, Regions).';
  pane.insertBefore(note, pane.firstChild);
}

$$('.nav-item').forEach(n => n.addEventListener('click', () => setView(n.dataset.view)));

function onBrandChange() {
  BRAND = $('#brandFilterSel').value;
  $('#brandFilter').classList.toggle('active', BRAND !== 'ALL');
  setView(CURRENT_VIEW, {preserveScroll: true}); // re-render current view; keep scroll
}

function renderAll() {
  document.getElementById('now').textContent = new Date().toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  $('#brandFilterSel').addEventListener('change', onBrandChange);
  setView('overview');
}

// ====== BRAND FILTER HELPERS ======
// Infer brand code from a landing-page URL. Falls back to landing_pages.Brands lookup.
const URL_BRAND_LUT = (() => {
  const m = {};
  (DATA.landing_pages || []).forEach(r => {
    const u = r['Landing Page URL']; const b = r['Brands'];
    if (u && b) m[u] = b;
  });
  return m;
})();
function urlToBrand(url) {
  if (!url) return '';
  if (URL_BRAND_LUT[url]) return URL_BRAND_LUT[url];
  const u = String(url).toLowerCase();
  if (u.includes('/tirekingdom')) return 'TK';
  if (u.includes('/ntb'))         return 'NTB';
  if (u.includes('expressoil'))   return 'EOC';
  if (u.includes('brakesplus'))   return 'BP';
  if (u.includes('tuffy'))        return 'TUF';
  if (u.includes('mavis.com'))    return 'MAVIS';
  return '';
}
function brandMatchesList(list, filter) {
  if (!filter || filter === 'ALL') return true;
  if (!list) return false;
  return String(list).toUpperCase().split(/[,\s/|]+/).includes(filter.toUpperCase());
}
function rowMatchesBrand(row, filter) {
  if (!filter || filter === 'ALL') return true;
  const bf = row && (row['Brands'] || row.brands || row.Brand);
  return brandMatchesList(bf, filter);
}

// ====== TABLE SORTING ======
function makeSortable(table) {
  if (!table.tHead || !table.tHead.rows.length) return;
  const headers = table.tHead.rows[0].cells;
  for (let i=0; i<headers.length; i++) {
    const th = headers[i];
    if (th.classList.contains('nosort')) continue;
    if (th.dataset.sortBound === '1') continue;
    th.classList.add('sortable');
    th.dataset.col = i;
    th.dataset.sortBound = '1';
    th.addEventListener('click', () => {
      const col = Number(th.dataset.col);
      const isNum = th.classList.contains('num');
      const cur = th.classList.contains('asc') ? 'desc' : (th.classList.contains('desc') ? 'asc' : 'desc');
      for (const h of headers) { h.classList.remove('asc','desc'); }
      th.classList.add(cur);
      const dir = cur === 'asc' ? 1 : -1;
      const tbody = table.tBodies[0];
      const rows = Array.from(tbody.rows);
      rows.sort((a,b) => {
        const ac = a.cells[col]; const bc = b.cells[col];
        const aa = (ac && (ac.dataset.sort ?? ac.innerText)) || '';
        const bb = (bc && (bc.dataset.sort ?? bc.innerText)) || '';
        if (isNum) {
          const an = parseFloat(String(aa).replace(/[^0-9.\-]/g,''));
          const bn = parseFloat(String(bb).replace(/[^0-9.\-]/g,''));
          const aNaN = isNaN(an), bNaN = isNaN(bn);
          if (aNaN && bNaN) return 0;
          if (aNaN) return 1;
          if (bNaN) return -1;
          return (an - bn) * dir;
        }
        return String(aa).localeCompare(String(bb)) * dir;
      });
      for (const r of rows) tbody.appendChild(r);
    });
  }
}
function enableSortable(root) {
  const tables = (root || document).querySelectorAll('table.sortable, table');
  tables.forEach(makeSortable);
}

// ====== OVERVIEW ======
function renderOverview(el) {
  const useBrand = BRAND !== 'ALL' && DATA.brand_trends && DATA.brand_trends[BRAND];
  const trend = useBrand ? DATA.brand_trends[BRAND] : DATA.total_trend;
  const find = (DATA.findings||[]).slice(0, 6);
  const tot = trend[trend.length-1];

  // KPIs: when a brand is selected, derive from brand_yoy; else use global kpis
  let k;
  if (useBrand) {
    const row = (DATA.brand_yoy||[]).find(r => r.Brand === BRAND) || {};
    k = [
      { Metric:'Total Spend',          'Mar 2025': row['Mar 2025 Spend'],  'Mar 2026': row['Mar 2026 Spend'],  Change: row['Chg_Mar_2026_Spend'] },
      { Metric:'Main Conversions',     'Mar 2025': row['Mar 2025 Conv'],   'Mar 2026': row['Mar 2026 Conv'],   Change: row['Chg_Mar_2026_Conv'] },
      { Metric:'CPA (Main Conv)',      'Mar 2025': row['Mar 2025 CPA'],    'Mar 2026': row['Mar 2026 CPA'],    Change: row['Chg_Mar_2026_CPA'] },
      { Metric:'Web Reservations',     'Mar 2025': row['Mar 2025 Web Res'],'Mar 2026': row['Mar 2026 Web Res'],Change: row['Chg_Mar_2026_Web_Res'] },
      { Metric:'Phone Calls',          'Mar 2025': row['Mar 2025 Phone'],  'Mar 2026': row['Mar 2026 Phone'],  Change: row['Chg_Mar_2026_Phone'] },
    ];
  } else {
    k = DATA.kpis;
  }
  function kget(metric){ const row = k.find(x=>x.Metric===metric); return row ? row.Change : null; }

  const prim = [
    {key:'spend', label:'Spend', val:tot.Spend, chg:kget('Total Spend')},
    {key:'conv',  label:'Main Conversions', val:tot['Main Conv'], chg:kget('Main Conversions')},
    {key:'cpa',   label:'CPA', val:tot.CPA, chg:kget('CPA (Main Conv)'), invert:true},
    {key:'cvr',   label:'CVR', val:tot.CVR, chg:useBrand?null:kget('CVR (Main Conv)')},
    {key:'webres',label:'Web Reservations', val:tot['Web Res'], chg:kget('Web Reservations')},
    {key:'calls', label:'Phone Calls', val:tot['Phone Calls'], chg:kget('Phone Calls')},
  ];
  const statCards = prim.map((m, i) => {
    const val = (m.key==='spend')? fmt.money(m.val)
              : (m.key==='cpa') ? fmt.money(m.val, 2)
              : (m.key==='cvr') ? fmt.pct(m.val, 2)
              : fmt.num(m.val);
    const chg = m.chg;
    const inv = m.invert ? (chg!=null&&chg<=0?'up':'dn') : (chg!=null&&chg>=0?'up':'dn');
    const chgStr = chg==null?'—':(chg>=0?'+':'')+(chg*100).toFixed(1)+'% YoY';
    return `<div class="stat ${i===0?'hl':''}">
      <div class="stat-label">${m.label}</div>
      <div class="stat-value">${val}</div>
      <div class="stat-chg ${inv}">${chgStr}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h2>${useBrand ? BRAND : CLIENT_LABEL} · ${PERIOD_LABEL}</h2>
        <div class="muted">${useBrand ? `${BRAND} brand performance` : (META.name ? 'Account performance overview' : 'YoY performance across all 5 brands')} · All campaign types</div>
      </div>
      <div>
        <span class="tag lime">${useBrand ? `Brand: ${BRAND}` : 'YoY Improving'}</span>
      </div>
    </div>

    <div class="stat-grid">${statCards}</div>

    <div class="two-col">
      <div class="panel">
        <h3>Spend &amp; Conversions — ${trend.length} months</h3>
        <canvas id="ovTrend" height="180"></canvas>
      </div>
      <div class="panel">
        <h3>YoY KPI scorecard</h3>
        <div class="tbl-wrap">
          <table class="sortable">
            <thead><tr><th>Metric</th><th class="num">${PRIOR_LABEL}</th><th class="num">${CUR_LABEL}</th><th class="num">YoY</th></tr></thead>
            <tbody>
              ${k.map(r => {
                const isCost = /CPA|CPC|Cost/.test(r.Metric);
                const cls = isCost ? (r.Change<=0?'up':'dn') : (r.Change>=0?'up':'dn');
                return `<tr>
                  <td class="strong">${r.Metric}</td>
                  <td class="num" data-sort="${r['Mar 2025']}">${fmtSmart(r.Metric, r['Mar 2025'])}</td>
                  <td class="num" data-sort="${r['Mar 2026']}">${fmtSmart(r.Metric, r['Mar 2026'])}</td>
                  <td class="num chg ${cls}" data-sort="${r.Change}">${fmt.chg(r.Change)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>Key findings</h3>
      <ul style="margin: 6px 0 0; padding-left: 18px; color: var(--grey-700);">
        ${find.map(f => {
          if (typeof f === 'string') return `<li style="margin-bottom: 6px;">${f}</li>`;
          const topic = f.topic||f.title||'';
          const detail = f.detail||f.text||f.description||'';
          return `<li style="margin-bottom: 8px;">${topic?`<strong style="color:var(--ink);">${topic}:</strong> `:''}${detail}</li>`;
        }).join('')}
      </ul>
    </div>
  `;

  const labels2 = trend.map(r=>r.Month);
  const spend = trend.map(r=>r.Spend);
  const conv  = trend.map(r=>r['Main Conv']);
  new Chart(document.getElementById('ovTrend'), {
    type:'line',
    data:{ labels: labels2, datasets: [
      { label:'Spend', data: spend, borderColor: '#1A1A1A', backgroundColor:'rgba(26,26,26,0.06)', tension:.3, fill:true, yAxisID:'y', borderWidth: 2 },
      { label:'Main Conv', data: conv, borderColor: '#CFFF04', backgroundColor:'rgba(207,255,4,0.25)', tension:.3, fill:false, yAxisID:'y1', borderWidth: 3, pointBackgroundColor:'#1A1A1A' },
    ]},
    options: chartOpts({ dualY:true })
  });
  enableSortable(el);
}

function fmtSmart(metric, v) {
  if (v==null) return '—';
  if (/CVR|Res Rate/.test(metric)) return fmt.pct(v,2);
  if (/CPA|CPC|Cost/.test(metric) && !/Clicks|Calls|Marchex/.test(metric)) return fmt.money(v, 2);
  if (/Spend/.test(metric)) return fmt.money(v, 0);
  return fmt.num(v, 0);
}

// ====== TRENDS ======
function renderTrends(el) {
  const useBrand = BRAND !== 'ALL' && DATA.brand_trends && DATA.brand_trends[BRAND];
  const trend = useBrand ? DATA.brand_trends[BRAND] : DATA.total_trend;
  const months = trend.map(r=>r.Month);
  el.innerHTML = `
    <div class="view-head"><div><h2>Monthly Trends</h2><div class="muted">${months.length}-month view across all metrics · ${useBrand ? BRAND+' brand' : (META.name || 'All brands combined')}</div></div></div>
    <div class="panel">
      <div class="toolbar">
        <label>Primary (left axis):</label>
        <select id="metSel">
          <option value="Spend">Spend</option>
          <option value="Main Conv" selected>Main Conversions</option>
          <option value="Clicks">Clicks</option>
          <option value="CPA">CPA</option>
          <option value="CVR">CVR</option>
          <option value="Web Res">Web Reservations</option>
          <option value="Phone Calls">Phone Calls</option>
        </select>
        <label style="margin-left:14px;">Secondary (right axis):</label>
        <select id="metSel2">
          <option value="">None</option>
          <option value="Spend">Spend</option>
          <option value="Main Conv">Main Conversions</option>
          <option value="Clicks">Clicks</option>
          <option value="CPA">CPA</option>
          <option value="CVR">CVR</option>
          <option value="Web Res">Web Reservations</option>
          <option value="Phone Calls">Phone Calls</option>
        </select>
      </div>
      <canvas id="trChart" height="140"></canvas>
    </div>
    <div class="panel">
      <h3>All months — data table</h3>
      <div class="tbl-wrap">
        <table class="sortable">
          <thead><tr>
            <th>Month</th><th class="num">Spend</th><th class="num">Clicks</th><th class="num">Main Conv</th>
            <th class="num">CPA</th><th class="num">CVR</th><th class="num">CPC</th>
            <th class="num">Web Res</th><th class="num">Phone Calls</th>
          </tr></thead>
          <tbody>${trend.map(r => `<tr>
            <td class="strong">${r.Month}</td>
            <td class="num">${fmt.money(r.Spend)}</td>
            <td class="num">${fmt.num(r.Clicks)}</td>
            <td class="num">${fmt.num(r['Main Conv'])}</td>
            <td class="num">${fmt.money(r.CPA,2)}</td>
            <td class="num">${fmt.pct(r.CVR,2)}</td>
            <td class="num">${fmt.money(r.CPC,2)}</td>
            <td class="num">${fmt.num(r['Web Res'])}</td>
            <td class="num">${fmt.num(r['Phone Calls'])}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  `;

  let chart;
  const fmtFor = m => {
    const pct = /CVR|Rate/.test(m);
    const money = /CPA|CPC|Spend|Cost/.test(m);
    return { pct, money, fmt: v => v==null ? '—' : (money ? '$'+Number(v).toLocaleString(undefined,{maximumFractionDigits:2}) : pct ? (Number(v)*100).toFixed(2)+'%' : Number(v).toLocaleString()) };
  };
  function axisTicks(m) {
    const f = fmtFor(m);
    return v => f.money ? '$'+Number(v).toLocaleString() : f.pct ? (Number(v)*100).toFixed(0)+'%' : Number(v).toLocaleString();
  }
  function draw() {
    const metric  = $('#metSel').value;
    const metric2 = $('#metSel2').value;
    const f1 = fmtFor(metric);
    const data1 = trend.map(r => r[metric]);
    const datasets = [{
      label: metric, data: data1, yAxisID: 'y',
      borderColor:'#1A1A1A', backgroundColor:'rgba(207,255,4,0.35)',
      tension:.3, fill:true, borderWidth: 2, pointBackgroundColor:'#CFFF04', pointBorderColor:'#1A1A1A'
    }];
    const opts = chartOpts({ moneyAxis: f1.money, pctAxis: f1.pct });
    if (metric2) {
      const f2 = fmtFor(metric2);
      const data2 = trend.map(r => r[metric2]);
      datasets.push({
        label: metric2, data: data2, yAxisID: 'y1',
        borderColor:'#2563eb', backgroundColor:'rgba(37,99,235,0.08)',
        borderDash: [6,3], tension:.3, fill:false, borderWidth: 2,
        pointBackgroundColor:'#2563eb', pointBorderColor:'#1A1A1A'
      });
      opts.scales.y1 = {
        position:'right',
        ticks:{ color:'#2563eb', font:{family:'Inter', size:11}, callback: axisTicks(metric2) },
        grid:{ drawOnChartArea:false },
        title: { display:true, text: metric2, color:'#2563eb', font:{family:'Inter', size:12, weight:'600'} }
      };
      opts.scales.y.title = { display:true, text: metric, color:'#1A1A1A', font:{family:'Inter', size:12, weight:'600'} };
      opts.plugins.tooltip = Object.assign({}, opts.plugins.tooltip, {
        callbacks: {
          label: (ctx) => {
            const m = ctx.dataset.label;
            return '  '+m+': '+fmtFor(m).fmt(ctx.parsed.y);
          }
        }
      });
    }
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('trChart'), {
      type:'line',
      data:{ labels: months, datasets },
      options: opts
    });
  }
  $('#metSel').addEventListener('change', draw);
  $('#metSel2').addEventListener('change', draw);
  draw();
  enableSortable(el);
}

// ====== ALL BRANDS ======
function renderBrandsAll(el) {
  const by = DATA.brand_yoy;
  el.innerHTML = `
    <div class="view-head">
      <div><h2>All Brands · Year-over-Year</h2>
        <div class="muted">All campaign types combined · March 2025 vs March 2026</div>
      </div>
    </div>
    <div class="panel">
      <div class="toolbar">
        <label>Metric:</label>
        <div id="metricChips"></div>
      </div>
      <canvas id="abChart" height="160"></canvas>
    </div>
    <div class="panel">
      <h3>YoY comparison by brand</h3>
      <div class="tbl-wrap">
        <table class="sortable" id="abTbl">
          <thead><tr>
            <th>Brand</th>
            <th class="num">Mar 2025 Spend</th><th class="num">Mar 2026 Spend</th><th class="num">Chg</th>
            <th class="num">Mar 2025 Conv</th><th class="num">Mar 2026 Conv</th><th class="num">Chg</th>
            <th class="num">Mar 2025 CPA</th><th class="num">Mar 2026 CPA</th><th class="num">Chg</th>
            <th class="num">Mar 2025 Web Res</th><th class="num">Mar 2026 Web Res</th><th class="num">Chg</th>
          </tr></thead>
          <tbody>${by.map(r => {
            const chgCls = c => c==null?'':(c>=0?'up':'dn');
            const invCls = c => c==null?'':(c<=0?'up':'dn');
            const cS=r['Chg_Mar_2026_Spend'], cC=r['Chg_Mar_2026_Conv'], cP=r['Chg_Mar_2026_CPA'], cW=r['Chg_Mar_2026_Web_Res'];
            return `<tr>
              <td class="strong"><span class="tag info">${r.Brand}</span></td>
              <td class="num">${fmt.money(r['Mar 2025 Spend'])}</td>
              <td class="num">${fmt.money(r['Mar 2026 Spend'])}</td>
              <td class="num chg ${chgCls(cS)}" data-sort="${cS}">${fmt.chg(cS)}</td>
              <td class="num">${fmt.num(r['Mar 2025 Conv'])}</td>
              <td class="num">${fmt.num(r['Mar 2026 Conv'])}</td>
              <td class="num chg ${chgCls(cC)}" data-sort="${cC}">${fmt.chg(cC)}</td>
              <td class="num">${fmt.money(r['Mar 2025 CPA'],2)}</td>
              <td class="num">${fmt.money(r['Mar 2026 CPA'],2)}</td>
              <td class="num chg ${invCls(cP)}" data-sort="${cP}">${fmt.chg(cP)}</td>
              <td class="num">${fmt.num(r['Mar 2025 Web Res'])}</td>
              <td class="num">${fmt.num(r['Mar 2026 Web Res'])}</td>
              <td class="num chg ${chgCls(cW)}" data-sort="${cW}">${fmt.chg(cW)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>
  `;
  const mets = [
    {k:'spend', label:'Spend', fm25:'Mar 2025 Spend', fm26:'Mar 2026 Spend', money:true},
    {k:'conv',  label:'Conv',  fm25:'Mar 2025 Conv',  fm26:'Mar 2026 Conv'},
    {k:'cpa',   label:'CPA',   fm25:'Mar 2025 CPA',   fm26:'Mar 2026 CPA', money:true},
    {k:'webres',label:'Web Res', fm25:'Mar 2025 Web Res', fm26:'Mar 2026 Web Res'},
  ];
  const chipsEl = $('#metricChips');
  chipsEl.innerHTML = mets.map((m,i)=>`<span class="chip ${i===0?'active':''}" data-k="${m.k}">${m.label}</span>`).join('');
  let cur = 'spend';
  let chart;
  function draw() {
    const m = mets.find(x=>x.k===cur);
    const labels = by.filter(r=>r.Brand!=='TOTAL').map(r=>r.Brand);
    const d25 = by.filter(r=>r.Brand!=='TOTAL').map(r=>r[m.fm25]);
    const d26 = by.filter(r=>r.Brand!=='TOTAL').map(r=>r[m.fm26]);
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('abChart'), {
      type:'bar',
      data:{ labels, datasets:[
        { label:'Mar 2025', data: d25, backgroundColor:'#9CA3AF', borderRadius: 4 },
        { label:'Mar 2026', data: d26, backgroundColor:'#CFFF04', borderColor: '#1A1A1A', borderWidth: 1, borderRadius: 4 },
      ]},
      options: chartOpts({ moneyAxis: !!m.money })
    });
  }
  chipsEl.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{
    chipsEl.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));
    c.classList.add('active'); cur=c.dataset.k; draw();
  }));
  draw();
  enableSortable(el);
}

// ====== BRAND DETAIL ======
function renderBrandDetail(el) {
  const brands = Object.keys(DATA.brand_regions || {});
  const allCats = DATA.nb_category_list || [];
  const defaultBrand = (BRAND !== 'ALL' && brands.includes(BRAND)) ? BRAND : 'MAVIS';
  el.innerHTML = `
    <div class="view-head">
      <div><h2>Brand Detail · by Region</h2>
        <div class="muted">Select a brand to see region-level YoY (Non-Brand campaigns) · optional category filter</div>
      </div>
    </div>
    <div class="panel">
      <div class="toolbar">
        <label>Brand:</label>
        <select id="bdBrand">${brands.map(b=>`<option value="${b}" ${b===defaultBrand?'selected':''}>${b}</option>`).join('')}</select>
        <label style="margin-left: 14px;">Categories:</label>
        <div class="multi">
          <button class="multi-btn" id="bdCatBtn" type="button">All categories</button>
          <div class="multi-menu hidden" id="bdCatMenu">
            ${allCats.map(c=>`<label><input type="checkbox" value="${c}"> ${c}</label>`).join('')}
          </div>
        </div>
        <span style="margin-left: 12px;" id="bdFilterNote" class="muted"></span>
      </div>
      <div class="toolbar" style="margin-top: 4px;">
        <label>Metric:</label>
        <div id="bdMetricChips"></div>
      </div>
      <canvas id="bdChart" height="160"></canvas>
    </div>
    <div class="panel">
      <h3 id="bdTitle">Region YoY for <span id="bdBrandH">${defaultBrand}</span></h3>
      <div class="tbl-wrap">
        <table class="sortable" id="bdTbl">
          <thead id="bdHead"></thead>
          <tbody id="bdBody"></tbody>
        </table>
      </div>
    </div>
  `;

  const btn = $('#bdCatBtn'), menu = $('#bdCatMenu');
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target!==btn) menu.classList.add('hidden'); });

  const selectedCats = () => Array.from(menu.querySelectorAll('input:checked')).map(i=>i.value);

  // Metric chips (parallel to All Brands tab)
  const bdMets = [
    { k:'spend',  label:'Spend',   money:true,  k25:'spend_25',  k26:'spend_26',  aggKey:'cost' },
    { k:'conv',   label:'Conv',    money:false, k25:'conv_25',   k26:'conv_26',   aggKey:'conv' },
    { k:'cpa',    label:'CPA',     money:true,  k25:'cpa_25',    k26:'cpa_26',    aggKey:'cpa' },
    { k:'webres', label:'Web Res', money:false, k25:'webres_25', k26:'webres_26', aggKey:null  },
  ];
  const chipsEl = $('#bdMetricChips');
  let curMetric = 'spend';
  function renderChips(catsActive) {
    const shown = catsActive ? bdMets.filter(m => m.aggKey !== null) : bdMets;
    if (!shown.find(m=>m.k===curMetric)) curMetric = 'spend';
    chipsEl.innerHTML = shown.map(m => `<span class="chip ${m.k===curMetric?'active':''}" data-k="${m.k}">${m.label}</span>`).join('');
    chipsEl.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
      curMetric = c.dataset.k; draw();
    }));
  }

  let chart;
  function draw() {
    const brand = $('#bdBrand').value;
    const cats  = selectedCats();
    $('#bdBrandH').textContent = brand;
    btn.textContent = cats.length===0 ? 'All categories' : (cats.length+' selected');

    if (cats.length === 0) {
      $('#bdFilterNote').textContent = 'NB-campaign YoY · all categories';
      const regions = (DATA.brand_regions[brand] || []).filter(r => r.spend_26 || r.spend_25);
      regions.sort((a,b)=>(b.spend_26||0)-(a.spend_26||0));
      $('#bdHead').innerHTML = `<tr>
        <th>Region</th>
        <th class="num">Mar 2025 Spend</th><th class="num">Mar 2026 Spend</th><th class="num">Chg</th>
        <th class="num">Mar 2025 Conv</th><th class="num">Mar 2026 Conv</th><th class="num">Chg</th>
        <th class="num">Mar 2025 CPA</th><th class="num">Mar 2026 CPA</th><th class="num">Chg</th>
        <th class="num">Mar 2025 Web Res</th><th class="num">Mar 2026 Web Res</th><th class="num">Chg</th>
      </tr>`;
      const chgCls = c => c==null?'':(c>=0?'up':'dn'); const invCls = c => c==null?'':(c<=0?'up':'dn');
      $('#bdBody').innerHTML = regions.map(r => `<tr>
        <td class="strong">${r.region}</td>
        <td class="num">${fmt.money(r.spend_25)}</td>
        <td class="num">${fmt.money(r.spend_26)}</td>
        <td class="num chg ${chgCls(r.spend_chg)}" data-sort="${r.spend_chg}">${fmt.chg(r.spend_chg)}</td>
        <td class="num">${fmt.num(r.conv_25)}</td>
        <td class="num">${fmt.num(r.conv_26)}</td>
        <td class="num chg ${chgCls(r.conv_chg)}" data-sort="${r.conv_chg}">${fmt.chg(r.conv_chg)}</td>
        <td class="num">${fmt.money(r.cpa_25,2)}</td>
        <td class="num">${fmt.money(r.cpa_26,2)}</td>
        <td class="num chg ${invCls(r.cpa_chg)}" data-sort="${r.cpa_chg}">${fmt.chg(r.cpa_chg)}</td>
        <td class="num">${fmt.num(r.webres_25)}</td>
        <td class="num">${fmt.num(r.webres_26)}</td>
        <td class="num chg ${chgCls(r.webres_chg)}" data-sort="${r.webres_chg}">${fmt.chg(r.webres_chg)}</td>
      </tr>`).join('');

      renderChips(false);
      const m = bdMets.find(x => x.k === curMetric) || bdMets[0];
      // Exclude the per-brand "* TOTAL" row from the chart — it's a total, not a region.
      const isTotalRegion = r => /\bTOTAL\b/i.test(String(r.region||r.Region||''));
      const top = [...regions]
        .filter(r => !isTotalRegion(r))
        .sort((a,b)=>(b[m.k26]||0)-(a[m.k26]||0))
        .slice(0, 12);
      if (chart) chart.destroy();
      chart = new Chart(document.getElementById('bdChart'), {
        type:'bar',
        data:{ labels: top.map(r=>r.region), datasets:[
          { label:'Mar 2025 ' + m.label, data: top.map(r=>r[m.k25]), backgroundColor:'#9CA3AF', borderRadius:4 },
          { label:'Mar 2026 ' + m.label, data: top.map(r=>r[m.k26]), backgroundColor:'#CFFF04', borderColor:'#1A1A1A', borderWidth:1, borderRadius:4 },
        ]},
        options: chartOpts({ moneyAxis: !!m.money })
      });
    } else {
      $('#bdFilterNote').textContent = 'Category filter active · Mar 2026 aggregate (YoY not available with category breakdown)';
      const brc = (DATA.brand_region_category || {})[brand] || {};
      const rows = [];
      for (const region in brc) {
        const cats_ = brc[region];
        let cost=0, clicks=0, conv=0, impr=0;
        let matched = false;
        for (const c of cats) {
          if (cats_[c]) {
            matched = true;
            cost += cats_[c].cost||0;
            clicks += cats_[c].clicks||0;
            conv += cats_[c].conv||0;
            impr += cats_[c].impr||0;
          }
        }
        if (matched) {
          rows.push({
            region, cost, clicks, impr, conv,
            cvr: clicks? conv/clicks : 0,
            cpa: conv? cost/conv : 0,
          });
        }
      }
      rows.sort((a,b)=>b.cost-a.cost);
      $('#bdHead').innerHTML = `<tr>
        <th>Region</th>
        <th class="num">Mar 2026 Spend</th><th class="num">Clicks</th><th class="num">Impr</th>
        <th class="num">Conv</th><th class="num">CVR</th><th class="num">CPA</th>
      </tr>`;
      $('#bdBody').innerHTML = rows.length === 0
        ? `<tr><td colspan="7" style="padding:20px;color:var(--grey);">No data for this brand + category combination.</td></tr>`
        : rows.map(r => `<tr>
            <td class="strong">${r.region}</td>
            <td class="num">${fmt.money(r.cost)}</td>
            <td class="num">${fmt.num(r.clicks)}</td>
            <td class="num">${fmt.num(r.impr)}</td>
            <td class="num">${fmt.num(r.conv,0)}</td>
            <td class="num">${fmt.pct(r.cvr,2)}</td>
            <td class="num">${fmt.money(r.cpa,2)}</td>
          </tr>`).join('');

      renderChips(true);
      const m = bdMets.find(x => x.k === curMetric) || bdMets[0];
      if (chart) chart.destroy();
      const top = [...rows].sort((a,b)=>(b[m.aggKey]||0)-(a[m.aggKey]||0)).slice(0, 12);
      chart = new Chart(document.getElementById('bdChart'), {
        type:'bar',
        data:{ labels: top.map(r=>r.region), datasets:[
          { label:'Mar 2026 ' + m.label, data: top.map(r=>r[m.aggKey]), backgroundColor:'#CFFF04', borderColor:'#1A1A1A', borderWidth:1, borderRadius:4 },
        ]},
        options: chartOpts({ moneyAxis: !!m.money })
      });
    }
    const t = document.getElementById('bdTbl');
    Array.from(t.tHead.rows[0].cells).forEach(c => { c.classList.remove('sortable','asc','desc'); c.dataset.sortBound=''; });
    makeSortable(t);
  }

  $('#bdBrand').addEventListener('change', draw);
  menu.addEventListener('change', draw);
  draw();
}

// ====== NB CATEGORIES ======
function renderNbCats(el) {
  const src = DATA.nb_categories || {};
  const brand = (BRAND !== 'ALL' && src[BRAND]) ? BRAND : 'MAVIS';
  const cats = Array.isArray(src) ? src : (src[brand] || []);
  // Exclude the "* NB TOTAL" summary row from category charts — it's a total, not a category.
  const isTotalRow = r => /\bNB\s*TOTAL\b/i.test(String(r.Category||''));
  const catsChart = cats.filter(r => !isTotalRow(r));

  const NBC_METRICS = {
    spend: { label:'Spend', col25:'Mar 2025 Spend', col26:'Mar 2026 Spend', money:true,  donutTitle:'Mar 2026 spend share', barTitle:'YoY Spend' },
    conv:  { label:'Conversions', col25:'Mar 2025 Conv', col26:'Mar 2026 Conv', money:false, donutTitle:'Mar 2026 conversions share', barTitle:'YoY Conversions' },
  };
  const m = NBC_METRICS[NBC_METRIC] || NBC_METRICS.spend;
  const metricPill = (v, lbl) =>
    `<button class="seg-pill ${NBC_METRIC===v?'active':''}" data-nbc-metric="${v}">${lbl}</button>`;

  el.innerHTML = `
    <div class="view-head">
      <div><h2>Non-Brand Categories</h2>
        <div class="muted">YoY by non-brand category · ${brand} portfolio${BRAND==='ALL' ? ' (default)' : ''}</div></div>
      <div class="view-head-ctl">
        <label class="kdd-ctl-lbl">Chart metric</label>
        <div class="seg-group">${metricPill('spend','Spend')}${metricPill('conv','Conversions')}</div>
      </div>
    </div>
    <div class="two-col">
      <div class="panel">
        <h3>${m.donutTitle}</h3>
        <canvas id="ncDonut" height="220"></canvas>
      </div>
      <div class="panel">
        <h3>${m.barTitle}</h3>
        <canvas id="ncBars" height="220"></canvas>
      </div>
    </div>
    <div class="panel">
      <h3>Category YoY detail</h3>
      <div class="tbl-wrap">
        <table class="sortable">
          <thead><tr>
            <th>Category</th>
            <th class="num">Mar 2025 Spend</th><th class="num">Mar 2026 Spend</th><th class="num">Chg</th>
            <th class="num">Mar 2025 Conv</th><th class="num">Mar 2026 Conv</th><th class="num">Chg</th>
            <th class="num">Mar 2025 CPA</th><th class="num">Mar 2026 CPA</th><th class="num">Chg</th>
          </tr></thead>
          <tbody>${cats.map(r=>{
            const chgCls = c => c==null?'':(c>=0?'up':'dn'); const invCls = c => c==null?'':(c<=0?'up':'dn');
            const cS=r['Chg_Mar_2026_Spend'], cC=r['Chg_Mar_2026_Conv'], cP=r['Chg_Mar_2026_CPA'];
            return `<tr>
              <td class="strong"><span class="tag info">${r.Category}</span></td>
              <td class="num">${fmt.money(r['Mar 2025 Spend'])}</td>
              <td class="num">${fmt.money(r['Mar 2026 Spend'])}</td>
              <td class="num chg ${chgCls(cS)}" data-sort="${cS}">${fmt.chg(cS)}</td>
              <td class="num">${fmt.num(r['Mar 2025 Conv'])}</td>
              <td class="num">${fmt.num(r['Mar 2026 Conv'])}</td>
              <td class="num chg ${chgCls(cC)}" data-sort="${cC}">${fmt.chg(cC)}</td>
              <td class="num">${fmt.money(r['Mar 2025 CPA'],2)}</td>
              <td class="num">${fmt.money(r['Mar 2026 CPA'],2)}</td>
              <td class="num chg ${invCls(cP)}" data-sort="${cP}">${fmt.chg(cP)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>
  `;

  // Wire up metric toggle — re-render the view on change, preserving scroll
  el.querySelectorAll('[data-nbc-metric]').forEach(b => b.addEventListener('click', () => {
    NBC_METRIC = b.dataset.nbcMetric;
    setView('nb-cats', {preserveScroll:true});
  }));

  new Chart(document.getElementById('ncDonut'), {
    type:'doughnut',
    data:{ labels: catsChart.map(r=>r.Category), datasets:[{
      data: catsChart.map(r=>r[m.col26]),
      backgroundColor: ['#CFFF04','#1A1A1A','#6B7280','#2563eb','#059669','#ea580c','#7c3aed','#dc2626','#f59e0b'],
      borderColor:'#fff', borderWidth:2
    }]},
    options: { responsive:true, plugins:{ legend:{ position:'right', labels:{ color:'#1A1A1A', font:{ family:'Inter', size:12 } } } } }
  });
  new Chart(document.getElementById('ncBars'), {
    type:'bar',
    data:{ labels: catsChart.map(r=>r.Category), datasets:[
      { label:`Mar 2025 ${m.label}`, data: catsChart.map(r=>r[m.col25]), backgroundColor:'#9CA3AF', borderRadius:4 },
      { label:`Mar 2026 ${m.label}`, data: catsChart.map(r=>r[m.col26]), backgroundColor:'#CFFF04', borderColor:'#1A1A1A', borderWidth:1, borderRadius:4 },
    ]},
    options: chartOpts({ moneyAxis: m.money })
  });
  enableSortable(el);
}

// ====== REGIONS ======
function renderRegions(el) {
  const brand = (BRAND !== 'ALL' && DATA.brand_regions && DATA.brand_regions[BRAND]) ? BRAND : 'MAVIS';
  const allCats = DATA.nb_category_list || [];
  el.innerHTML = `
    <div class="view-head"><div><h2>${brand} Regions</h2>
      <div class="muted">Non-Brand campaigns · YoY by region${BRAND==='ALL' ? ' · MAVIS default (pick a brand to switch)' : ''}</div></div></div>
    <div class="panel">
      <div class="toolbar">
        <label>Categories:</label>
        <div class="multi">
          <button class="multi-btn" id="regCatBtn" type="button">All categories</button>
          <div class="multi-menu hidden" id="regCatMenu">
            ${allCats.map(c=>`<label><input type="checkbox" value="${c}"> ${c}</label>`).join('')}
          </div>
        </div>
        <span style="margin-left: 12px;" id="regFilterNote" class="muted"></span>
      </div>
      <h3 style="margin-top:12px;">Top regions by Mar 2026 spend</h3>
      <canvas id="regChart" height="150"></canvas>
    </div>
    <div class="panel">
      <h3 id="regTblTitle">Region YoY detail</h3>
      <div class="tbl-wrap">
        <table class="sortable" id="regTbl">
          <thead id="regHead"></thead>
          <tbody id="regBody"></tbody>
        </table>
      </div>
    </div>
  `;

  const btn = $('#regCatBtn'), menu = $('#regCatMenu');
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target!==btn) menu.classList.add('hidden'); });
  const selectedCats = () => Array.from(menu.querySelectorAll('input:checked')).map(i=>i.value);

  let chart;
  function draw() {
    const cats = selectedCats();
    btn.textContent = cats.length===0 ? 'All categories' : (cats.length+' selected');

    if (cats.length === 0) {
      $('#regFilterNote').textContent = 'NB-campaign YoY · all categories';
      $('#regTblTitle').textContent = 'Region YoY detail';
      const rows = (DATA.brand_regions && DATA.brand_regions[brand]) || [];
      $('#regHead').innerHTML = `<tr>
        <th>Region</th>
        <th class="num">Mar 2025 Spend</th><th class="num">Mar 2026 Spend</th><th class="num">Chg</th>
        <th class="num">Mar 2025 Conv</th><th class="num">Mar 2026 Conv</th><th class="num">Chg</th>
        <th class="num">Mar 2025 CPA</th><th class="num">Mar 2026 CPA</th><th class="num">Chg</th>
      </tr>`;
      const chgCls = c => c==null?'':(c>=0?'up':'dn'); const invCls = c => c==null?'':(c<=0?'up':'dn');
      $('#regBody').innerHTML = rows.map(r=>{
        const reg = r.region||r.Region;
        const s25=r.spend_25??r['Mar 2025 Spend']; const s26=r.spend_26??r['Mar 2026 Spend']; const sC=r.spend_chg??r['Chg'];
        const c25=r.conv_25??r['Mar 2025 Conv']; const c26=r.conv_26??r['Mar 2026 Conv']; const cC=r.conv_chg??r['Chg_Conv'];
        const p25=r.cpa_25??r['Mar 2025 CPA']; const p26=r.cpa_26??r['Mar 2026 CPA']; const pC=r.cpa_chg??r['Chg_CPA'];
        return `<tr>
          <td class="strong">${reg}</td>
          <td class="num">${fmt.money(s25)}</td>
          <td class="num">${fmt.money(s26)}</td>
          <td class="num chg ${chgCls(sC)}" data-sort="${sC}">${fmt.chg(sC)}</td>
          <td class="num">${fmt.num(c25)}</td>
          <td class="num">${fmt.num(c26)}</td>
          <td class="num chg ${chgCls(cC)}" data-sort="${cC}">${fmt.chg(cC)}</td>
          <td class="num">${fmt.money(p25,2)}</td>
          <td class="num">${fmt.money(p26,2)}</td>
          <td class="num chg ${invCls(pC)}" data-sort="${pC}">${fmt.chg(pC)}</td>
        </tr>`;
      }).join('');
      // Exclude the per-brand "* TOTAL" row from the chart — it's a total, not a region.
      const isTotalRegion = r => /\bTOTAL\b/i.test(String(r.region||r.Region||''));
      const sorted = [...rows]
        .filter(r => !isTotalRegion(r))
        .filter(r=>(r.spend_26 ?? r['Mar 2026 Spend']))
        .sort((a,b)=>((b.spend_26??b['Mar 2026 Spend'])||0)-((a.spend_26??a['Mar 2026 Spend'])||0))
        .slice(0,15);
      if (chart) chart.destroy();
      chart = new Chart(document.getElementById('regChart'), {
        type:'bar',
        data:{ labels: sorted.map(r=>r.region||r.Region), datasets:[
          { label:'Mar 2025 Spend', data: sorted.map(r=>r.spend_25??r['Mar 2025 Spend']), backgroundColor:'#9CA3AF', borderRadius:4 },
          { label:'Mar 2026 Spend', data: sorted.map(r=>r.spend_26??r['Mar 2026 Spend']), backgroundColor:'#CFFF04', borderColor:'#1A1A1A', borderWidth:1, borderRadius:4 },
        ]},
        options: chartOpts({ moneyAxis:true })
      });
    } else {
      $('#regFilterNote').textContent = 'Category filter active · Mar 2026 aggregate (YoY not available with category breakdown)';
      $('#regTblTitle').textContent = 'Region detail (filtered)';
      const brc = (DATA.brand_region_category || {})[brand] || {};
      const rows = [];
      for (const region in brc) {
        const cats_ = brc[region];
        let cost=0, clicks=0, conv=0, impr=0;
        let matched = false;
        for (const c of cats) {
          if (cats_[c]) {
            matched = true;
            cost += cats_[c].cost||0;
            clicks += cats_[c].clicks||0;
            conv += cats_[c].conv||0;
            impr += cats_[c].impr||0;
          }
        }
        if (matched) rows.push({
          region, cost, clicks, impr, conv,
          cvr: clicks? conv/clicks : 0,
          cpa: conv? cost/conv : 0,
        });
      }
      rows.sort((a,b)=>b.cost-a.cost);
      $('#regHead').innerHTML = `<tr>
        <th>Region</th>
        <th class="num">Mar 2026 Spend</th><th class="num">Clicks</th><th class="num">Impr</th>
        <th class="num">Conv</th><th class="num">CVR</th><th class="num">CPA</th>
      </tr>`;
      $('#regBody').innerHTML = rows.length === 0
        ? `<tr><td colspan="7" style="padding:20px;color:var(--grey);">No data for this brand + category combination.</td></tr>`
        : rows.map(r => `<tr>
            <td class="strong">${r.region}</td>
            <td class="num">${fmt.money(r.cost)}</td>
            <td class="num">${fmt.num(r.clicks)}</td>
            <td class="num">${fmt.num(r.impr)}</td>
            <td class="num">${fmt.num(r.conv,0)}</td>
            <td class="num">${fmt.pct(r.cvr,2)}</td>
            <td class="num">${fmt.money(r.cpa,2)}</td>
          </tr>`).join('');

      const top = rows.slice(0, 15);
      if (chart) chart.destroy();
      chart = new Chart(document.getElementById('regChart'), {
        type:'bar',
        data:{ labels: top.map(r=>r.region), datasets:[
          { label:'Mar 2026 Spend', data: top.map(r=>r.cost), backgroundColor:'#CFFF04', borderColor:'#1A1A1A', borderWidth:1, borderRadius:4 },
        ]},
        options: chartOpts({ moneyAxis:true })
      });
    }
    const t = document.getElementById('regTbl');
    Array.from(t.tHead.rows[0].cells).forEach(c => { c.classList.remove('sortable','asc','desc'); c.dataset.sortBound=''; });
    makeSortable(t);
  }

  menu.addEventListener('change', draw);
  draw();
}

// ====== INTENT ======
function renderIntent(el) {
  const isAll = DATA.intent_summary || {};
  const isByBrand = DATA.intent_summary_by_brand || {};
  const is = (BRAND !== 'ALL' && isByBrand[BRAND]) ? isByBrand[BRAND] : isAll;
  const gradesAll = DATA.performance_grades || [];
  const gradesByBrand = DATA.performance_grades_by_brand || {};
  const grades = (BRAND !== 'ALL' && gradesByBrand[BRAND]) ? gradesByBrand[BRAND] : gradesAll;
  const svcsAll = DATA.service_categories || [];
  const svcsByBrand = DATA.service_categories_by_brand || {};
  const svcs = (BRAND !== 'ALL' && svcsByBrand[BRAND]) ? svcsByBrand[BRAND] : svcsAll;
  const compsAll = DATA.competitor_breakdown || [];
  const compsByBrand = DATA.competitor_breakdown_by_brand || {};
  const comps = (BRAND !== 'ALL' && compsByBrand[BRAND]) ? compsByBrand[BRAND] : compsAll;
  const pct = (a,b) => b ? (a/b*100).toFixed(1)+'%' : '—';
  el.innerHTML = `
    <div class="view-head"><div><h2>Search Term · Intent &amp; Grades${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:14px;">· ${BRAND}</span>` : ''}</h2>
      <div class="muted">${fmt.num(is.total_terms)} terms · ${fmt.money(is.total_spend)} spend${BRAND!=='ALL' ? ` · <em style="color:var(--ink);">terms where ${BRAND} was among the bidding brands (full spend attributed)</em>` : ''}</div></div></div>

    <div class="stat-grid">
      <div class="stat hl"><div class="stat-label">Relevant</div><div class="stat-value">${fmt.num(is.relevant&&is.relevant.count)}</div><div class="stat-chg up">${pct(is.relevant&&is.relevant.spend, is.total_spend)} of spend</div></div>
      <div class="stat"><div class="stat-label">Competitor</div><div class="stat-value">${fmt.num(is.competitor&&is.competitor.count)}</div><div class="stat-chg">${pct(is.competitor&&is.competitor.spend, is.total_spend)} of spend</div></div>
      <div class="stat"><div class="stat-label">Needs Review</div><div class="stat-value">${fmt.num(is.needs_review&&is.needs_review.count)}</div><div class="stat-chg">${pct(is.needs_review&&is.needs_review.spend, is.total_spend)} of spend</div></div>
      <div class="stat"><div class="stat-label">Irrelevant</div><div class="stat-value">${fmt.num(is.irrelevant&&is.irrelevant.count)}</div><div class="stat-chg dn">${pct(is.irrelevant&&is.irrelevant.spend, is.total_spend)} of spend</div></div>
    </div>

    <div class="two-col">
      <div class="panel">
        <h3>Service categories by spend${BRAND!=='ALL' ? ` · ${BRAND}` : ''}</h3>
        <canvas id="svcChart" height="220"></canvas>
      </div>
      <div class="panel">
        <h3>Performance grades · term counts</h3>
        <div class="muted" style="margin-bottom: 10px; font-size: 12.5px;">
          Grades assigned by CVR thresholds on non-brand search terms. ${BRAND!=='ALL' ? 'Same attribution as tiles above.' : ''}
        </div>
        <div class="tbl-wrap">
          <table class="sortable">
            <thead><tr>
              <th>Grade</th>
              <th class="num">Terms</th>
              <th class="num">Spend</th>
              <th class="num">% of Spend</th>
              <th class="num">Conv</th>
              <th class="num">CPA</th>
            </tr></thead>
            <tbody>${(() => { const tot = grades.reduce((s,g)=>s+(g.spend||g.Spend||0),0); return grades.map(g=>{
              const grade = g.grade||g.Grade||'';
              const terms = g.terms??g.Terms;
              const spend = g.spend??g.Spend;
              const conv  = g.conv??g.Conv??g.Conversions;
              const cpa   = g.cpa??g.CPA ?? (conv ? spend/conv : null);
              const share = tot ? spend/tot : 0;
              const letter = String(grade).trim().charAt(0);
              return `<tr>
                <td><span class="tag grade-${letter}">${grade}</span></td>
                <td class="num">${fmt.num(terms)}</td>
                <td class="num">${fmt.money(spend)}</td>
                <td class="num">${fmt.pct(share,1)}</td>
                <td class="num">${fmt.num(conv,0)}</td>
                <td class="num">${cpa==null?'—':fmt.money(cpa,2)}</td>
              </tr>`;
            }).join(''); })()}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>How grades are calculated</h3>
      <div class="muted" style="margin-bottom: 10px; font-size: 12.5px;">
        Non-brand search terms with $1+ spend are graded by conversion rate (CVR = brand-specific conversions / clicks). Brand &amp; Competitor Protection campaigns are excluded. Source: <em>Search Term &amp; Ad Copy Analysis — Methodology</em>.
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr>
            <th>Grade</th>
            <th>CVR threshold</th>
            <th>Interpretation</th>
          </tr></thead>
          <tbody>
            <tr><td><span class="tag grade-A">A — Top Performer</span></td><td class="num">≥ 40%</td><td>Converts exceptionally well. Protect and scale.</td></tr>
            <tr><td><span class="tag grade-B">B — Good</span></td><td class="num">25–40%</td><td>Solid performer — worth investing in.</td></tr>
            <tr><td><span class="tag grade-C">C — Average</span></td><td class="num">15–25%</td><td>Performing at an acceptable level.</td></tr>
            <tr><td><span class="tag grade-D">D — Below Average</span></td><td class="num">5–15%</td><td>Converting but below expectations — review keyword, ad, and LP alignment.</td></tr>
            <tr><td><span class="tag grade-F">F — Poor / No Conversions</span></td><td class="num">&lt; 5% (w/ 5+ clicks)</td><td>Traffic is not converting — investigate match quality, ad relevance, and landing page.</td></tr>
            <tr><td><span class="tag">Low Volume</span></td><td class="num">&lt; 5 clicks</td><td>Insufficient data to grade reliably.</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h3>Competitor brand breakdown${BRAND!=='ALL' ? ` · ${BRAND}` : ''}</h3>
      <div class="muted" style="margin-bottom: 10px; font-size: 12.5px;">
        Mar 2026 paid-search spend (Y-axis: competitor segment · X-axis: spend in $) on queries that target named competitor brands. Hover a bar for the segment description.
      </div>
      <canvas id="compChart" height="120"></canvas>
    </div>
  `;
  // Stable color mapping by category so the doughnut palette doesn't shuffle across brand filters
  const SVC_COLORS = {
    'Tires':'#CFFF04','Brakes':'#1A1A1A','Oil Change':'#6B7280','Alignment':'#2563eb',
    'Battery':'#059669','Inspection':'#ea580c','Suspension/Steering':'#7c3aed',
    'General Auto Service':'#dc2626','Other Maintenance':'#f59e0b',
  };
  new Chart(document.getElementById('svcChart'), {
    type:'doughnut',
    data:{ labels: svcs.map(s=>s.category||s.Category), datasets:[{
      data: svcs.map(s=>s.spend??s.Spend),
      backgroundColor: svcs.map(s => SVC_COLORS[s.category||s.Category] || '#9CA3AF'),
      borderColor:'#fff', borderWidth:2
    }]},
    options: { responsive:true, plugins:{ legend:{ position:'right', labels:{ color:'#1A1A1A', font:{ family:'Inter' } } } } }
  });
  const compSorted = [...comps].sort((a,b)=>((b.spend??b.Spend)||0)-((a.spend??a.Spend)||0));
  const compLabels = compSorted.map(c=>c.label||c.Competitor);
  const compDetails = compSorted.map(c=>c.detail||'');
  const compOpts = {
    responsive: true, maintainAspectRatio: true, indexAxis: 'y',
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor:'#1A1A1A', titleColor:'#CFFF04', bodyColor:'#fff',
        borderColor:'#CFFF04', borderWidth:1, padding:10, cornerRadius: 8,
        titleFont:{family:'Space Grotesk', weight:'700'}, bodyFont:{family:'Inter'},
        callbacks: {
          label: (ctx) => '  Spend: $' + Number(ctx.parsed.x).toLocaleString(undefined,{maximumFractionDigits:0}),
          afterLabel: (ctx) => compDetails[ctx.dataIndex] ? '  ' + compDetails[ctx.dataIndex] : ''
        }
      }
    },
    scales: {
      x: {
        title: { display: true, text: 'Mar 2026 Spend ($)', color:'#1A1A1A', font:{family:'Inter', size:12, weight:'600'} },
        ticks: { color:'#6B7280', font:{family:'Inter', size:11}, callback: v => '$'+Number(v).toLocaleString() },
        grid: { color:'rgba(229,231,235,0.6)' }
      },
      y: {
        title: { display: true, text: 'Competitor segment', color:'#1A1A1A', font:{family:'Inter', size:12, weight:'600'} },
        ticks: { color:'#6B7280', font:{family:'Inter', size:11} },
        grid: { display: false }
      }
    }
  };
  new Chart(document.getElementById('compChart'), {
    type:'bar',
    data:{ labels: compLabels, datasets:[{
      label:'Mar 2026 Spend',
      data: compSorted.map(c=>c.spend??c.Spend),
      backgroundColor:'#1A1A1A', borderRadius: 4
    }]},
    options: compOpts
  });
  enableSortable(el);
}

// ====== RELEVANT TERMS ======
function renderRelevantTerms(el) {
  const all = DATA.relevant_terms || [];
  const rows = BRAND==='ALL' ? all : all.filter(r => brandMatchesList(r.Brands, BRAND));

  // Keyword Status summary (portfolio-wide, from source)
  const kss = DATA.keyword_status_summary || null;
  const recStat = kss && kss.by_status.find(s => /recommend/i.test(s.status));

  // Donut: service categories by spend (reuse per-brand data from Intent tab)
  const svcsAll = DATA.service_categories || [];
  const svcsByBrand = DATA.service_categories_by_brand || {};
  const svcs = (BRAND !== 'ALL' && svcsByBrand[BRAND]) ? svcsByBrand[BRAND] : svcsAll;

  // Grades table: reuse per-brand data from Intent tab
  const gradesAll = DATA.performance_grades || [];
  const gradesByBrand = DATA.performance_grades_by_brand || {};
  const grades = (BRAND !== 'ALL' && gradesByBrand[BRAND]) ? gradesByBrand[BRAND] : gradesAll;

  // Categories present in current filtered rows (for the multiselect)
  const cats = Array.from(new Set(rows.map(r => r.Category).filter(Boolean))).sort();

  el.innerHTML = `
    <style>
      .kstat-grid { display:grid; grid-template-columns: 1.3fr 1fr 1fr 1fr 1fr; gap: 10px; margin: 0 0 14px; }
      @media (max-width: 1100px) { .kstat-grid { grid-template-columns: 1fr 1fr; } }
      .kstat { background: var(--panel); border: 1px solid var(--hairline); border-radius: 10px; padding: 12px 14px; position: relative; }
      .kstat.kstat-hl { background: var(--ink); color: #fff; border-color: var(--ink); }
      .kstat.kstat-hl .kstat-label { color: var(--lime); }
      .kstat.kstat-hl .kstat-chg   { color: rgba(255,255,255,0.75); }
      .kstat-label { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:10.5px; letter-spacing:0.08em; text-transform:uppercase; color: var(--grey); }
      .kstat-value { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:26px; margin-top: 4px; line-height:1.1; font-variant-numeric: tabular-nums;}
      .kstat-sub   { margin-top: 4px; font-size: 12px; color: var(--grey); }
      .kstat-chg   { margin-top: 2px; font-size: 11.5px; color: var(--grey); }
      .portfolio-note { display:flex; align-items:center; gap:10px; margin: -4px 0 10px 0; padding: 8px 12px; background:#FAFAF7; border-left: 3px solid var(--lime); border-radius: 4px; font-size: 12px; color: var(--grey); }
      .portfolio-tag { display:inline-block; padding: 2px 8px; background: var(--ink); color: var(--lime); font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; border-radius: 3px; }
    </style>
    <div class="view-head"><div><h2>Relevant Terms${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:14px;">· ${BRAND}</span>` : ''}</h2>
      <div class="muted">${BRAND==='ALL' ? `Top ${rows.length} Intent=Relevant terms by spend` : `${rows.length} of ${all.length} top relevant terms where ${BRAND} was bidding`}</div></div></div>

    ${kss ? `
    <div class="kstat-grid">
      <div class="kstat kstat-hl">
        <div class="kstat-label">Recommend to Add</div>
        <div class="kstat-value">${fmt.num(recStat ? recStat.count : 0)}</div>
        <div class="kstat-chg">search terms · ${fmt.money(recStat ? recStat.spend : 0)} current spend (${fmt.pct(recStat ? recStat.spend_share : 0, 1)} of total)</div>
      </div>
      ${kss.by_status.filter(s => !/recommend/i.test(s.status)).map(s => {
        const tagCls = /already/i.test(s.status) ? 'status-added'
                    : /review/i.test(s.status)   ? 'status-review'
                    : /exclud/i.test(s.status)   ? 'status-excluded'
                    : '';
        const short = /review/i.test(s.status) ? 'Review' : s.status;
        return `<div class="kstat">
          <div class="kstat-label">${short}</div>
          <div class="kstat-value">${fmt.num(s.count)}</div>
          <div class="kstat-chg">${fmt.money(s.spend)} · ${fmt.pct(s.spend_share,1)} of spend</div>
        </div>`;
      }).join('')}
    </div>
    ${BRAND !== 'ALL' ? `<div class="portfolio-note"><span class="portfolio-tag">Portfolio view</span>Keyword Status counts above are portfolio-wide across all ${fmt.num(kss.total_terms)} non-brand search terms — not filtered by brand.</div>` : ''}
    ` : ''}

    <div class="two-col">
      <div class="panel">
        <h3>Service categories by spend${BRAND!=='ALL' ? ` · ${BRAND}` : ''}</h3>
        <canvas id="relSvcChart" height="220"></canvas>
      </div>
      <div class="panel">
        <h3>Performance grades · term counts</h3>
        <div class="muted" style="margin-bottom: 10px; font-size: 12.5px;">
          Grades assigned by CVR thresholds on non-brand search terms. ${BRAND!=='ALL' ? 'Filtered to terms where '+BRAND+' was among the bidding brands (full term spend attributed).' : ''}
        </div>
        <div class="tbl-wrap">
          <table class="sortable">
            <thead><tr>
              <th>Grade</th>
              <th class="num">Terms</th>
              <th class="num">Spend</th>
              <th class="num">% of Spend</th>
              <th class="num">Conv</th>
              <th class="num">CPA</th>
            </tr></thead>
            <tbody>${(() => { const tot = grades.reduce((s,g)=>s+(g.spend||g.Spend||0),0); return grades.map(g=>{
              const grade = g.grade||g.Grade||'';
              const terms = g.terms??g.Terms;
              const spend = g.spend??g.Spend;
              const conv  = g.conv??g.Conv??g.Conversions;
              const cpa   = g.cpa??g.CPA ?? (conv ? spend/conv : null);
              const share = tot ? spend/tot : 0;
              const letter = String(grade).trim().charAt(0);
              return `<tr>
                <td><span class="tag grade-${letter}">${grade}</span></td>
                <td class="num">${fmt.num(terms)}</td>
                <td class="num">${fmt.money(spend)}</td>
                <td class="num">${fmt.pct(share,1)}</td>
                <td class="num">${fmt.num(conv,0)}</td>
                <td class="num">${cpa==null?'—':fmt.money(cpa,2)}</td>
              </tr>`;
            }).join(''); })()}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="toolbar">
      <input type="text" id="relFilter" placeholder="Filter term..." style="min-width: 240px;"/>
      <label>Category:</label>
      <div class="multi">
        <button class="multi-btn" id="relCatBtn" type="button">All categories</button>
        <div class="multi-menu hidden" id="relCatMenu">
          ${cats.map(c => `<label><input type="checkbox" value="${c}" checked/> ${c}</label>`).join('')}
        </div>
      </div>
      <span id="relCount" class="muted" style="font-size:12.5px; margin-left:auto;"></span>
      <button type="button" id="relShowAll" class="multi-btn hidden">Show all</button>
    </div>
    <div class="panel" style="padding: 0;">
      <div class="tbl-wrap">
        <table class="sortable" id="relTbl">
          <thead><tr>
            <th>Search Term</th>
            <th>Category</th>
            <th>Grade</th>
            <th>Status</th>
            <th class="num">Spend</th>
            <th class="num">Clicks</th>
            <th class="num">Conv</th>
            <th class="num">CVR</th>
            <th class="num">CPC</th>
          </tr></thead>
          <tbody>${(rows.length > ROW_CAP ? rows.slice(0, ROW_CAP) : rows).map(r => {
            const term  = r['Search Term']||'';
            const cat   = r.Category||'—';
            const grade = r.Grade||'';
            const letter = String(grade).trim().charAt(0);
            const gradeCls = 'ABCDF'.includes(letter) ? 'grade-'+letter : '';
            const cost  = r.Cost;
            const conv  = r.Conversions;
            return `<tr data-category="${cat}">
              <td class="url">${term}</td>
              <td>${cat}</td>
              <td><span class="tag ${gradeCls}">${grade||'—'}</span></td>
              <td>${statusTag(r.KeywordStatus)}</td>
              <td class="num">${fmt.money(cost)}</td>
              <td class="num">${fmt.num(r.Clicks)}</td>
              <td class="num">${fmt.num(conv,0)}</td>
              <td class="num">${fmt.pct(r.CVR,2)}</td>
              <td class="num">${fmt.money(r.CPC,2)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>
  `;

  // Service categories donut (stable color-by-name so palette doesn't shuffle across brands)
  const SVC_COLORS = {
    'Tires':'#CFFF04','Brakes':'#1A1A1A','Oil Change':'#6B7280','Alignment':'#2563eb',
    'Battery':'#059669','Inspection':'#ea580c','Suspension/Steering':'#7c3aed',
    'General Auto Service':'#dc2626','Other Maintenance':'#f59e0b',
  };
  new Chart(document.getElementById('relSvcChart'), {
    type:'doughnut',
    data:{ labels: svcs.map(s => s.category||s.Category), datasets:[{
      data: svcs.map(s => s.spend??s.Spend),
      backgroundColor: svcs.map(s => SVC_COLORS[s.category||s.Category] || '#9CA3AF'),
      borderColor:'#fff', borderWidth:2
    }]},
    options: { responsive:true, plugins:{
      legend:{ position:'right', labels:{ color:'#1A1A1A', font:{ family:'Inter', size:11 } } },
      tooltip:{
        backgroundColor:'#1A1A1A', titleColor:'#CFFF04', bodyColor:'#fff',
        borderColor:'#CFFF04', borderWidth:1, padding:10, cornerRadius: 8,
        titleFont:{family:'Space Grotesk', weight:'700'}, bodyFont:{family:'Inter'},
        callbacks: { label: (ctx) => ' ' + ctx.label + ': $' + Number(ctx.parsed).toLocaleString(undefined,{maximumFractionDigits:0}) }
      }
    } }
  });

  // Text + category filters
  const total = rows.length;
  const countEl = $('#relCount');
  const input   = $('#relFilter');
  const catBtn  = $('#relCatBtn');
  const catMenu = $('#relCatMenu');
  const showAll = $('#relShowAll');
  let expanded = false;
  catBtn.addEventListener('click', e => { e.stopPropagation(); catMenu.classList.toggle('hidden'); });
  document.addEventListener('click', e => { if (!catMenu.contains(e.target) && e.target !== catBtn) catMenu.classList.add('hidden'); });
  function renderBody() {
    const slice = expanded ? rows : rows.slice(0, ROW_CAP);
    const tb = document.querySelector('#relTbl tbody');
    tb.innerHTML = slice.map(r => {
      const term  = r['Search Term']||'';
      const cat   = r.Category||'—';
      const grade = r.Grade||'';
      const letter = String(grade).trim().charAt(0);
      const gradeCls = 'ABCDF'.includes(letter) ? 'grade-'+letter : '';
      return `<tr data-category="${cat}">
        <td class="url">${term}</td>
        <td>${cat}</td>
        <td><span class="tag ${gradeCls}">${grade||'—'}</span></td>
        <td>${statusTag(r.KeywordStatus)}</td>
        <td class="num">${fmt.money(r.Cost)}</td>
        <td class="num">${fmt.num(r.Clicks)}</td>
        <td class="num">${fmt.num(r.Conversions,0)}</td>
        <td class="num">${fmt.pct(r.CVR,2)}</td>
        <td class="num">${fmt.money(r.CPC,2)}</td>
      </tr>`;
    }).join('');
    applyFilters();
  }
  function applyFilters() {
    const q = input.value.toLowerCase();
    const picked = Array.from(catMenu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value);
    const allPicked = picked.length === cats.length;
    catBtn.textContent = allPicked ? 'All categories' : `${picked.length} of ${cats.length}`;
    catBtn.classList.toggle('has-selection', !allPicked);
    let shown = 0;
    const trs = document.querySelectorAll('#relTbl tbody tr');
    trs.forEach(tr => {
      const txt = (tr.cells[0].innerText || tr.cells[0].textContent || '').toLowerCase();
      const termOk = txt.includes(q);
      const catOk  = picked.includes(tr.dataset.category);
      const vis = termOk && catOk;
      tr.style.display = vis ? '' : 'none';
      if (vis) shown++;
    });
    if (!expanded && rows.length > ROW_CAP) {
      showAll.classList.remove('hidden');
      showAll.textContent = `Show all ${fmt.num(rows.length)}`;
      countEl.textContent = `Showing ${shown} of top ${trs.length} (${total} total)`;
    } else {
      showAll.classList.add('hidden');
      countEl.textContent = `Showing ${shown} of ${total}`;
    }
  }
  input.addEventListener('input', applyFilters);
  catMenu.addEventListener('change', applyFilters);
  showAll.addEventListener('click', () => { expanded = true; renderBody(); });
  applyFilters();

  enableSortable(el);
}

// ====== COMPETITOR TERMS ======
function renderCompetitors(el) {
  const all = DATA.competitor_terms || [];
  const rows = BRAND==='ALL' ? all : all.filter(r => brandMatchesList(r.Brands, BRAND));
  const compAll = DATA.competitor_breakdown || [];
  const compByBrand = DATA.competitor_breakdown_by_brand || {};
  const compBreak = (BRAND !== 'ALL' && compByBrand[BRAND]) ? compByBrand[BRAND] : compAll;
  const compTotSpend = compBreak.reduce((s,c) => s + (c.spend||0), 0);

  el.innerHTML = `
    <div class="view-head"><div><h2>Competitor Terms${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:14px;">· ${BRAND}</span>` : ''}</h2>
      <div class="muted">${BRAND==='ALL' ? `Top ${rows.length} search terms targeting competitor brands` : `${rows.length} of ${all.length} top terms where ${BRAND} campaigns are spending`}</div></div></div>

    <div class="two-col">
      <div class="panel">
        <h3>Competitor types by spend${BRAND!=='ALL' ? ` · ${BRAND}` : ''}</h3>
        <canvas id="compTypeChart" height="220"></canvas>
      </div>
      <div class="panel">
        <h3>Competitor type summary</h3>
        <div class="muted" style="margin-bottom: 10px; font-size: 12.5px;">
          Mar 2026 paid-search spend on competitor-intent terms by segment.
          ${BRAND!=='ALL' ? `Filtered to terms where <strong style="color:var(--ink);">${BRAND}</strong> was among the bidding brands (full term spend attributed).` : 'Portfolio-wide — each term counted once.'}
        </div>
        <div class="tbl-wrap">
          <table class="sortable" id="compTypeTbl">
            <thead><tr>
              <th>Competitor Type</th>
              <th class="num">Terms</th>
              <th class="num">Spend</th>
              <th class="num">% of Spend</th>
              <th class="num">Conv</th>
              <th class="num">CPA</th>
            </tr></thead>
            <tbody>${compBreak.map(c => {
              const share = compTotSpend ? (c.spend||0)/compTotSpend : 0;
              return `<tr>
                <td><span class="tag info">${c.label||''}</span></td>
                <td class="num">${fmt.num(c.terms)}</td>
                <td class="num">${fmt.money(c.spend)}</td>
                <td class="num">${fmt.pct(share,1)}</td>
                <td class="num">${fmt.num(c.conv,0)}</td>
                <td class="num">${c.cpa==null?'—':fmt.money(c.cpa,2)}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="toolbar">
      <input type="text" id="compFilter" placeholder="Filter term..." style="min-width: 240px;"/>
    </div>
    <div class="panel" style="padding: 0;">
      <div class="tbl-wrap">
        <table class="sortable" id="compTbl">
          <thead><tr>
            <th>Search Term</th>
            <th>Competitor</th>
            <th class="num">Spend</th>
            <th class="num">Clicks</th>
            <th class="num">Conv</th>
            <th class="num">CVR</th>
            <th class="num">CPA</th>
          </tr></thead>
          <tbody>${rows.map(r => {
            const term = r['Search Term']||r.Term||r.term||'';
            const comp = r['Competitor Type']||r.Competitor||r.competitor||'—';
            const cost = r.Cost??r.Spend;
            const conv = r.Conversions??r.Conv;
            const cpa  = (conv && cost!=null) ? cost/conv : null;
            return `<tr>
            <td class="url">${term}</td>
            <td><span class="tag info">${comp}</span></td>
            <td class="num">${fmt.money(cost)}</td>
            <td class="num">${fmt.num(r.Clicks)}</td>
            <td class="num">${fmt.num(conv,0)}</td>
            <td class="num">${fmt.pct(r.CVR,2)}</td>
            <td class="num">${fmt.money(cpa,2)}</td>
          </tr>`; }).join('')}</tbody>
        </table>
      </div>
    </div>
  `;

  // Stable color mapping by competitor segment so palette doesn't shuffle across brands
  const COMP_COLORS = {
    'Direct Tire Competitors':'#1A1A1A',
    'Service Center Competitors':'#6B7280',
    'Firestone / Goodyear':'#CFFF04',
    'Quick Lube Competitors (EOC)':'#2563eb',
    'Midas (Mavis-Owned)':'#7c3aed',
    'Big Box Auto':'#ea580c',
    'Parts Stores (DIY)':'#059669',
    'Dealership Service':'#dc2626',
  };
  new Chart(document.getElementById('compTypeChart'), {
    type:'doughnut',
    data:{ labels: compBreak.map(c => c.label), datasets:[{
      data: compBreak.map(c => c.spend),
      backgroundColor: compBreak.map(c => COMP_COLORS[c.label] || '#9CA3AF'),
      borderColor:'#fff', borderWidth:2
    }]},
    options: { responsive:true, plugins:{
      legend:{ position:'right', labels:{ color:'#1A1A1A', font:{ family:'Inter', size:11 } } },
      tooltip:{
        backgroundColor:'#1A1A1A', titleColor:'#CFFF04', bodyColor:'#fff',
        borderColor:'#CFFF04', borderWidth:1, padding:10, cornerRadius: 8,
        titleFont:{family:'Space Grotesk', weight:'700'}, bodyFont:{family:'Inter'},
        callbacks: { label: (ctx) => ' ' + ctx.label + ': $' + Number(ctx.parsed).toLocaleString(undefined,{maximumFractionDigits:0}) }
      }
    } }
  });

  const input = $('#compFilter');
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    document.querySelectorAll('#compTbl tbody tr').forEach(tr => {
      tr.style.display = tr.cells[0].innerText.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  enableSortable(el);
}

// ====== FLAGGED ======
function renderFlagged(el) {
  const all = DATA.flagged_terms || [];
  const rows = BRAND==='ALL' ? all : all.filter(r => brandMatchesList(r.Brands, BRAND));
  el.innerHTML = `
    <div class="view-head"><div><h2>Flagged / Needs Review</h2>
      <div class="muted">${BRAND==='ALL' ? `Top ${rows.length} terms flagged for review based on intent/relevance` : `${rows.length} of ${all.length} flagged terms with ${BRAND} spend`}</div></div></div>
    <div class="toolbar">
      <input type="text" id="flFilter" placeholder="Filter term..." style="min-width: 240px;"/>
    </div>
    <div class="panel" style="padding:0;">
      <div class="tbl-wrap">
        <table class="sortable" id="flTbl">
          <thead><tr>
            <th>Search Term</th>
            <th>Intent</th>
            <th>Status</th>
            <th class="num">Spend</th>
            <th class="num">Clicks</th>
            <th class="num">Conv</th>
            <th class="num">CVR</th>
            <th class="num">CPA</th>
          </tr></thead>
          <tbody>${rows.map(r=>{
            const term = r['Search Term']||r.Term||r.term||'';
            const cost = r.Cost??r.Spend;
            const conv = r.Conversions??r.Conv;
            const cpa  = (conv && cost!=null) ? cost/conv : null;
            return `<tr>
            <td class="url">${term}</td>
            <td>${intentTag(r.Intent||r.intent)}</td>
            <td>${statusTag(r.KeywordStatus)}</td>
            <td class="num">${fmt.money(cost)}</td>
            <td class="num">${fmt.num(r.Clicks)}</td>
            <td class="num">${fmt.num(conv,0)}</td>
            <td class="num">${fmt.pct(r.CVR,2)}</td>
            <td class="num">${fmt.money(cpa,2)}</td>
          </tr>`; }).join('')}</tbody>
        </table>
      </div>
    </div>
  `;
  const input = $('#flFilter');
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    document.querySelectorAll('#flTbl tbody tr').forEach(tr => {
      tr.style.display = tr.cells[0].innerText.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  enableSortable(el);
}
function intentTag(intent) {
  const cls = /competitor/i.test(intent||'') ? 'warn'
           : /irrelevant/i.test(intent||'') ? 'bad'
           : /needs/i.test(intent||'') ? 'info'
           : 'good';
  return `<span class="tag ${cls}">${intent||'—'}</span>`;
}

// Keyword Status column tag — colored badge matching the new "Keyword Status" source column
// Values seen: 'Recommend Add', 'Already Added', 'Review - Clicks No Conv', 'Excluded', null
function statusTag(status) {
  if (!status) return '<span class="tag" style="opacity:0.55;">—</span>';
  const s = String(status).toLowerCase();
  let cls, label = status;
  if (s.includes('recommend'))      { cls = 'status-recommend'; }
  else if (s.includes('already'))   { cls = 'status-added'; }
  else if (s.includes('review'))    { cls = 'status-review'; label = 'Review'; }
  else if (s.includes('exclud'))    { cls = 'status-excluded'; }
  else                              { cls = ''; }
  return `<span class="tag ${cls}" title="${_esc(status)}">${label}</span>`;
}

// ====== AD COPY (shared helpers) ======
const GRADE_ORDER = ['A — Top Performer','B — Good','C — Average','D — Below Average','F — Poor / No Conversions','Low Volume'];

// Escape for attribute/text contexts
function _esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Segment tabs (BR / NB) shared by Ad Copy + Ad↔LP Pairing tabs
function adSegmentTabsHTML() {
  const pill = (seg, label) =>
    `<button class="seg-pill${AD_SEGMENT===seg?' active':''}" data-seg="${seg}" type="button">${label}</button>`;
  return `<div class="seg-group">${pill('NB','Non-Branded')}${pill('BR','Branded')}</div>`;
}
function wireAdSegmentTabs(el, onChange) {
  el.querySelectorAll('.seg-pill').forEach(b => b.addEventListener('click', () => {
    AD_SEGMENT = b.dataset.seg;
    onChange();
  }));
}

// Filter rows by current BRAND + AD_SEGMENT (shared)
function filterAdRowsBySegBrand(rows) {
  return rows.filter(r => (BRAND==='ALL' || r.Brand===BRAND) && r.Segment===AD_SEGMENT);
}

// Pre-computed summary for (BRAND, SEGMENT)
function getAdSummary() {
  const byAll   = DATA.ad_copy_grade_summary || {};
  const byBrand = DATA.ad_copy_grade_summary_by_brand || {};
  if (BRAND !== 'ALL' && byBrand[BRAND]) return byBrand[BRAND][AD_SEGMENT] || [];
  return byAll[AD_SEGMENT] || [];
}
function getAdPairingGrid() {
  const byAll   = DATA.ad_lp_pairing_grid || {};
  const byBrand = DATA.ad_lp_pairing_grid_by_brand || {};
  if (BRAND !== 'ALL' && byBrand[BRAND]) return byBrand[BRAND][AD_SEGMENT] || {ad_grades:[],lp_grades:[],matrix:[]};
  return byAll[AD_SEGMENT] || {ad_grades:[],lp_grades:[],matrix:[]};
}

// Default cap for rendered rows (perf) — rows beyond this are kept in data but not in DOM.
// "Show all" button expands it.
const ROW_CAP = 100;
const AD_ROW_CAP = ROW_CAP; // backwards-compat alias

// Pre-compute a lowercased search string on each row (one-time; heavy).
// Call this once on the full allRows array and re-use.
function attachAdSrch(allRows) {
  for (const r of allRows) {
    if (r._srch === undefined) {
      r._srch = [r.Brand, r.Category, r.Region, r.AdGroup, r.Headline, r.Campaign]
        .filter(Boolean).join(' ').toLowerCase();
    }
  }
  return allRows;
}

function adRowHTML(r) {
  const letter = String(r.AdGrade).trim().charAt(0);
  const gradeCls = 'ABCDF'.includes(letter) ? 'grade-'+letter : '';
  return `<tr data-idx="${r.__idx}" class="ad-row" data-grade="${_esc(r.AdGrade)}">
    <td><span class="tag">${r.Brand}</span></td>
    <td>${_esc(r.Category)||'—'}</td>
    <td>${_esc(r.Region)||'—'}</td>
    <td class="url" style="max-width: 260px;">${_esc(r.AdGroup)}</td>
    <td class="url" style="max-width: 340px;"><div style="font-weight:500">${_esc(r.Headline)}</div></td>
    <td><span class="tag ${gradeCls}">${r.AdGrade||'—'}</span></td>
    <td class="num">${fmt.pct(r.CTR,2)}</td>
    <td class="num">${fmt.num(r.Impressions)}</td>
    <td class="num">${fmt.num(r.Clicks)}</td>
    <td class="num">${r.CPC==null?'—':fmt.money(r.CPC,2)}</td>
    <td class="num">${fmt.money(r.Spend)}</td>
    <td class="num">${fmt.num(r.Conversions,0)}</td>
    <td class="num">${fmt.pct(r.CVR,2)}</td>
  </tr>`;
}

// Build ad table shell (no rows — tbody filled by renderAdRowsInto)
function adListTableShellHTML(tableId) {
  return `
    <div class="panel" style="padding: 0;">
      <div class="tbl-wrap">
        <table class="sortable" id="${tableId}">
          <thead><tr>
            <th>Brand</th>
            <th>Category</th>
            <th>Region</th>
            <th>Ad Group</th>
            <th>Headline</th>
            <th>Grade</th>
            <th class="num">CTR</th>
            <th class="num">Impressions</th>
            <th class="num">Clicks</th>
            <th class="num">CPC</th>
            <th class="num">Spend</th>
            <th class="num">Conv</th>
            <th class="num">CVR</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;
}

// Render filtered rows into tbody (capped for perf)
function renderAdRowsInto(tableId, rows, cap) {
  const tb = document.querySelector('#'+tableId+' tbody');
  if (!tb) return 0;
  const n = cap == null ? AD_ROW_CAP : cap;
  const slice = n && rows.length > n ? rows.slice(0, n) : rows;
  tb.innerHTML = slice.map(adRowHTML).join('');
  return slice.length;
}

// Wire ad row click → open modal
function wireAdRowClicks(container, allRows) {
  container.querySelectorAll('.ad-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const idx = +tr.dataset.idx;
      const r = allRows.find(x => x.__idx === idx);
      if (r) openAdModal(r);
    });
  });
}

// Ad detail modal
function openAdModal(r) {
  let modal = document.getElementById('adModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'adModal';
    modal.className = 'modal-overlay hidden';
    modal.innerHTML = `<div class="modal-panel"><button class="modal-close" type="button">×</button><div class="modal-body"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    modal.querySelector('.modal-close').addEventListener('click', () => modal.classList.add('hidden'));
  }
  const body = modal.querySelector('.modal-body');
  const letter = String(r.AdGrade).trim().charAt(0);
  const gradeCls = 'ABCDF'.includes(letter) ? 'grade-'+letter : '';
  const lpLetter = String(r.LPGrade).trim().charAt(0);
  const lpCls = 'ABCDF'.includes(lpLetter) ? 'grade-'+lpLetter : '';
  const headlines = [r.H1, r.H2, r.H3].filter(Boolean);
  const descs     = [r.D1, r.D2].filter(Boolean);
  body.innerHTML = `
    <div style="padding:4px 0 12px 0; border-bottom:1px solid var(--hairline); margin-bottom:14px;">
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <span class="tag">${r.Brand}</span>
        <span class="tag">${_esc(r.Category)||'—'}</span>
        <span class="tag">${_esc(r.Region)||'—'}</span>
        <span class="tag ${gradeCls}">Ad: ${r.AdGrade}</span>
        <span class="tag ${lpCls}">LP: ${r.LPGrade}</span>
      </div>
      <div style="font-size:12px; color:var(--grey);">Campaign</div>
      <div style="font-weight:500;">${_esc(r.Campaign)||'—'}</div>
      <div style="font-size:12px; color:var(--grey); margin-top:6px;">Ad Group</div>
      <div style="font-weight:500;">${_esc(r.AdGroup)||'—'}</div>
      <div style="font-size:12px; color:var(--grey); margin-top:6px;">Final URL</div>
      <div><a href="${_esc(r.URL)}" target="_blank" rel="noopener" style="color:#2563eb; word-break:break-all;">${_esc(r.URL)||'—'}</a></div>
    </div>

    <div class="kpi-row" style="gap:10px;">
      <div class="kpi" style="padding:10px 14px;"><div class="kpi-label">Impressions</div><div class="kpi-value" style="font-size:20px;">${fmt.num(r.Impressions)}</div></div>
      <div class="kpi" style="padding:10px 14px;"><div class="kpi-label">Clicks</div><div class="kpi-value" style="font-size:20px;">${fmt.num(r.Clicks)}</div></div>
      <div class="kpi" style="padding:10px 14px;"><div class="kpi-label">CTR</div><div class="kpi-value" style="font-size:20px;">${fmt.pct(r.CTR,2)}</div></div>
      <div class="kpi" style="padding:10px 14px;"><div class="kpi-label">Spend</div><div class="kpi-value" style="font-size:20px;">${fmt.money(r.Spend)}</div></div>
      <div class="kpi" style="padding:10px 14px;"><div class="kpi-label">Conv</div><div class="kpi-value" style="font-size:20px;">${fmt.num(r.Conversions,0)}</div></div>
      <div class="kpi" style="padding:10px 14px;"><div class="kpi-label">CVR</div><div class="kpi-value" style="font-size:20px;">${fmt.pct(r.CVR,2)}</div></div>
      <div class="kpi" style="padding:10px 14px;"><div class="kpi-label">CPC</div><div class="kpi-value" style="font-size:20px;">${r.CPC==null?'—':fmt.money(r.CPC,2)}</div></div>
    </div>

    <div style="margin-top:16px; display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
      <div>
        <div style="font-size:12px; color:var(--grey); margin-bottom:6px;">Headlines (${headlines.length} shown of ${r.HeadlineCount||headlines.length} assets in Google Ads)</div>
        <ol style="padding-left:18px; margin:0;">${headlines.map(h => `<li style="margin-bottom:4px;">${_esc(h)}</li>`).join('') || '<li class="muted">—</li>'}</ol>
      </div>
      <div>
        <div style="font-size:12px; color:var(--grey); margin-bottom:6px;">Descriptions (${descs.length} shown of ${r.DescCount||descs.length} assets in Google Ads)</div>
        <ol style="padding-left:18px; margin:0;">${descs.map(h => `<li style="margin-bottom:4px;">${_esc(h)}</li>`).join('') || '<li class="muted">—</li>'}</ol>
      </div>
    </div>

    <div class="muted" style="margin-top:14px; font-size:12px; line-height:1.6;">
      <strong style="color:var(--ink)">Ad relevance</strong> (Google): ${_esc(r.AdRelevance)||'—'}<br/>
      <strong style="color:var(--ink)">LP relevance score</strong> (internal): ${_esc(r.LPRelevanceScore)||'—'}<br/>
      <em>Only H1–H3 / D1–D2 are captured in the source extract. Full ${r.HeadlineCount||'—'} headlines / ${r.DescCount||'—'} descriptions live in Google Ads.</em>
    </div>
  `;
  modal.classList.remove('hidden');
}

// Module-level row index — attached lazily, reused across renders
let _AD_ROW_INDEX = null;
function getAdRowIndex() {
  if (!_AD_ROW_INDEX) {
    _AD_ROW_INDEX = (DATA.ad_copy_rows || []).map((r,i)=>({...r, __idx:i}));
    attachAdSrch(_AD_ROW_INDEX);
  }
  return _AD_ROW_INDEX;
}

// ====== AD COPY ======
function renderAdCopy(el) {
  const allRows = getAdRowIndex();
  const rowsSegBrand = filterAdRowsBySegBrand(allRows);
  const summary = getAdSummary();

  // Categories / regions in current segment (for filter dropdowns)
  const cats = Array.from(new Set(rowsSegBrand.map(r => r.Category).filter(Boolean))).sort();
  const regs = Array.from(new Set(rowsSegBrand.map(r => r.Region).filter(Boolean))).sort();

  const brLbl = AD_SEGMENT === 'BR' ? 'Branded' : 'Non-Branded';
  const grThr = AD_SEGMENT === 'BR'
    ? 'A ≥ 30%, B 20–30%, C 12–20%, D 6–12%, F &lt; 6% with ≥ 100 impressions. Low Volume = &lt; 100 impressions.'
    : 'A ≥ 10%, B 6–10%, C 4–6%, D 2–4%, F &lt; 2% with ≥ 100 impressions. Low Volume = &lt; 100 impressions.';

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h2>Ad Copy${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:14px;">· ${BRAND}</span>` : ''} <span class="muted" style="font-weight:400;font-size:14px;">· ${brLbl}</span></h2>
        <div class="muted">Ad-level performance graded by CTR. Branded and non-branded are graded on different scales (branded CTRs are naturally much higher).</div>
      </div>
      <div>${adSegmentTabsHTML()}</div>
    </div>

    <div class="panel">
      <h3>Performance grades · ad counts · ${brLbl}${BRAND!=='ALL' ? ` · ${BRAND}` : ''}</h3>
      <div class="muted" style="margin-bottom: 10px; font-size: 12.5px;">CTR thresholds (${brLbl}): ${grThr}</div>
      <div class="tbl-wrap">
        <table class="sortable">
          <thead><tr>
            <th>Grade</th>
            <th class="num">Ads</th>
            <th class="num">Impressions</th>
            <th class="num">Clicks</th>
            <th class="num">CTR</th>
            <th class="num">Spend</th>
            <th class="num">% of Spend</th>
            <th class="num">Conv</th>
            <th class="num">CVR</th>
          </tr></thead>
          <tbody>${(() => { const tot = summary.reduce((s,g)=>s+(g.spend||0),0); return summary.map(g=>{
            const letter = String(g.grade).trim().charAt(0);
            const share = tot ? g.spend/tot : 0;
            return `<tr>
              <td><span class="tag grade-${letter}">${g.grade}</span></td>
              <td class="num">${fmt.num(g.ads)}</td>
              <td class="num">${fmt.num(g.impressions)}</td>
              <td class="num">${fmt.num(g.clicks)}</td>
              <td class="num">${g.ctr==null?'—':fmt.pct(g.ctr,2)}</td>
              <td class="num">${fmt.money(g.spend)}</td>
              <td class="num">${fmt.pct(share,1)}</td>
              <td class="num">${fmt.num(g.conv,0)}</td>
              <td class="num">${g.cvr==null?'—':fmt.pct(g.cvr,2)}</td>
            </tr>`;
          }).join(''); })()}</tbody>
        </table>
      </div>
    </div>

    <div class="toolbar">
      <input type="text" id="adFilter" placeholder="Filter ad group / headline / region..." style="min-width: 280px;"/>
      <label>Category:</label>
      <div class="multi">
        <button class="multi-btn" id="adCatBtn" type="button">All categories</button>
        <div class="multi-menu hidden" id="adCatMenu">
          ${cats.map(c => `<label><input type="checkbox" value="${_esc(c)}" checked/> ${_esc(c)}</label>`).join('')}
        </div>
      </div>
      <label>Region:</label>
      <div class="multi">
        <button class="multi-btn" id="adRegBtn" type="button">All regions</button>
        <div class="multi-menu hidden" id="adRegMenu" style="max-height: 280px; overflow:auto;">
          ${regs.map(c => `<label><input type="checkbox" value="${_esc(c)}" checked/> ${_esc(c)}</label>`).join('')}
        </div>
      </div>
      <label>Grade:</label>
      <div class="multi">
        <button class="multi-btn" id="adGradeBtn" type="button">All grades</button>
        <div class="multi-menu hidden" id="adGradeMenu">
          ${GRADE_ORDER.map(g => `<label><input type="checkbox" value="${g}" checked/> ${g}</label>`).join('')}
        </div>
      </div>
      <span id="adCount" class="muted" style="font-size:12.5px; margin-left:auto;"></span>
      <button type="button" id="adShowAll" class="multi-btn hidden">Show all</button>
    </div>
    ${adListTableShellHTML('adTbl')}
  `;

  // Wire segment tabs → re-render this view
  wireAdSegmentTabs(el, () => setView(CURRENT_VIEW));

  // Text + category + region + grade filters (data-driven, not DOM-driven)
  const countEl = $('#adCount');
  const input   = $('#adFilter');
  const showAll = $('#adShowAll');
  const menus = {
    cat:  {btn: $('#adCatBtn'),   menu: $('#adCatMenu'),   allLbl: 'All categories', n: cats.length},
    reg:  {btn: $('#adRegBtn'),   menu: $('#adRegMenu'),   allLbl: 'All regions',    n: regs.length},
    gr:   {btn: $('#adGradeBtn'), menu: $('#adGradeMenu'), allLbl: 'All grades',     n: GRADE_ORDER.length},
  };
  Object.values(menus).forEach(({btn, menu}) => {
    btn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', e => { if (!menu.contains(e.target) && e.target !== btn) menu.classList.add('hidden'); });
  });
  let expanded = false;
  function currentFiltered() {
    const q = (input.value||'').toLowerCase();
    const pickedCat = new Set(Array.from(menus.cat.menu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value));
    const pickedReg = new Set(Array.from(menus.reg.menu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value));
    const pickedGr  = new Set(Array.from(menus.gr.menu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value));
    menus.cat.btn.textContent = pickedCat.size === menus.cat.n ? menus.cat.allLbl : `${pickedCat.size} of ${menus.cat.n}`;
    menus.reg.btn.textContent = pickedReg.size === menus.reg.n ? menus.reg.allLbl : `${pickedReg.size} of ${menus.reg.n}`;
    menus.gr.btn.textContent  = pickedGr.size  === menus.gr.n  ? menus.gr.allLbl  : `${pickedGr.size} of ${menus.gr.n}`;
    menus.cat.btn.classList.toggle('has-selection', pickedCat.size !== menus.cat.n);
    menus.reg.btn.classList.toggle('has-selection', pickedReg.size !== menus.reg.n);
    menus.gr.btn.classList.toggle('has-selection',  pickedGr.size  !== menus.gr.n);
    return rowsSegBrand.filter(r =>
      (!q || r._srch.includes(q)) &&
      pickedCat.has(r.Category) &&
      pickedReg.has(r.Region) &&
      pickedGr.has(r.AdGrade)
    );
  }
  function applyFilters() {
    const filtered = currentFiltered();
    const cap = expanded ? filtered.length : AD_ROW_CAP;
    const rendered = renderAdRowsInto('adTbl', filtered, cap);
    wireAdRowClicks($('#adTbl'), allRows);
    if (filtered.length > AD_ROW_CAP && !expanded) {
      showAll.classList.remove('hidden');
      showAll.textContent = `Show all ${fmt.num(filtered.length)}`;
      countEl.textContent = `Showing top ${fmt.num(rendered)} of ${fmt.num(filtered.length)} matches (by spend)`;
    } else {
      showAll.classList.add('hidden');
      countEl.textContent = `Showing ${fmt.num(rendered)} of ${fmt.num(rowsSegBrand.length)}`;
    }
  }
  // Debounced text filter
  let tId = null;
  input.addEventListener('input', () => { clearTimeout(tId); tId = setTimeout(applyFilters, 120); });
  Object.values(menus).forEach(({menu}) => menu.addEventListener('change', applyFilters));
  showAll.addEventListener('click', () => { expanded = true; applyFilters(); });
  applyFilters();

  enableSortable(el);
}

// ====== AD ↔ LP PAIRING ======
function renderAdLpPairing(el) {
  const allRows = getAdRowIndex();
  const rowsSegBrand = filterAdRowsBySegBrand(allRows);

  const g = getAdPairingGrid();
  const adGrades = g.ad_grades || [];
  const lpGrades = g.lp_grades || [];
  const matrix   = g.matrix || [];
  const matrixSpend = g.matrix_spend || adGrades.map(() => lpGrades.map(() => 0));

  const total = matrix.flat().reduce((a,b)=>a+b,0);
  const totalSpend = matrixSpend.flat().reduce((a,b)=>a+b,0);

  // Cell interpretation (color class)
  function cellClass(adG, lpG, val) {
    if (val === 0) return 'pair-empty';
    const a = adG[0], l = lpG[0];
    if (adG === 'Low Volume' || lpG === 'Low Volume') return 'pair-lv';
    if ((a==='A' || a==='B') && (l==='D' || l==='F')) return 'pair-red';
    if ((a==='A' && (l==='A'||l==='B')) || (a==='B' && (l==='A'||l==='B'))) return 'pair-green';
    if ((a==='C' && l==='A') || (a==='C' && l==='B')) return 'pair-green';
    if ((a==='D' || a==='F') && (l==='A' || l==='B')) return 'pair-amber';
    return 'pair-neutral';
  }

  const rowTotals = matrix.map(r => r.reduce((a,b)=>a+b,0));
  const colTotals = lpGrades.map((_, ci) => matrix.reduce((s, r) => s + r[ci], 0));
  const rowSpend  = matrixSpend.map(r => r.reduce((a,b)=>a+b,0));
  const colSpend  = lpGrades.map((_, ci) => matrixSpend.reduce((s, r) => s + r[ci], 0));
  // Compact spend formatter for grid cells
  function _spendShort(v) {
    if (!v) return '$0';
    if (v >= 1e6) return '$' + (v/1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e4) return '$' + Math.round(v/1e3) + 'K';
    if (v >= 1e3) return '$' + (v/1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }

  const redTotal   = matrix.reduce((s, row, ri) => s + row.reduce((ss, v, ci) => ss + (cellClass(adGrades[ri], lpGrades[ci], v)==='pair-red' ? v : 0), 0), 0);
  const greenTotal = matrix.reduce((s, row, ri) => s + row.reduce((ss, v, ci) => ss + (cellClass(adGrades[ri], lpGrades[ci], v)==='pair-green' ? v : 0), 0), 0);
  const amberTotal = matrix.reduce((s, row, ri) => s + row.reduce((ss, v, ci) => ss + (cellClass(adGrades[ri], lpGrades[ci], v)==='pair-amber' ? v : 0), 0), 0);
  const lvTotal    = matrix.reduce((s, row, ri) => s + row.reduce((ss, v, ci) => ss + (cellClass(adGrades[ri], lpGrades[ci], v)==='pair-lv' ? v : 0), 0), 0);

  const brLbl = AD_SEGMENT === 'BR' ? 'Branded' : 'Non-Branded';
  const cats = Array.from(new Set(rowsSegBrand.map(r => r.Category).filter(Boolean))).sort();
  const regs = Array.from(new Set(rowsSegBrand.map(r => r.Region).filter(Boolean))).sort();

  // Initial "selected cell" label for ad list
  const selLabel = PAIRING_CELL
    ? `Ad ${PAIRING_CELL.ad.split(' ')[0]} × LP ${PAIRING_CELL.lp.split(' ')[0]}`
    : 'All cells';

  el.innerHTML = `
    <div class="view-head">
      <div><h2>Ad ↔ LP Pairing${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:14px;">· ${BRAND}</span>` : ''} <span class="muted" style="font-weight:400;font-size:14px;">· ${brLbl}</span></h2>
        <div class="muted">Ad performance graded by CTR × Landing-page performance graded by CVR (from ad-level conversion). Click any grid cell to filter the ad list below.</div>
      </div>
      <div>${adSegmentTabsHTML()}</div>
    </div>

    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Total ads</div><div class="kpi-value">${fmt.num(total)}</div></div>
      <div class="kpi"><div class="kpi-label">Aligned (A/B ad + A/B LP)</div><div class="kpi-value" style="color:#166534">${fmt.num(greenTotal)}</div><div class="kpi-trend">${fmt.pct(total?greenTotal/total:0,1)} of ads</div></div>
      <div class="kpi"><div class="kpi-label">Good ad · weak LP <span class="tag bad" style="margin-left:4px">FIX LP</span></div><div class="kpi-value" style="color:#991b1b">${fmt.num(redTotal)}</div><div class="kpi-trend">A/B ad CTR sent to D/F LP CVR</div></div>
      <div class="kpi"><div class="kpi-label">Weak ad · good LP <span class="tag warn" style="margin-left:4px">FIX AD</span></div><div class="kpi-value" style="color:#92400e">${fmt.num(amberTotal)}</div><div class="kpi-trend">D/F ad CTR but A/B LP CVR</div></div>
      <div class="kpi"><div class="kpi-label">Low Volume</div><div class="kpi-value" style="color:#6B7280">${fmt.num(lvTotal)}</div><div class="kpi-trend">&lt; 100 imp or &lt; 5 clicks</div></div>
    </div>

    <div class="panel">
      <h3>Pairing grid · ads by Ad-CTR grade (rows) × LP-CVR grade (cols) · ${brLbl}${BRAND!=='ALL' ? ` · ${BRAND}` : ''}</h3>
      <div class="tbl-wrap">
        <table class="pair-grid">
          <thead><tr>
            <th style="text-align:left;">Ad CTR ↓  &nbsp;  LP CVR →</th>
            ${lpGrades.map(gl => `<th class="num"><span class="tag grade-${gl[0]==='L'?'':gl[0]}">${gl}</span></th>`).join('')}
            <th class="num">Total</th>
          </tr></thead>
          <tbody>
            ${adGrades.map((adG, ri) => `<tr>
              <td><span class="tag grade-${adG[0]==='L'?'':adG[0]}">${adG}</span></td>
              ${matrix[ri].map((v, ci) => {
                const spend = matrixSpend[ri][ci];
                const cls = cellClass(adG, lpGrades[ci], v);
                const pct = total ? v/total : 0;
                const isSel = PAIRING_CELL && PAIRING_CELL.ad===adG && PAIRING_CELL.lp===lpGrades[ci];
                return `<td class="num pair-clickable ${cls}${isSel?' pair-selected':''}" data-ad-grade="${_esc(adG)}" data-lp-grade="${_esc(lpGrades[ci])}"><div class="pair-cell">
                  <div class="pair-val">${v ? fmt.num(v) + ' <span class="pair-spend">('+_spendShort(spend)+')</span>' : '·'}</div>
                  <div class="pair-pct">${v ? fmt.pct(pct,1) + ' of ads' : ''}</div>
                </div></td>`;
              }).join('')}
              <td class="num" style="font-weight:600"><div class="pair-cell"><div class="pair-val">${fmt.num(rowTotals[ri])}</div><div class="pair-pct">${_spendShort(rowSpend[ri])}</div></div></td>
            </tr>`).join('')}
            <tr style="background:#f8fafc;">
              <td style="font-weight:600">Total</td>
              ${colTotals.map((v, ci) => `<td class="num" style="font-weight:600"><div class="pair-cell"><div class="pair-val">${fmt.num(v)}</div><div class="pair-pct">${_spendShort(colSpend[ci])}</div></div></td>`).join('')}
              <td class="num" style="font-weight:700"><div class="pair-cell"><div class="pair-val">${fmt.num(total)}</div><div class="pair-pct">${_spendShort(totalSpend)}</div></div></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="muted" style="margin-top:10px;font-size:12px;line-height:1.6;">
        <strong style="color:var(--ink)">Reading the grid:</strong>
        <span class="pair-chip pair-green">Aligned</span> ad CTR and LP CVR both strong — protect these.
        <span class="pair-chip pair-red">Fix LP</span> high-CTR ad wasted on low-converting LP — biggest lever.
        <span class="pair-chip pair-amber">Fix Ad</span> LP is converting well but ad copy isn't pulling clicks — copy refresh.
        <span class="pair-chip pair-neutral">Mixed</span> mid-tier on both sides.
        <span class="pair-chip pair-lv">Low Vol</span> insufficient data (&lt;100 imp or &lt;5 clicks).
      </div>
    </div>

    <div class="toolbar" style="margin-top:16px;">
      <div style="font-weight:600;margin-right:4px;">Ad list:</div>
      <span class="tag ${PAIRING_CELL ? 'info' : ''}" id="pairSelTag">${selLabel}</span>
      <button type="button" id="pairClearBtn" class="multi-btn ${PAIRING_CELL ? '' : 'hidden'}" style="background: #fee2e2; border-color:#fecaca; color:#991b1b;">Clear cell filter</button>
      <input type="text" id="pairFilter" placeholder="Filter ad group / headline / region..." style="min-width: 260px;"/>
      <label>Category:</label>
      <div class="multi">
        <button class="multi-btn" id="pairCatBtn" type="button">All categories</button>
        <div class="multi-menu hidden" id="pairCatMenu">
          ${cats.map(c => `<label><input type="checkbox" value="${_esc(c)}" checked/> ${_esc(c)}</label>`).join('')}
        </div>
      </div>
      <label>Region:</label>
      <div class="multi">
        <button class="multi-btn" id="pairRegBtn" type="button">All regions</button>
        <div class="multi-menu hidden" id="pairRegMenu" style="max-height: 280px; overflow:auto;">
          ${regs.map(c => `<label><input type="checkbox" value="${_esc(c)}" checked/> ${_esc(c)}</label>`).join('')}
        </div>
      </div>
      <span id="pairCount" class="muted" style="font-size:12.5px; margin-left:auto;"></span>
      <button type="button" id="pairShowAll" class="multi-btn hidden">Show all</button>
    </div>
    ${adListTableShellHTML('pairTbl')}

    <div class="panel" style="margin-top:16px;">
      <h3>Methodology</h3>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 24px;" class="two-col">
        <div>
          <div style="font-weight:600;margin-bottom:6px;">Ad grade — Branded (by CTR)</div>
          <table class="sortable" style="width:100%;">
            <thead><tr><th>Grade</th><th>CTR Range</th></tr></thead>
            <tbody>
              <tr><td><span class="tag grade-A">A — Top Performer</span></td><td>≥ 30%</td></tr>
              <tr><td><span class="tag grade-B">B — Good</span></td><td>20% – 30%</td></tr>
              <tr><td><span class="tag grade-C">C — Average</span></td><td>12% – 20%</td></tr>
              <tr><td><span class="tag grade-D">D — Below Average</span></td><td>6% – 12%</td></tr>
              <tr><td><span class="tag grade-F">F — Poor</span></td><td>&lt; 6% with ≥ 100 impressions</td></tr>
              <tr><td><span class="tag">Low Volume</span></td><td>&lt; 100 impressions</td></tr>
            </tbody>
          </table>
          <div style="font-weight:600;margin:14px 0 6px 0;">Ad grade — Non-Branded (by CTR)</div>
          <table class="sortable" style="width:100%;">
            <thead><tr><th>Grade</th><th>CTR Range</th></tr></thead>
            <tbody>
              <tr><td><span class="tag grade-A">A — Top Performer</span></td><td>≥ 10%</td></tr>
              <tr><td><span class="tag grade-B">B — Good</span></td><td>6% – 10%</td></tr>
              <tr><td><span class="tag grade-C">C — Average</span></td><td>4% – 6%</td></tr>
              <tr><td><span class="tag grade-D">D — Below Average</span></td><td>2% – 4%</td></tr>
              <tr><td><span class="tag grade-F">F — Poor</span></td><td>&lt; 2% with ≥ 100 impressions</td></tr>
              <tr><td><span class="tag">Low Volume</span></td><td>&lt; 100 impressions</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <div style="font-weight:600;margin-bottom:6px;">LP grade (by ad-level CVR)</div>
          <table class="sortable" style="width:100%;">
            <thead><tr><th>Grade</th><th>CVR Range</th></tr></thead>
            <tbody>
              <tr><td><span class="tag grade-A">A — Top Performer</span></td><td>≥ 40%</td></tr>
              <tr><td><span class="tag grade-B">B — Good</span></td><td>25% – 40%</td></tr>
              <tr><td><span class="tag grade-C">C — Average</span></td><td>15% – 25%</td></tr>
              <tr><td><span class="tag grade-D">D — Below Average</span></td><td>5% – 15%</td></tr>
              <tr><td><span class="tag grade-F">F — Poor</span></td><td>&lt; 5% with ≥ 5 clicks</td></tr>
              <tr><td><span class="tag">Low Volume</span></td><td>&lt; 5 clicks</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="muted" style="margin-top:12px;font-size:12px;">
        LP performance here uses the <strong>ad's own CVR</strong> (not keyword-level URL). The <em>LP URL Mismatches</em> tab flags ad↔keyword URL divergence — which is intentional for <code>/location/</code> and <code>/tire-brands/</code> URLs where keyword-level URLs are more granular. For this pairing view we ignore that distinction and judge the LP strictly by the conversion rate the ad itself achieved.
      </div>
    </div>

    <style>
      .pair-grid { width: 100%; border-collapse: separate; border-spacing: 3px; }
      .pair-grid th, .pair-grid td { padding: 8px 6px; border-radius: 6px; vertical-align: middle; }
      .pair-grid thead th { background: #f8fafc; font-weight:600; font-size:12px; }
      .pair-cell { display:flex; flex-direction:column; align-items:flex-end; line-height:1.1; gap:1px; }
      .pair-val { font-weight: 600; font-size: 13.5px; }
      .pair-spend { font-weight: 500; font-size: 11.5px; opacity: .8; margin-left: 2px; }
      .pair-pct { font-size: 10.5px; color: inherit; opacity: .7; }
      .pair-green   { background: #dcfce7; color: #166534; }
      .pair-red     { background: #fee2e2; color: #991b1b; }
      .pair-amber   { background: #fef3c7; color: #92400e; }
      .pair-neutral { background: #f1f5f9; color: #334155; }
      .pair-lv      { background: #f8fafc; color: #94a3b8; }
      .pair-empty   { background: transparent; color: #cbd5e1; }
      .pair-chip { display:inline-block; padding: 2px 8px; border-radius: 4px; font-size:11px; font-weight:600; margin: 0 4px; }
    </style>
  `;

  // Wire segment tabs → reset cell selection + re-render
  wireAdSegmentTabs(el, () => { PAIRING_CELL = null; setView(CURRENT_VIEW); });

  // Filter state + helpers
  const countEl = $('#pairCount');
  const input   = $('#pairFilter');
  const showAll = $('#pairShowAll');
  const selTag  = $('#pairSelTag');
  const clearBtn = $('#pairClearBtn');
  const menus = {
    cat: {btn: $('#pairCatBtn'), menu: $('#pairCatMenu'), allLbl: 'All categories', n: cats.length},
    reg: {btn: $('#pairRegBtn'), menu: $('#pairRegMenu'), allLbl: 'All regions',    n: regs.length},
  };
  Object.values(menus).forEach(({btn, menu}) => {
    btn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', e => { if (!menu.contains(e.target) && e.target !== btn) menu.classList.add('hidden'); });
  });

  let expanded = false;
  function updateSelTag() {
    if (PAIRING_CELL) {
      const ad = PAIRING_CELL.ad.split(' ')[0];
      const lp = PAIRING_CELL.lp.split(' ')[0];
      selTag.textContent = `Ad ${ad} × LP ${lp}`;
      selTag.classList.add('info');
      clearBtn.classList.remove('hidden');
    } else {
      selTag.textContent = 'All cells';
      selTag.classList.remove('info');
      clearBtn.classList.add('hidden');
    }
  }
  function currentFiltered() {
    const q = (input.value||'').toLowerCase();
    const pickedCat = new Set(Array.from(menus.cat.menu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value));
    const pickedReg = new Set(Array.from(menus.reg.menu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value));
    menus.cat.btn.textContent = pickedCat.size === menus.cat.n ? menus.cat.allLbl : `${pickedCat.size} of ${menus.cat.n}`;
    menus.reg.btn.textContent = pickedReg.size === menus.reg.n ? menus.reg.allLbl : `${pickedReg.size} of ${menus.reg.n}`;
    menus.cat.btn.classList.toggle('has-selection', pickedCat.size !== menus.cat.n);
    menus.reg.btn.classList.toggle('has-selection', pickedReg.size !== menus.reg.n);
    return rowsSegBrand.filter(r =>
      (!q || r._srch.includes(q)) &&
      pickedCat.has(r.Category) &&
      pickedReg.has(r.Region) &&
      (!PAIRING_CELL || (r.AdGrade === PAIRING_CELL.ad && r.LPGrade === PAIRING_CELL.lp))
    );
  }
  function applyFilters() {
    const filtered = currentFiltered();
    const cap = expanded ? filtered.length : AD_ROW_CAP;
    const rendered = renderAdRowsInto('pairTbl', filtered, cap);
    wireAdRowClicks($('#pairTbl'), allRows);
    if (filtered.length > AD_ROW_CAP && !expanded) {
      showAll.classList.remove('hidden');
      showAll.textContent = `Show all ${fmt.num(filtered.length)}`;
      countEl.textContent = `Showing top ${fmt.num(rendered)} of ${fmt.num(filtered.length)} matches (by spend)`;
    } else {
      showAll.classList.add('hidden');
      countEl.textContent = `Showing ${fmt.num(rendered)} of ${fmt.num(rowsSegBrand.length)}`;
    }
  }

  // Wire grid cell clicks → update state + CSS, re-filter table (no full view re-render)
  el.querySelectorAll('.pair-clickable').forEach(td => {
    td.addEventListener('click', () => {
      const ad = td.dataset.adGrade, lp = td.dataset.lpGrade;
      if (PAIRING_CELL && PAIRING_CELL.ad===ad && PAIRING_CELL.lp===lp) {
        PAIRING_CELL = null;
      } else {
        PAIRING_CELL = {ad, lp};
      }
      // Update cell classes without re-rendering
      el.querySelectorAll('.pair-clickable').forEach(c => c.classList.remove('pair-selected'));
      if (PAIRING_CELL) td.classList.add('pair-selected');
      expanded = false; // reset pagination when cell changes
      updateSelTag();
      applyFilters();
    });
  });
  // Clear button
  if (clearBtn) clearBtn.addEventListener('click', () => {
    PAIRING_CELL = null;
    el.querySelectorAll('.pair-clickable').forEach(c => c.classList.remove('pair-selected'));
    expanded = false;
    updateSelTag();
    applyFilters();
  });

  // Debounced text filter
  let tId = null;
  input.addEventListener('input', () => { clearTimeout(tId); tId = setTimeout(applyFilters, 120); });
  Object.values(menus).forEach(({menu}) => menu.addEventListener('change', applyFilters));
  showAll.addEventListener('click', () => { expanded = true; applyFilters(); });

  updateSelTag();
  applyFilters();
  enableSortable(el);
}

// ====== LP PERFORMANCE ======
function renderLpPerf(el) {
  const all = DATA.landing_pages || [];
  const rows = BRAND==='ALL' ? all : all.filter(r => brandMatchesList(r.Brands, BRAND));
  el.innerHTML = `
    <div class="view-head"><div><h2>Landing Page Performance</h2>
      <div class="muted">${BRAND==='ALL' ? `Top ${rows.length} landing pages by spend · quality score` : `${rows.length} of ${all.length} LPs associated with ${BRAND}`}</div></div></div>
    <div class="toolbar">
      <input type="text" id="lpFilter" placeholder="Filter URL..." style="min-width: 260px;"/>
    </div>
    <div class="panel" style="padding:0;">
      <div class="tbl-wrap">
        <table class="sortable" id="lpTbl">
          <thead><tr>
            <th>URL</th>
            <th class="num">Cost</th>
            <th class="num">Clicks</th>
            <th class="num">Conv</th>
            <th class="num">CVR</th>
            <th class="num">CPA</th>
            <th>Score</th>
          </tr></thead>
          <tbody>${rows.map(r=>{
            const url = r['Landing Page URL']||r.URL||r.url||'';
            const cost = r.Cost??r.cost;
            const clicks = r.Clicks??r.clicks;
            const conv = r['Brand Conversions']??r.Conv??r.conv;
            const cvr = r.CVR??r.cvr;
            const cpa = r['Cost/Conv']??r.CPA??r.cpa;
            return `<tr>
              <td class="url">${url}</td>
              <td class="num">${fmt.money(cost)}</td>
              <td class="num">${fmt.num(clicks)}</td>
              <td class="num">${fmt.num(conv,0)}</td>
              <td class="num">${fmt.pct(cvr,2)}</td>
              <td class="num">${fmt.money(cpa,2)}</td>
              <td>${scoreTag(r.Score||r.score)}</td>
            </tr>`; }).join('')}</tbody>
        </table>
      </div>
    </div>
  `;
  const input = $('#lpFilter');
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    document.querySelectorAll('#lpTbl tbody tr').forEach(tr => {
      tr.style.display = tr.cells[0].innerText.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  enableSortable(el);
}
function scoreTag(s) {
  if (!s) return '<span class="tag">—</span>';
  const m = { 'Excellent':'good', 'Strong':'good', 'Average':'info', 'Below Avg':'warn', 'Poor':'bad' };
  const cls = m[s] || '';
  return `<span class="tag ${cls}">${s}</span>`;
}

// ====== LP CATEGORY GRID ======
function renderLpCategory(el) {
  const all = DATA.lp_categories || [];
  const rows = BRAND==='ALL' ? all : all.filter(r => brandMatchesList(urlToBrand(r.url), BRAND));
  const cats = DATA.lp_category_cols || [];
  const catHeaders = cats.map(c => `<th class="num">${c}</th>`).join('');

  // ---- Summary: portfolio KPIs ----
  const _num = v => typeof v === 'number' ? v : (parseFloat(v) || 0);
  const totSpend  = rows.reduce((s, r) => s + _num(r.cost), 0);
  const totClicks = rows.reduce((s, r) => s + _num(r.clicks), 0);
  const totConv   = rows.reduce((s, r) => s + _num(r.conv), 0);
  const wCvr = totClicks ? totConv / totClicks : 0;
  const avgNCats = rows.length ? rows.reduce((s, r) => s + _num(r.n_categories), 0) / rows.length : 0;

  // ---- Summary: per-category rollup ----
  // For each category column, find LPs that ran in that category, compute CVR stats + best/worst LP
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return u; } };
  const pathOf = (u) => { try { return new URL(u).pathname || '/'; } catch { return u; } };
  const catRollup = cats.map(c => {
    const entries = rows
      .map(r => ({ url: r.url, v: r.by_category && r.by_category[c], spend: _num(r.cost) }))
      .filter(e => typeof e.v === 'number');
    if (!entries.length) return null;
    entries.sort((a,b) => a.v - b.v);
    const n = entries.length;
    const min = entries[0];
    const max = entries[n-1];
    const mid = n % 2 ? entries[(n-1)/2].v : (entries[n/2-1].v + entries[n/2].v) / 2;
    const spendSum = entries.reduce((s, e) => s + e.spend, 0);
    return { cat: c, n, spend: spendSum, min, max, mid };
  }).filter(Boolean);
  // Sort rollup by # LPs desc, then spend desc so the "big" categories sit at top
  catRollup.sort((a,b) => b.n - a.n || b.spend - a.spend);

  el.innerHTML = `
    <style>
      .lp-summary-grid { display:grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 0 0 14px; }
      @media (max-width: 1100px) { .lp-summary-grid { grid-template-columns: repeat(2, 1fr); } }
      .lp-kpi { background: var(--panel); border: 1px solid var(--hairline); border-radius: 10px; padding: 12px 14px; }
      .lp-kpi .kpi-lbl { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--grey); }
      .lp-kpi .kpi-val { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 22px; margin-top: 4px; line-height:1.1; font-variant-numeric: tabular-nums; }
      .lp-kpi .kpi-sub { margin-top: 3px; font-size: 11.5px; color: var(--grey); }
      .lp-summary-table td .url-short { font-family:'JetBrains Mono', monospace; font-size: 11.5px; color: var(--grey); }
      .lp-summary-table td .url-primary { font-family:'JetBrains Mono', monospace; font-size: 12px; color: var(--ink); }
    </style>
    <div class="view-head"><div><h2>LP Category Grid</h2>
      <div class="muted">${BRAND==='ALL' ? `${rows.length} landing pages · CVR by category (heat-coded: lime = excellent, red = poor)` : `${rows.length} of ${all.length} LPs on ${BRAND} domains · CVR by category`}</div></div></div>

    <div class="lp-summary-grid">
      <div class="lp-kpi"><div class="kpi-lbl">Landing Pages</div><div class="kpi-val">${fmt.num(rows.length)}</div><div class="kpi-sub">avg ${avgNCats.toFixed(1)} categories each</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Spend</div><div class="kpi-val">${fmt.money(totSpend)}</div><div class="kpi-sub">across ${rows.length} LPs</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Clicks</div><div class="kpi-val">${fmt.num(totClicks)}</div><div class="kpi-sub">driven to LPs</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Conversions</div><div class="kpi-val">${fmt.num(totConv,0)}</div><div class="kpi-sub">total tracked conv</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Weighted CVR</div><div class="kpi-val">${fmt.pct(wCvr,2)}</div><div class="kpi-sub">conv ÷ clicks (all LPs)</div></div>
    </div>

    <div class="panel">
      <h3>Category summary${BRAND!=='ALL' ? ` · ${BRAND}` : ''} <span class="muted" style="font-weight:400;font-size:12.5px;">CVR stats across LPs running each category</span></h3>
      <div class="tbl-wrap">
        <table class="sortable lp-summary-table">
          <thead><tr>
            <th>Category</th>
            <th class="num">LPs Running</th>
            <th class="num">Spend (LPs running)</th>
            <th class="num">Min CVR</th>
            <th class="num">Median CVR</th>
            <th class="num">Max CVR</th>
            <th>Best LP</th>
            <th>Worst LP</th>
          </tr></thead>
          <tbody>${catRollup.map(r => `<tr>
            <td><strong>${r.cat}</strong></td>
            <td class="num">${fmt.num(r.n)}</td>
            <td class="num">${fmt.money(r.spend)}</td>
            <td class="num" data-sort="${r.min.v}">${heatCvrCell(r.min.v)}</td>
            <td class="num" data-sort="${r.mid}">${heatCvrCell(r.mid)}</td>
            <td class="num" data-sort="${r.max.v}">${heatCvrCell(r.max.v)}</td>
            <td><span class="url-primary">${hostOf(r.max.url)}</span><div class="url-short">${pathOf(r.max.url)}</div></td>
            <td><span class="url-primary">${hostOf(r.min.url)}</span><div class="url-short">${pathOf(r.min.url)}</div></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="toolbar">
      <input type="text" id="lcFilter" placeholder="Filter URL..." style="min-width:260px;"/>
      <span id="lcCount" class="muted" style="font-size:12.5px; margin-left:auto;"></span>
      <button type="button" id="lcShowAll" class="multi-btn hidden">Show all</button>
    </div>
    <div class="panel" style="padding:0;">
      <div class="tbl-wrap">
        <table class="sortable" id="lcTbl">
          <thead><tr>
            <th>URL</th>
            <th class="num">Cost</th>
            <th class="num">Clicks</th>
            <th class="num">Conv</th>
            <th class="num">Overall CVR</th>
            <th class="num"># Cats</th>
            ${catHeaders}
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;
  const input = $('#lcFilter');
  const countEl = $('#lcCount');
  const showAll = $('#lcShowAll');
  let expanded = false;
  function renderBody() {
    const slice = expanded ? rows : rows.slice(0, ROW_CAP);
    const tb = document.querySelector('#lcTbl tbody');
    tb.innerHTML = slice.map(r => {
      const cells = cats.map(c => {
        const v = r.by_category[c];
        if (v==null) return '<td class="num"><span class="cvr-chip cvr-na">—</span></td>';
        return `<td class="num" data-sort="${v}">${heatCvrCell(v)}</td>`;
      }).join('');
      return `<tr>
        <td class="url">${r.url}</td>
        <td class="num">${fmt.money(r.cost)}</td>
        <td class="num">${fmt.num(r.clicks)}</td>
        <td class="num">${fmt.num(r.conv,0)}</td>
        <td class="num">${fmt.pct(r.cvr,2)}</td>
        <td class="num">${fmt.num(r.n_categories)}</td>
        ${cells}
      </tr>`;
    }).join('');
    applyFilters();
  }
  function applyFilters() {
    const q = input.value.toLowerCase();
    let shown = 0;
    const trs = document.querySelectorAll('#lcTbl tbody tr');
    trs.forEach(tr => {
      const txt = (tr.cells[0].innerText || tr.cells[0].textContent || '').toLowerCase();
      const vis = txt.includes(q);
      tr.style.display = vis ? '' : 'none';
      if (vis) shown++;
    });
    if (!expanded && rows.length > ROW_CAP) {
      showAll.classList.remove('hidden');
      showAll.textContent = `Show all ${fmt.num(rows.length)}`;
      countEl.textContent = `Showing ${shown} of top ${trs.length} (${rows.length} total)`;
    } else {
      showAll.classList.add('hidden');
      countEl.textContent = q ? `Showing ${shown} of ${rows.length}` : '';
    }
  }
  input.addEventListener('input', applyFilters);
  showAll.addEventListener('click', () => { expanded = true; renderBody(); });
  renderBody();
  enableSortable(el);
}
function heatCvrCell(v) {
  const p = v*100;
  let cls;
  if (p >= 40) cls = 'cvr-hi';
  else if (p >= 25) cls = 'cvr-mh';
  else if (p >= 15) cls = 'cvr-md';
  else if (p >= 7)  cls = 'cvr-lw';
  else cls = 'cvr-vl';
  return `<span class="cvr-chip ${cls}">${fmt.pct(v,1)}</span>`;
}

// ====== LP DEVICE GRID ======
function renderLpDevice(el) {
  const all = DATA.lp_device || [];
  const rows = BRAND==='ALL' ? all : all.filter(r => brandMatchesList(urlToBrand(r.url), BRAND));

  // ---- Summary calcs ----
  const _num = v => typeof v === 'number' ? v : (parseFloat(v) || 0);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return u; } };
  const pathOf = (u) => { try { return new URL(u).pathname || '/'; } catch { return u; } };

  const totSpend  = rows.reduce((s, r) => s + _num(r.cost), 0);
  const totClicks = rows.reduce((s, r) => s + _num(r.clicks), 0);
  const totConv   = rows.reduce((s, r) => s + _num(r.conv), 0);
  const wCvr = totClicks ? totConv / totClicks : 0;

  // Per-device rollup: Mobile / Desktop / Tablet
  // We have per-LP cvr, cost, clicks for each device. Weighted CVR = sum(cvr * clicks) / sum(clicks) per device.
  const devices = [
    { key: 'mobile',  label: 'Mobile'  },
    { key: 'desktop', label: 'Desktop' },
    { key: 'tablet',  label: 'Tablet'  },
  ];
  const deviceRollup = devices.map(dev => {
    const entries = rows
      .map(r => ({
        url: r.url,
        cvr: r[dev.key+'_cvr'],
        cost: _num(r[dev.key+'_cost']),
        clicks: _num(r[dev.key+'_clicks']),
      }))
      .filter(e => typeof e.cvr === 'number' && e.clicks > 0);
    if (!entries.length) return { ...dev, n: 0 };
    const totC = entries.reduce((s, e) => s + e.cost, 0);
    const totCl= entries.reduce((s, e) => s + e.clicks, 0);
    // Weighted CVR = sum(cvr * clicks) / sum(clicks) — assumes cvr = conv/clicks per device
    const wSum = entries.reduce((s, e) => s + (e.cvr * e.clicks), 0);
    const devCvr = totCl ? wSum / totCl : 0;
    const clickShare = totClicks ? totCl / totClicks : 0;
    const spendShare = totSpend  ? totC  / totSpend  : 0;
    // Best / worst LP by CVR among entries with meaningful clicks (>=100 to avoid outliers)
    const significant = entries.filter(e => e.clicks >= 100);
    const pool = significant.length ? significant : entries;
    const sorted = pool.slice().sort((a,b) => a.cvr - b.cvr);
    return { ...dev, n: entries.length, cost: totC, clicks: totCl, cvr: devCvr, clickShare, spendShare,
             best: sorted[sorted.length-1], worst: sorted[0] };
  });

  el.innerHTML = `
    <style>
      .lp-summary-grid { display:grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 0 0 14px; }
      @media (max-width: 1100px) { .lp-summary-grid { grid-template-columns: repeat(2, 1fr); } }
      .lp-kpi { background: var(--panel); border: 1px solid var(--hairline); border-radius: 10px; padding: 12px 14px; }
      .lp-kpi .kpi-lbl { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--grey); }
      .lp-kpi .kpi-val { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 22px; margin-top: 4px; line-height:1.1; font-variant-numeric: tabular-nums; }
      .lp-kpi .kpi-sub { margin-top: 3px; font-size: 11.5px; color: var(--grey); }
      .lp-summary-table td .url-short { font-family:'JetBrains Mono', monospace; font-size: 11.5px; color: var(--grey); }
      .lp-summary-table td .url-primary { font-family:'JetBrains Mono', monospace; font-size: 12px; color: var(--ink); }
    </style>
    <div class="view-head"><div><h2>LP Device Grid</h2>
      <div class="muted">${BRAND==='ALL' ? `Top ${rows.length} landing pages · CVR by device type` : `${rows.length} of ${all.length} LPs on ${BRAND} domains · CVR by device`}</div></div></div>

    <div class="lp-summary-grid">
      <div class="lp-kpi"><div class="kpi-lbl">Landing Pages</div><div class="kpi-val">${fmt.num(rows.length)}</div><div class="kpi-sub">with device data</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Spend</div><div class="kpi-val">${fmt.money(totSpend)}</div><div class="kpi-sub">across all devices</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Clicks</div><div class="kpi-val">${fmt.num(totClicks)}</div><div class="kpi-sub">${deviceRollup[0].clickShare ? fmt.pct(deviceRollup[0].clickShare,0)+' mobile' : ''}</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Conversions</div><div class="kpi-val">${fmt.num(totConv,0)}</div><div class="kpi-sub">total tracked conv</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Weighted CVR</div><div class="kpi-val">${fmt.pct(wCvr,2)}</div><div class="kpi-sub">conv ÷ clicks (all devices)</div></div>
    </div>

    <div class="panel">
      <h3>Device summary${BRAND!=='ALL' ? ` · ${BRAND}` : ''} <span class="muted" style="font-weight:400;font-size:12.5px;">Spend &amp; CVR by device type across all LPs</span></h3>
      <div class="tbl-wrap">
        <table class="sortable lp-summary-table">
          <thead><tr>
            <th>Device</th>
            <th class="num">LPs w/ Traffic</th>
            <th class="num">Spend</th>
            <th class="num">% of Spend</th>
            <th class="num">Clicks</th>
            <th class="num">% of Clicks</th>
            <th class="num">Weighted CVR</th>
            <th>Best LP (CVR)</th>
            <th>Worst LP (CVR)</th>
          </tr></thead>
          <tbody>${deviceRollup.map(d => d.n ? `<tr>
            <td><strong>${d.label}</strong></td>
            <td class="num">${fmt.num(d.n)}</td>
            <td class="num">${fmt.money(d.cost)}</td>
            <td class="num">${fmt.pct(d.spendShare,1)}</td>
            <td class="num">${fmt.num(d.clicks)}</td>
            <td class="num">${fmt.pct(d.clickShare,1)}</td>
            <td class="num" data-sort="${d.cvr}">${heatCvrCell(d.cvr)}</td>
            <td><span class="url-primary">${hostOf(d.best.url)}</span><div class="url-short">${pathOf(d.best.url)} · ${fmt.pct(d.best.cvr,1)} · ${fmt.num(d.best.clicks)} clicks</div></td>
            <td><span class="url-primary">${hostOf(d.worst.url)}</span><div class="url-short">${pathOf(d.worst.url)} · ${fmt.pct(d.worst.cvr,1)} · ${fmt.num(d.worst.clicks)} clicks</div></td>
          </tr>` : `<tr><td><strong>${d.label}</strong></td><td colspan="8" class="muted">No data</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="toolbar">
      <input type="text" id="ldFilter" placeholder="Filter URL..." style="min-width:260px;"/>
    </div>
    <div class="panel" style="padding:0;">
      <div class="tbl-wrap">
        <table class="sortable" id="ldTbl">
          <thead><tr>
            <th>URL</th>
            <th class="num">Cost</th>
            <th class="num">Clicks</th>
            <th class="num">Conv</th>
            <th class="num">Overall CVR</th>
            <th class="num">Mobile CVR</th>
            <th class="num">Desktop CVR</th>
            <th class="num">Tablet CVR</th>
          </tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td class="url">${r.url}</td>
            <td class="num">${fmt.money(r.cost)}</td>
            <td class="num">${fmt.num(r.clicks)}</td>
            <td class="num">${fmt.num(r.conv,0)}</td>
            <td class="num">${fmt.pct(r.cvr,2)}</td>
            <td class="num" data-sort="${r.mobile_cvr==null?'':r.mobile_cvr}">${r.mobile_cvr==null?'<span class="cvr-chip cvr-na">—</span>':heatCvrCell(r.mobile_cvr)}</td>
            <td class="num" data-sort="${r.desktop_cvr==null?'':r.desktop_cvr}">${r.desktop_cvr==null?'<span class="cvr-chip cvr-na">—</span>':heatCvrCell(r.desktop_cvr)}</td>
            <td class="num" data-sort="${r.tablet_cvr==null?'':r.tablet_cvr}">${r.tablet_cvr==null?'<span class="cvr-chip cvr-na">—</span>':heatCvrCell(r.tablet_cvr)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  `;
  const input = $('#ldFilter');
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    document.querySelectorAll('#ldTbl tbody tr').forEach(tr => {
      tr.style.display = tr.cells[0].innerText.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  enableSortable(el);
}

// ====== ZIP OVERLAP GRID ======
function renderZipOverlap(el) {
  const all = DATA.zip_overlap_grid || [];
  const stateMap = DATA.zip_state_map || {};
  const rows = BRAND==='ALL' ? all : all.filter(r => {
    const bc = r.by_category || {};
    for (const c in bc) {
      const v = bc[c]; if (!v) continue;
      const brands = String(v).split('\n')[0];
      if (brandMatchesList(brands.replace(/\s+/g,''), BRAND)) return true;
    }
    return false;
  });
  // Unique states present in the (brand-filtered) rows, for the dropdown
  const statesPresent = Array.from(new Set(rows.map(r => stateMap[r.zip]).filter(Boolean))).sort();
  const cats = DATA.zip_overlap_cat_cols || [];
  const catHeaders = cats.map(c => `<th class="num">${c}</th>`).join('');

  // ---- Summary calcs ----
  // Each cell is like "MAVIS, NTB\n$2,143" — parse brand list and dollar amount
  const _parseCell = (v) => {
    if (!v) return null;
    const [brandStr, amtStr] = String(v).split('\n');
    if (!amtStr) return null;
    const amt = parseFloat(amtStr.replace(/[$,]/g, '')) || 0;
    const brands = brandStr.split(',').map(s => s.trim()).filter(Boolean);
    return { brands, amt };
  };

  // Overall KPIs
  const _num = v => typeof v === 'number' ? v : (parseFloat(v) || 0);
  const totTotalSpend   = rows.reduce((s, r) => s + _num(r.total_nb_spend), 0);
  const totOverlapSpend = rows.reduce((s, r) => s + _num(r.overlap_spend), 0);
  const overlapPct = totTotalSpend ? totOverlapSpend / totTotalSpend : 0;
  const zipsWith2plus = rows.filter(r => _num(r.n_overlap_cats) >= 2).length;
  const zipsWith3plus = rows.filter(r => _num(r.n_overlap_cats) >= 3).length;
  // Avg brands per category cell (across populated cells)
  let totalCells = 0, totalBrands = 0;
  for (const r of rows) {
    for (const c of cats) {
      const p = _parseCell(r.by_category && r.by_category[c]);
      if (!p) continue;
      totalCells++;
      totalBrands += p.brands.length;
    }
  }
  const avgBrandsPerCell = totalCells ? totalBrands / totalCells : 0;

  // Per-category rollup
  const catRollup = cats.map(c => {
    let nZips = 0, totalAmt = 0;
    const comboCount = {};
    let topZip = null, topAmt = -1;
    let maxBrands = 0;
    for (const r of rows) {
      const p = _parseCell(r.by_category && r.by_category[c]);
      if (!p) continue;
      nZips++;
      totalAmt += p.amt;
      const combo = p.brands.slice().sort().join(', ');
      comboCount[combo] = (comboCount[combo] || 0) + 1;
      if (p.amt > topAmt) { topAmt = p.amt; topZip = { zip: r.zip, state: stateMap[r.zip]||'', brands: combo, amt: p.amt }; }
      if (p.brands.length > maxBrands) maxBrands = p.brands.length;
    }
    if (!nZips) return null;
    // Most common brand combo
    const sortedCombos = Object.entries(comboCount).sort((a,b) => b[1] - a[1]);
    const topCombo = sortedCombos[0] ? { combo: sortedCombos[0][0], n: sortedCombos[0][1] } : null;
    return { cat: c, nZips, totalAmt, topCombo, topZip, maxBrands };
  }).filter(Boolean);
  catRollup.sort((a,b) => b.totalAmt - a.totalAmt);

  el.innerHTML = `
    <style>
      .lp-summary-grid { display:grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 0 0 14px; }
      @media (max-width: 1100px) { .lp-summary-grid { grid-template-columns: repeat(2, 1fr); } }
      .lp-kpi { background: var(--panel); border: 1px solid var(--hairline); border-radius: 10px; padding: 12px 14px; }
      .lp-kpi .kpi-lbl { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--grey); }
      .lp-kpi .kpi-val { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 22px; margin-top: 4px; line-height:1.1; font-variant-numeric: tabular-nums; }
      .lp-kpi .kpi-sub { margin-top: 3px; font-size: 11.5px; color: var(--grey); }
      .lp-summary-table .brand-combo { display:inline-block; padding: 2px 8px; background:#F7F7F2; border-radius: 4px; font-family:'JetBrains Mono',monospace; font-size: 11.5px; color: var(--ink); font-weight: 600; }
      .lp-summary-table .zip-id { font-family:'JetBrains Mono',monospace; font-size: 12px; color: var(--ink); font-weight: 600; }
      .lp-summary-table .zip-sub { font-size: 11px; color: var(--grey); margin-top: 1px; }
    </style>
    <div class="view-head"><div><h2>ZIP Overlap Grid</h2>
      <div class="muted">${BRAND==='ALL' ? `${rows.length} highest-overlap ZIPs · multi-brand non-brand spend within same ZIP &amp; category` : `${rows.length} of ${all.length} ZIPs where ${BRAND} is one of the overlapping brands`}</div></div></div>

    <div class="lp-summary-grid">
      <div class="lp-kpi"><div class="kpi-lbl">ZIPs / Regions</div><div class="kpi-val">${fmt.num(rows.length)}</div><div class="kpi-sub">avg ${avgBrandsPerCell.toFixed(1)} brands / cat cell</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Total NB Spend</div><div class="kpi-val">${fmt.money(totTotalSpend)}</div><div class="kpi-sub">in these ZIPs</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">Overlap Spend</div><div class="kpi-val">${fmt.money(totOverlapSpend)}</div><div class="kpi-sub">${fmt.pct(overlapPct,1)} of NB spend</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">ZIPs w/ ≥2 Overlap Cats</div><div class="kpi-val">${fmt.num(zipsWith2plus)}</div><div class="kpi-sub">${rows.length ? fmt.pct(zipsWith2plus/rows.length,0) : '—'} of ZIPs</div></div>
      <div class="lp-kpi"><div class="kpi-lbl">ZIPs w/ ≥3 Overlap Cats</div><div class="kpi-val">${fmt.num(zipsWith3plus)}</div><div class="kpi-sub">${rows.length ? fmt.pct(zipsWith3plus/rows.length,0) : '—'} of ZIPs</div></div>
    </div>

    <div class="panel">
      <h3>Category summary${BRAND!=='ALL' ? ` · ${BRAND}` : ''} <span class="muted" style="font-weight:400;font-size:12.5px;">Where brands compete in the same ZIPs, by service category</span></h3>
      <div class="tbl-wrap">
        <table class="sortable lp-summary-table">
          <thead><tr>
            <th>Category</th>
            <th class="num">Overlapping ZIPs</th>
            <th class="num">Total Overlap $</th>
            <th class="num">Max Brands in Any ZIP</th>
            <th>Most Common Brand Combo</th>
            <th>Top ZIP by Overlap $</th>
          </tr></thead>
          <tbody>${catRollup.map(r => `<tr>
            <td><strong>${r.cat}</strong></td>
            <td class="num">${fmt.num(r.nZips)}</td>
            <td class="num">${fmt.money(r.totalAmt)}</td>
            <td class="num">${r.maxBrands}</td>
            <td>${r.topCombo ? `<span class="brand-combo">${r.topCombo.combo}</span> <span class="muted" style="font-size:11px;">in ${r.topCombo.n} ZIP${r.topCombo.n===1?'':'s'}</span>` : '—'}</td>
            <td>${r.topZip ? `<span class="zip-id">${r.topZip.zip}</span>${r.topZip.state?` <span class="tag info" style="font-size:10px;">${r.topZip.state}</span>`:''}<div class="zip-sub">${r.topZip.brands} · ${fmt.money(r.topZip.amt)}</div>` : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="toolbar">
      <input type="text" id="zoFilter" placeholder="Filter ZIP / region..." style="min-width:220px;"/>
      <label style="margin-left:14px;">State:</label>
      <select id="zoState">
        <option value="">All states</option>
        ${statesPresent.map(s => `<option value="${s}">${s}</option>`).join('')}
      </select>
      <span id="zoCount" class="muted" style="margin-left:12px;"></span>
      <button type="button" id="zoShowAll" class="multi-btn hidden" style="margin-left:auto;">Show all</button>
    </div>
    <div class="panel" style="padding:0;">
      <div class="tbl-wrap">
        <table class="sortable" id="zoTbl">
          <thead><tr>
            <th>ZIP / Region</th>
            <th>State</th>
            <th class="num">Total NB Spend</th>
            <th class="num">Overlap Spend</th>
            <th class="num"># Cats</th>
            ${catHeaders}
          </tr></thead>
          <tbody>${(rows.length > ROW_CAP ? rows.slice(0, ROW_CAP) : rows).map(r=>{
            const st = stateMap[r.zip] || '';
            const cells = cats.map(c => {
              const v = r.by_category[c];
              if (v==null) return '<td class="heat heat-0">—</td>';
              const parts = String(v).split('\n');
              const brands = parts[0] || '';
              const amt = parts[1] || '';
              const nBrands = brands ? brands.split(',').length : 0;
              const cls = nBrands>=4?'heat-5':nBrands===3?'heat-4':nBrands===2?'heat-3':'heat-1';
              return `<td data-sort="${nBrands}" class="heat ${cls}">${brands}<br><strong>${amt}</strong></td>`;
            }).join('');
            return `<tr data-state="${st}">
              <td class="strong">${r.zip}</td>
              <td><span class="tag info">${st||'—'}</span></td>
              <td class="num">${fmt.money(r.total_nb_spend)}</td>
              <td class="num">${fmt.money(r.overlap_spend)}</td>
              <td class="num">${fmt.num(r.n_overlap_cats)}</td>
              ${cells}
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>
  `;
  const input = $('#zoFilter');
  const stSel = $('#zoState');
  const countEl = $('#zoCount');
  const showAll = $('#zoShowAll');
  let expanded = false;
  function renderBody() {
    const slice = expanded ? rows : rows.slice(0, ROW_CAP);
    const tb = document.querySelector('#zoTbl tbody');
    tb.innerHTML = slice.map(r => {
      const st = stateMap[r.zip] || '';
      const cells = cats.map(c => {
        const v = r.by_category[c];
        if (v==null) return '<td class="heat heat-0">—</td>';
        const parts = String(v).split('\n');
        const brands = parts[0] || '';
        const amt = parts[1] || '';
        const nBrands = brands ? brands.split(',').length : 0;
        const cls = nBrands>=4?'heat-5':nBrands===3?'heat-4':nBrands===2?'heat-3':'heat-1';
        return `<td data-sort="${nBrands}" class="heat ${cls}">${brands}<br><strong>${amt}</strong></td>`;
      }).join('');
      return `<tr data-state="${st}">
        <td class="strong">${r.zip}</td>
        <td><span class="tag info">${st||'—'}</span></td>
        <td class="num">${fmt.money(r.total_nb_spend)}</td>
        <td class="num">${fmt.money(r.overlap_spend)}</td>
        <td class="num">${fmt.num(r.n_overlap_cats)}</td>
        ${cells}
      </tr>`;
    }).join('');
    applyFilters();
  }
  function applyFilters() {
    const q = input.value.toLowerCase();
    const st = stSel.value;
    let shown = 0;
    const trs = document.querySelectorAll('#zoTbl tbody tr');
    trs.forEach(tr => {
      const txt = (tr.cells[0].innerText || tr.cells[0].textContent || '').toLowerCase();
      const matchQ  = txt.includes(q);
      const matchSt = !st || tr.dataset.state === st;
      const vis = matchQ && matchSt;
      tr.style.display = vis ? '' : 'none';
      if (vis) shown++;
    });
    if (!expanded && rows.length > ROW_CAP) {
      showAll.classList.remove('hidden');
      showAll.textContent = `Show all ${fmt.num(rows.length)}`;
      countEl.textContent = `Showing ${shown} of top ${trs.length} (${rows.length} total)`;
    } else {
      showAll.classList.add('hidden');
      countEl.textContent = (st || q) ? `Showing ${shown} of ${rows.length}` : '';
    }
  }
  input.addEventListener('input', applyFilters);
  stSel.addEventListener('change', applyFilters);
  showAll.addEventListener('click', () => { expanded = true; renderBody(); });
  applyFilters();
  enableSortable(el);
}

// ====== KEYWORD · QS OVERVIEW ======
function qsRowClass(qs) {
  const n = parseInt(String(qs).replace(/\D/g,''),10);
  if (!n) return '';
  if (n <= 3) return 'qs-poor';
  if (n <= 5) return 'qs-below';
  if (n <= 7) return 'qs-avg';
  return 'qs-strong';
}
function bucketClass(b) {
  if (/Poor/i.test(b))     return 'qs-poor';
  if (/Below/i.test(b))    return 'qs-below';
  if (/Average/i.test(b))  return 'qs-avg';
  if (/Strong/i.test(b))   return 'qs-strong';
  return '';
}

// ===== Keyword Deep Dive =====================================================
// Grid of top keywords per brand (rows) × regions (cols), cell = selected metric.
// Controls: NB/BR type toggle · Spend/Conversions ranking criteria · metric dropdown.
// Respects global BRAND filter — when BRAND != 'ALL', regions row and keyword list
// narrow to just that brand.
const KDD_METRICS = [
  { key:'spend',        label:'Spend',                fmt:'money',  dir:'low'  },
  { key:'conv',         label:'Main Conversions',     fmt:'num1',   dir:'high' },
  { key:'cpa',          label:'CPA',                  fmt:'money2', dir:'low'  },
  { key:'cpc',          label:'CPC',                  fmt:'money2', dir:'low'  },
  { key:'cvr',          label:'CVR',                  fmt:'pctfrac',dir:'high' },
  { key:'ctr',          label:'CTR',                  fmt:'pctfrac',dir:'high' },
  { key:'impressions',  label:'Impressions',          fmt:'num0',   dir:'high' },
  { key:'clicks',       label:'Clicks',               fmt:'num0',   dir:'high' },
  { key:'impr_share',   label:'Impr. Share',          fmt:'pct100', dir:'high' },
  { key:'is_lost_rank', label:'IS Lost to Rank',      fmt:'pct100', dir:'low'  },
  { key:'is_lost_bud',  label:'IS Lost to Budget',    fmt:'pct100', dir:'low'  },
  { key:'qs',           label:'Quality Score',        fmt:'qs',     dir:'high' },
  { key:'lp_exp',       label:'LP Experience',        fmt:'rating', dir:'rating' },
  { key:'ad_rel',       label:'Ad Relevance',         fmt:'rating', dir:'rating' },
  { key:'ectr',         label:'Expected CTR',         fmt:'rating', dir:'rating' },
];

function _kddFmt(fmtKey, v) {
  if (v == null || v === '') return '—';
  switch (fmtKey) {
    case 'money':    return fmt.money(v, 0);
    case 'money2':   return fmt.money(v, 2);
    case 'num0':     return fmt.num(v, 0);
    case 'num1':     return fmt.num(v, 1);
    case 'pctfrac':  return fmt.pct(v, 1);  // 0-1 fraction → %
    case 'pct100':   return Number(v).toFixed(1) + '%';  // already 0-100
    case 'qs':       return String(v);
    case 'rating':   return String(v);
    default:         return String(v);
  }
}

function _kddHeat(dir, v, min, max) {
  // Green = good, red = bad. Formula: t=0 → green(120°), t=1 → red(0°).
  // Normalize v to 0..1 inside [min,max].
  // - dir='high' (higher is better): v=max should be green, so map high→0 by inverting
  // - dir='low'  (lower is better) : v=min should be green, no inversion needed
  if (v == null || max === min) return '';
  let t = (v - min) / (max - min); // 0..1; v=max → 1, v=min → 0
  if (dir === 'high') t = 1 - t;   // high-better → max should be green (t=0)
  const hue = 120 - (t * 120);     // t=0 → 120 (green), t=1 → 0 (red)
  const light = 90 - (t * 20);
  return `background: hsl(${hue}, 62%, ${light}%);`;
}

// Compute an overall (across-regions) value for a keyword for the selected metric.
// - additive metrics → sum
// - ratio metrics (CPA/CPC/CVR/CTR) → recomputed from summed components
// - percentage metrics and QS → impression-weighted average
// - rating metrics (LP Exp / Ad Rel / Expected CTR) → mode (most common)
function _kddOverall(metricKey, kwRows) {
  const rows = kwRows || [];
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  switch (metricKey) {
    case 'spend':       return sum('spend');
    case 'conv':        return sum('conv');
    case 'impressions': return sum('impressions');
    case 'clicks':      return sum('clicks');
    case 'cpa': { const c = sum('conv');        return c > 0 ? sum('spend')  / c : null; }
    case 'cpc': { const c = sum('clicks');      return c > 0 ? sum('spend')  / c : null; }
    case 'cvr': { const c = sum('clicks');      return c > 0 ? sum('conv')   / c : null; }
    case 'ctr': { const i = sum('impressions'); return i > 0 ? sum('clicks') / i : null; }
    case 'impr_share':
    case 'is_lost_rank':
    case 'is_lost_bud':
    case 'qs': {
      let wSum = 0, vSum = 0;
      for (const r of rows) {
        const v = Number(r[metricKey]);
        const w = Number(r.impressions);
        if (!isFinite(v) || !isFinite(w) || w <= 0) continue;
        wSum += w;
        vSum += v * w;
      }
      return wSum > 0 ? vSum / wSum : null;
    }
    case 'lp_exp':
    case 'ad_rel':
    case 'ectr': {
      const counts = {};
      for (const r of rows) {
        const v = r[metricKey];
        if (!v) continue;
        counts[v] = (counts[v] || 0) + 1;
      }
      let best = null, bestN = 0;
      for (const [k, n] of Object.entries(counts)) {
        if (n > bestN) { best = k; bestN = n; }
      }
      return best;
    }
  }
  return null;
}

function renderKwDeepDive(el) {
  const dd = DATA.keyword_deep_dive || {nb_spend:[], nb_conv:[], brand_spend:[], brand_conv:[]};
  // Pick the dataset based on type + criteria
  const datasetKey = (KDD_TYPE === 'NB'
    ? (KDD_CRITERIA === 'spend' ? 'nb_spend' : 'nb_conv')
    : (KDD_CRITERIA === 'spend' ? 'brand_spend' : 'brand_conv'));
  const allRows = dd[datasetKey] || [];

  // Apply global BRAND filter
  const rows = BRAND === 'ALL' ? allRows : allRows.filter(r => r.brand === BRAND);

  // Compute keyword order: rank keywords by total of the criteria metric across regions.
  const critField = KDD_CRITERIA === 'spend' ? 'spend' : 'conv';
  const kwTotals = new Map(); // key: `${brand}||${keyword}` → {brand, keyword, total, category}
  for (const r of rows) {
    const key = `${r.brand}||${r.keyword}`;
    const e = kwTotals.get(key);
    const v = Number(r[critField]) || 0;
    if (!e) kwTotals.set(key, { brand:r.brand, keyword:r.keyword, category:r.category, total:v });
    else    e.total += v;
  }
  // Order kwTotals by brand, then by total desc within brand
  const brandsInData = Array.from(new Set(rows.map(r => r.brand)));
  const BRAND_ORDER = ['MAVIS','NTB','EOC','TK','BP'];
  brandsInData.sort((a,b) => BRAND_ORDER.indexOf(a) - BRAND_ORDER.indexOf(b));

  const keywordsByBrand = brandsInData.map(br => ({
    brand: br,
    keywords: Array.from(kwTotals.values())
      .filter(e => e.brand === br)
      .sort((a,b) => b.total - a.total)
      .slice(0, 50),  // top 50 per brand
  }));

  // Regions axis = regions that appear in the filtered rows (dynamic by BRAND).
  // Use a consistent sort — alphabetical for predictability.
  const regions = Array.from(new Set(rows.map(r => r.region))).filter(Boolean).sort();

  // Build cell lookup: {brand||keyword||region} → row
  const cellMap = new Map();
  // And a per-keyword row list for Overall aggregation
  const kwRowsMap = new Map();  // `${brand}||${keyword}` → [rows]
  for (const r of rows) {
    cellMap.set(`${r.brand}||${r.keyword}||${r.region}`, r);
    const k = `${r.brand}||${r.keyword}`;
    if (!kwRowsMap.has(k)) kwRowsMap.set(k, []);
    kwRowsMap.get(k).push(r);
  }

  // Find selected metric config
  const metric = KDD_METRICS.find(m => m.key === KDD_METRIC) || KDD_METRICS[0];

  // Compute Overall values for every visible keyword (used in column + its own heatmap range)
  const overallMap = new Map(); // `${brand}||${keyword}` → overall value
  for (const grp of keywordsByBrand) {
    for (const kw of grp.keywords) {
      const k = `${kw.brand}||${kw.keyword}`;
      overallMap.set(k, _kddOverall(metric.key, kwRowsMap.get(k) || []));
    }
  }

  // Compute min/max for numeric heatmap across all visible cells
  // — grid range and overall range are tracked separately, since aggregates are
  // typically much larger than per-region values and mixing them flattens the grid colors.
  let mMin = Infinity, mMax = -Infinity;
  let oMin = Infinity, oMax = -Infinity;
  if (metric.dir !== 'rating') {
    for (const grp of keywordsByBrand) {
      for (const kw of grp.keywords) {
        for (const rg of regions) {
          const row = cellMap.get(`${kw.brand}||${kw.keyword}||${rg}`);
          const v = row && row[metric.key];
          if (typeof v === 'number' && isFinite(v)) {
            if (v < mMin) mMin = v;
            if (v > mMax) mMax = v;
          }
        }
        const ov = overallMap.get(`${kw.brand}||${kw.keyword}`);
        if (typeof ov === 'number' && isFinite(ov)) {
          if (ov < oMin) oMin = ov;
          if (ov > oMax) oMax = ov;
        }
      }
    }
  }

  // Summary counts for subheader
  const totalKws = keywordsByBrand.reduce((s, g) => s + g.keywords.length, 0);
  const totalSpend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0);
  const totalConv  = rows.reduce((s, r) => s + (Number(r.conv)  || 0), 0);

  const typeLabel = KDD_TYPE === 'NB' ? 'Non-branded' : 'Branded';
  const critLabel = KDD_CRITERIA === 'spend' ? 'Spend' : 'Main Conversions';

  // Render cell
  const cellHTML = (kw, rg) => {
    const row = cellMap.get(`${kw.brand}||${kw.keyword}||${rg}`);
    if (!row) return `<td class="kdd-empty">·</td>`;
    const v = row[metric.key];
    if (v == null || v === '') return `<td class="kdd-empty">·</td>`;
    if (metric.dir === 'rating') {
      return `<td class="kdd-rating"><span class="tag ${ratingClass(v)}">${v}</span></td>`;
    }
    const style = (typeof v === 'number' && isFinite(v))
      ? _kddHeat(metric.dir, v, mMin, mMax)
      : '';
    return `<td class="kdd-num" style="${style}">${_kddFmt(metric.fmt, v)}</td>`;
  };

  // Render overall (keyword-level across all regions) cell
  const overallCellHTML = (kw) => {
    const v = overallMap.get(`${kw.brand}||${kw.keyword}`);
    if (v == null || v === '') return `<td class="kdd-overall-cell kdd-empty">·</td>`;
    if (metric.dir === 'rating') {
      return `<td class="kdd-overall-cell kdd-rating"><span class="tag ${ratingClass(v)}">${v}</span></td>`;
    }
    const style = (typeof v === 'number' && isFinite(v))
      ? _kddHeat(metric.dir, v, oMin, oMax)
      : '';
    return `<td class="kdd-overall-cell kdd-num" style="${style}">${_kddFmt(metric.fmt, v)}</td>`;
  };

  // Render a brand-grouped block
  const groupHTML = (grp) => {
    if (!grp.keywords.length) return '';
    const showBrandHeader = BRAND === 'ALL' && keywordsByBrand.length > 1;
    const header = showBrandHeader
      ? `<tr class="kdd-brand-row"><td colspan="${regions.length+3}">
           <div class="kdd-brand-head"><strong>${grp.brand}</strong>
             <span>Top ${grp.keywords.length} ${typeLabel.toLowerCase()} keywords by ${critLabel.toLowerCase()}</span></div>
         </td></tr>`
      : '';
    const rowsHTML = grp.keywords.map((kw, i) => {
      const cat = kw.category ? `<span class="kdd-kw-cat">${kw.category}</span>` : '';
      return `<tr>
        <td class="kdd-rank-cell">${i + 1}</td>
        <th class="kdd-kw-cell">
          <div class="kdd-kw-name">${kw.keyword}</div>
          <div class="kdd-kw-meta">${grp.brand}${cat}</div>
        </th>
        ${overallCellHTML(kw)}
        ${regions.map(rg => cellHTML(kw, rg)).join('')}
      </tr>`;
    }).join('');
    return header + rowsHTML;
  };

  // Empty state
  if (!totalKws) {
    el.innerHTML = `
      <style>${KDD_STYLE}</style>
      <div class="view-head">
        <div>
          <h2>Keyword Deep Dive${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:14px;">· ${BRAND}</span>` : ''}</h2>
          <div class="muted">Top keywords per brand × regions · pick a metric to compare</div>
        </div>
      </div>
      ${kddControlsHTML()}
      <div class="panel"><div class="muted" style="text-align:center; padding: 40px 0;">
        No keywords found for this combination of filters.
      </div></div>`;
    _kddWireControls(el);
    return;
  }

  el.innerHTML = `
    <style>${KDD_STYLE}</style>
    <div class="view-head">
      <div>
        <h2>Keyword Deep Dive${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:14px;">· ${BRAND}</span>` : ''}</h2>
        <div class="muted">Top ${typeLabel.toLowerCase()} keywords per brand (by ${critLabel.toLowerCase()}) × regions · cells show <strong>${metric.label}</strong></div>
      </div>
      <div class="view-head-stats">
        <div class="vhs-item"><div class="vhs-lbl">Keywords</div><div class="vhs-val">${fmt.num(totalKws)}</div></div>
        <div class="vhs-item"><div class="vhs-lbl">Regions</div><div class="vhs-val">${regions.length}</div></div>
        <div class="vhs-item"><div class="vhs-lbl">Spend</div><div class="vhs-val">${fmt.money(totalSpend)}</div></div>
        <div class="vhs-item"><div class="vhs-lbl">Conversions</div><div class="vhs-val">${fmt.num(totalConv,0)}</div></div>
      </div>
    </div>
    ${kddControlsHTML()}
    <div class="panel kdd-panel">
      <div class="tbl-wrap kdd-tbl-wrap">
        <table class="kdd-grid">
          <thead>
            <tr>
              <th class="kdd-rank-h">Rank</th>
              <th class="kdd-corner">Keyword</th>
              <th class="kdd-overall-h">Overall</th>
              ${regions.map(rg => `<th class="kdd-region-h">${rg}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${keywordsByBrand.map(groupHTML).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  _kddWireControls(el);

  function kddControlsHTML() {
    const typePill = (v, lbl) => `<button class="seg-pill ${KDD_TYPE===v?'active':''}" data-kdd-type="${v}">${lbl}</button>`;
    const critPill = (v, lbl) => `<button class="seg-pill ${KDD_CRITERIA===v?'active':''}" data-kdd-crit="${v}">${lbl}</button>`;
    const opt      = (m)     => `<option value="${m.key}"${m.key===KDD_METRIC?' selected':''}>${m.label}</option>`;
    return `
      <div class="panel kdd-controls">
        <div class="kdd-ctl-row">
          <div class="kdd-ctl">
            <label class="kdd-ctl-lbl">Keyword type</label>
            <div class="seg-group">${typePill('NB','Non-branded')}${typePill('BR','Branded')}</div>
          </div>
          <div class="kdd-ctl">
            <label class="kdd-ctl-lbl">Top-keyword criteria</label>
            <div class="seg-group">${critPill('spend','Spend')}${critPill('conv','Main Conversions')}</div>
          </div>
          <div class="kdd-ctl">
            <label class="kdd-ctl-lbl">Metric in grid</label>
            <select id="kddMetricSel" class="kdd-metric-sel">
              ${KDD_METRICS.map(opt).join('')}
            </select>
          </div>
        </div>
      </div>`;
  }
}

function _kddWireControls(el) {
  // Re-use setView with preserveScroll so the viewport stays put
  const reRender = () => setView('kw-deep-dive', {preserveScroll:true});
  el.querySelectorAll('[data-kdd-type]').forEach(b => b.addEventListener('click', () => {
    KDD_TYPE = b.dataset.kddType;
    reRender();
  }));
  el.querySelectorAll('[data-kdd-crit]').forEach(b => b.addEventListener('click', () => {
    KDD_CRITERIA = b.dataset.kddCrit;
    reRender();
  }));
  const sel = el.querySelector('#kddMetricSel');
  if (sel) sel.addEventListener('change', (e) => {
    KDD_METRIC = e.target.value;
    reRender();
  });
}

const KDD_STYLE = `
  .kdd-controls { padding: 14px 18px; margin-bottom: 14px; }
  .kdd-ctl-row { display:flex; flex-wrap:wrap; gap: 28px; align-items:flex-end; }
  .kdd-ctl { display:flex; flex-direction:column; gap: 6px; }
  .kdd-ctl-lbl { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--grey); }
  .kdd-metric-sel { padding: 7px 12px; border: 1px solid var(--border); background: #fff; border-radius: 6px; font-family: 'Inter', sans-serif; font-size: 13px; min-width: 220px; cursor: pointer; }
  .kdd-metric-sel:hover { border-color: var(--lime); }
  .seg-group { display:inline-flex; gap:2px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: #fff; }
  .seg-group .seg-pill { padding: 7px 14px; border: none; background: transparent; font-family: 'Inter', sans-serif; font-size: 13px; cursor: pointer; color: var(--ink); border-right: 1px solid var(--hairline); }
  .seg-group .seg-pill:last-child { border-right: none; }
  .seg-group .seg-pill.active { background: var(--ink); color: #fff; font-weight: 600; }
  .kdd-panel { padding: 0; overflow: hidden; }
  .kdd-tbl-wrap { overflow: auto; max-height: calc(100vh - 260px); }
  .kdd-grid { border-collapse: collapse; font-size: 12px; width: 100%; }
  .kdd-grid th, .kdd-grid td { padding: 6px 10px; border-right: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); vertical-align: middle; white-space: nowrap; }
  .kdd-grid thead th { position: sticky; top: 0; z-index: 3; background: #1A1A1A; color: #fff; font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left; }
  .kdd-grid .kdd-rank-h { z-index: 5; left: 0; position: sticky; min-width: 52px; width: 52px; text-align: center; }
  .kdd-grid .kdd-corner { z-index: 5; left: 52px; position: sticky; min-width: 260px; width: 260px; }
  .kdd-grid .kdd-overall-h { z-index: 5; left: 312px; position: sticky; min-width: 100px; width: 100px; text-align: center; border-right: 2px solid var(--lime); }
  .kdd-grid .kdd-region-h { min-width: 96px; text-align: center; }
  .kdd-grid tbody td.kdd-rank-cell { position: sticky; left: 0; z-index: 2; background: #fff; min-width: 52px; width: 52px; text-align: center; font-family:'Space Grotesk',sans-serif; font-weight: 700; font-size: 12px; color: var(--grey); font-variant-numeric: tabular-nums; border-right: 1px solid var(--hairline); }
  .kdd-grid tbody th.kdd-kw-cell { position: sticky; left: 52px; z-index: 2; background: #fff; border-right: 1px solid var(--hairline); text-align: left; min-width: 260px; width: 260px; max-width: 260px; }
  .kdd-grid tbody td.kdd-overall-cell { position: sticky; left: 312px; z-index: 2; background: #fff; min-width: 100px; width: 100px; border-right: 2px solid var(--lime); font-weight: 600; }
  .kdd-grid .kdd-kw-name { font-weight: 600; color: var(--ink); font-family:'JetBrains Mono',monospace; font-size: 12px; white-space: normal; line-height: 1.35; }
  .kdd-grid .kdd-kw-meta { font-size: 10.5px; color: var(--grey); margin-top: 2px; display:flex; gap: 8px; align-items:center; }
  .kdd-grid .kdd-kw-cat { padding: 1px 6px; background: #F7F7F2; border-radius: 3px; font-size: 10px; color: var(--grey); font-family:'Space Grotesk',sans-serif; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
  .kdd-grid td.kdd-num { text-align: right; font-variant-numeric: tabular-nums; font-family:'JetBrains Mono',monospace; font-size: 11.5px; }
  .kdd-grid td.kdd-rating { text-align: center; }
  .kdd-grid td.kdd-empty { text-align: center; color: #d1d5db; background: #fafafa; }
  .kdd-grid tbody tr.kdd-brand-row td { background: #111; color: #fff; padding: 9px 12px; border-right: none; position: sticky; left: 0; z-index: 2; }
  .kdd-grid tbody tr.kdd-brand-row .kdd-brand-head { display:flex; align-items:center; gap: 12px; }
  .kdd-grid tbody tr.kdd-brand-row .kdd-brand-head strong { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 14px; letter-spacing: 0.04em; color: var(--lime); }
  .kdd-grid tbody tr.kdd-brand-row .kdd-brand-head span { font-size: 11.5px; color: rgba(255,255,255,0.7); }
  .view-head-stats { display:flex; gap: 22px; align-items:center; }
  .vhs-item { display:flex; flex-direction:column; }
  .vhs-lbl { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--grey); }
  .vhs-val { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 18px; font-variant-numeric: tabular-nums; }
`;

function renderQsOverview(el) {
  const d = DATA.qs_overview || {kpis:{}, distribution:[], buckets:[]};
  const k = d.kpis || {};
  const dist = (d.distribution || []).filter(r => String(r.qs).toLowerCase() !== 'total');
  const total = (d.distribution || []).find(r => String(r.qs).toLowerCase() === 'total') || null;
  const buckets = d.buckets || [];

  el.innerHTML = `
    <style>
      tr.qs-poor   td:first-child { border-left: 3px solid #dc2626; }
      tr.qs-below  td:first-child { border-left: 3px solid #f59e0b; }
      tr.qs-avg    td:first-child { border-left: 3px solid #9CA3AF; }
      tr.qs-strong td:first-child { border-left: 3px solid #059669; }
      .qs-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:12.5px; color:var(--grey); margin-top: 6px;}
      .qs-legend span { display:inline-flex; align-items:center; gap:6px; }
      .qs-dot { display:inline-block; width:10px; height:10px; border-radius: 2px; }
    </style>
    <div class="view-head">
      <div>
        <h2>Quality Score Overview · Non-Brand Portfolio</h2>
        <div class="muted">Mar 2026 · Distribution of QS across ${fmt.num(k.nb_keywords)} non-brand keywords and the CPC differential each score carries</div>
      </div>
      <div><span class="tag lime">Avg QS ${k.avg_qs!=null?Number(k.avg_qs).toFixed(1):'—'}</span></div>
    </div>

    <div class="stat-grid">
      <div class="stat hl"><div class="stat-label">Avg Quality Score</div><div class="stat-value">${k.avg_qs!=null?Number(k.avg_qs).toFixed(1):'—'}</div><div class="stat-chg">non-brand keywords</div></div>
      <div class="stat"><div class="stat-label">NB Keywords</div><div class="stat-value">${fmt.num(k.nb_keywords)}</div><div class="stat-chg">graded in Mar 2026</div></div>
      <div class="stat"><div class="stat-label">QS ≤ 5 (Weak)</div><div class="stat-value">${fmt.pct(k.pct_qs_le5,0)}</div><div class="stat-chg dn">of portfolio</div></div>
      <div class="stat"><div class="stat-label">QS ≥ 7 (Strong)</div><div class="stat-value">${fmt.pct(k.pct_qs_ge7,0)}</div><div class="stat-chg up">of portfolio</div></div>
      <div class="stat"><div class="stat-label">Est. Monthly Savings</div><div class="stat-value">${fmt.money(k.est_savings)}</div><div class="stat-chg up">if QS ≤ 5 → QS 7</div></div>
    </div>

    ${k.savings_text ? `<div class="panel" style="margin-top: 10px;"><div class="muted" style="font-size: 13px;">${k.savings_text}</div></div>` : ''}

    <div class="two-col">
      <div class="panel">
        <h3>QS distribution — keywords &amp; spend share</h3>
        <canvas id="qsDistChart" height="220"></canvas>
        <div class="qs-legend">
          <span><span class="qs-dot" style="background:#dc2626;"></span>Poor (1–3)</span>
          <span><span class="qs-dot" style="background:#f59e0b;"></span>Below Avg (4–5)</span>
          <span><span class="qs-dot" style="background:#9CA3AF;"></span>Average (6–7)</span>
          <span><span class="qs-dot" style="background:#059669;"></span>Strong (8–10)</span>
        </div>
      </div>
      <div class="panel">
        <h3>Avg CPC &amp; CTR by QS</h3>
        <canvas id="qsCpcChart" height="220"></canvas>
        <div class="muted" style="font-size: 12.5px; margin-top: 6px;">
          Higher QS drives meaningfully lower CPC and higher CTR. CPC collapses from ~$2.40 at QS 5 to ~$1.30 at QS 9–10.
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>QS bucket summary</h3>
      <div class="tbl-wrap">
        <table class="sortable" id="qsBucketTbl">
          <thead><tr>
            <th>Bucket</th>
            <th class="num">Keywords</th>
            <th class="num">% of KWs</th>
            <th class="num">Spend</th>
            <th class="num">% of Spend</th>
            <th class="num">Avg CPC</th>
            <th class="num">CTR</th>
            <th class="num">Conv Rate</th>
            <th class="num">Avg CPA</th>
            <th class="num">Conversions</th>
          </tr></thead>
          <tbody>${buckets.map(b => `<tr class="${bucketClass(b.bucket)}">
            <td>${b.bucket}</td>
            <td class="num">${fmt.num(b.keywords)}</td>
            <td class="num">${fmt.pct(b.pct_kws,1)}</td>
            <td class="num">${fmt.money(b.spend)}</td>
            <td class="num">${fmt.pct(b.pct_spend,1)}</td>
            <td class="num">${fmt.money(b.avg_cpc,2)}</td>
            <td class="num">${fmt.pct(b.ctr,2)}</td>
            <td class="num">${fmt.pct(b.cvr,2)}</td>
            <td class="num">${fmt.money(b.cpa,2)}</td>
            <td class="num">${fmt.num(b.conversions,0)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h3>QS vs CPC detail (QS 1 – QS 10)</h3>
      <div class="tbl-wrap">
        <table class="sortable" id="qsDistTbl">
          <thead><tr>
            <th>QS</th>
            <th class="num">Keywords</th>
            <th class="num">% of Total</th>
            <th class="num">Spend</th>
            <th class="num">% of Spend</th>
            <th class="num">Clicks</th>
            <th class="num">Avg CPC</th>
            <th class="num">CTR</th>
            <th class="num">Conv Rate</th>
            <th class="num">CPA</th>
            <th class="num">Conversions</th>
          </tr></thead>
          <tbody>${dist.map(r => `<tr class="${qsRowClass(r.qs)}">
            <td><strong>${r.qs}</strong></td>
            <td class="num">${fmt.num(r.keywords)}</td>
            <td class="num">${fmt.pct(r.pct_total,2)}</td>
            <td class="num">${fmt.money(r.spend)}</td>
            <td class="num">${fmt.pct(r.pct_spend,2)}</td>
            <td class="num">${fmt.num(r.clicks)}</td>
            <td class="num">${fmt.money(r.avg_cpc,2)}</td>
            <td class="num">${fmt.pct(r.ctr,2)}</td>
            <td class="num">${fmt.pct(r.cvr,2)}</td>
            <td class="num">${fmt.money(r.cpa,2)}</td>
            <td class="num">${fmt.num(r.conversions,0)}</td>
          </tr>`).join('')}
          ${total ? `<tr style="font-weight:700; background:#F7F7F2;">
            <td>Total</td>
            <td class="num">${fmt.num(total.keywords)}</td>
            <td class="num">${fmt.pct(total.pct_total,0)}</td>
            <td class="num">${fmt.money(total.spend)}</td>
            <td class="num">${fmt.pct(total.pct_spend,0)}</td>
            <td class="num">${fmt.num(total.clicks)}</td>
            <td class="num">${fmt.money(total.avg_cpc,2)}</td>
            <td class="num">${fmt.pct(total.ctr,2)}</td>
            <td class="num">${fmt.pct(total.cvr,2)}</td>
            <td class="num">${fmt.money(total.cpa,2)}</td>
            <td class="num">${fmt.num(total.conversions,0)}</td>
          </tr>` : ''}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Distribution chart: bars = keyword count, line = % of spend
  const labelsQS = dist.map(r => r.qs);
  const barColors = dist.map(r => {
    const c = qsRowClass(r.qs);
    return c==='qs-poor' ? '#dc2626' : c==='qs-below' ? '#f59e0b' : c==='qs-avg' ? '#9CA3AF' : '#059669';
  });
  new Chart(document.getElementById('qsDistChart'), {
    data: {
      labels: labelsQS,
      datasets: [
        { type:'bar',  label:'Keywords', data: dist.map(r=>r.keywords), backgroundColor: barColors, borderRadius: 4, yAxisID:'y' },
        { type:'line', label:'% of Spend', data: dist.map(r => (r.pct_spend||0)*100), borderColor: '#1A1A1A', backgroundColor: '#1A1A1A', tension: 0.25, pointRadius: 3, yAxisID: 'y1' },
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position:'bottom', labels: { color:'#1A1A1A', font: {family:'Inter', size:11}}},
        tooltip: { backgroundColor:'#1A1A1A', titleColor:'#CFFF04', bodyColor:'#fff', borderColor:'#CFFF04', borderWidth: 1, padding: 10 }
      },
      scales: {
        y:  { beginAtZero: true, ticks:{color:'#6B7280', callback: v => v.toLocaleString()}, title:{display:true, text:'Keywords', color:'#6B7280', font:{family:'Inter', size: 11}} },
        y1: { beginAtZero: true, position:'right', grid:{drawOnChartArea:false}, ticks:{ color:'#6B7280', callback: v => v+'%'}, title:{display:true, text:'% of Spend', color:'#6B7280', font:{family:'Inter', size: 11}} }
      }
    }
  });

  // CPC + CTR chart
  new Chart(document.getElementById('qsCpcChart'), {
    data: {
      labels: labelsQS,
      datasets: [
        { type:'line', label:'Avg CPC', data: dist.map(r=>r.avg_cpc||0), borderColor:'#1A1A1A', backgroundColor:'#1A1A1A', tension: 0.25, pointRadius: 3, yAxisID: 'y' },
        { type:'line', label:'CTR',     data: dist.map(r => (r.ctr||0)*100), borderColor:'#CFFF04', backgroundColor:'#CFFF04', tension: 0.25, pointRadius: 3, yAxisID: 'y1' },
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position:'bottom', labels: { color:'#1A1A1A', font: {family:'Inter', size:11}}},
        tooltip: { backgroundColor:'#1A1A1A', titleColor:'#CFFF04', bodyColor:'#fff', borderColor:'#CFFF04', borderWidth: 1, padding: 10 }
      },
      scales: {
        y:  { beginAtZero: true, ticks:{color:'#6B7280', callback: v => '$'+v.toFixed(2)}, title:{display:true, text:'Avg CPC', color:'#6B7280', font:{family:'Inter', size:11}} },
        y1: { beginAtZero: true, position:'right', grid:{drawOnChartArea:false}, ticks:{color:'#6B7280', callback: v => v.toFixed(1)+'%'}, title:{display:true, text:'CTR', color:'#6B7280', font:{family:'Inter', size:11}} }
      }
    }
  });

  enableSortable(el);
}

// ====== KEYWORD · QS BREAKDOWN ======
function ratingClass(rating) {
  const s = String(rating||'').toLowerCase();
  if (s.includes('above')) return 'grade-A';
  if (s.includes('below')) return 'grade-D';
  if (s.includes('average')) return 'grade-C';
  return '';
}
let QS3D_METRIC = 'cpc'; // 'cpc' | 'spend' | 'qs'

function renderQsBreakdown(el) {
  const d = DATA.qs_breakdown || {components:[], opportunities_by_brand:[], keywords:[], three_component_grid:null};
  const componentsPortfolio = d.components || [];
  const componentsByBrand   = d.components_by_brand || {};
  // When a brand is selected AND we have per-brand component data, use it;
  // otherwise fall back to portfolio-wide components.
  const components = (BRAND !== 'ALL' && componentsByBrand[BRAND])
    ? componentsByBrand[BRAND].components
    : componentsPortfolio;
  const componentsBrandMeta = (BRAND !== 'ALL' && componentsByBrand[BRAND])
    ? {
        total_spend:   componentsByBrand[BRAND].total_spend,
        pct_portfolio: componentsByBrand[BRAND].pct_portfolio,
        avg_cpc:       componentsByBrand[BRAND].avg_cpc,
        wtd_avg_qs:    componentsByBrand[BRAND].wtd_avg_qs,
      }
    : null;
  const allOpps    = d.opportunities_by_brand || [];
  const allKw      = d.keywords || [];
  const grid3DPortfolio = d.three_component_grid || null;
  const grid3DByBrand   = d.three_component_grid_by_brand || {};
  // Swap in the brand-specific 3D grid when a brand is selected (and we have data for it).
  // `_brand` / `_brandMeta` fields carry summary context for the header ribbon.
  const grid3D = (BRAND !== 'ALL' && grid3DByBrand[BRAND])
    ? Object.assign({}, grid3DByBrand[BRAND], {
        _brand: BRAND,
        _brandMeta: {
          total_spend:   grid3DByBrand[BRAND].total_spend,
          pct_portfolio: grid3DByBrand[BRAND].pct_portfolio,
          avg_cpc:       grid3DByBrand[BRAND].avg_cpc,
          wtd_avg_qs:    grid3DByBrand[BRAND].wtd_avg_qs,
        },
        // Preserve the portfolio-wide key_insight narrative if the brand grid doesn't carry one.
        key_insight: grid3DByBrand[BRAND].key_insight || (grid3DPortfolio && grid3DPortfolio.key_insight) || '',
      })
    : grid3DPortfolio;

  // Apply BRAND filter to keyword list
  const rows = BRAND==='ALL' ? allKw : allKw.filter(r => r.Brand === BRAND);

  // Apply BRAND filter to opportunities table: show selected brand + Total row for context
  const opps = BRAND === 'ALL'
    ? allOpps
    : allOpps.filter(o => {
        const b = String(o.brand||'').toUpperCase();
        return b === BRAND || b === 'TOTAL';
      });

  // Note shown on portfolio-wide sections when a brand filter is active
  const portfolioNote = BRAND !== 'ALL'
    ? `<div class="portfolio-note">
         <span class="portfolio-tag">Portfolio view</span>
         Source data isn't split by brand for this section — figures are non-brand portfolio totals across all brands.
       </div>`
    : '';
  // Precompute _srch once per row for fast text filtering
  if (rows.length && !rows[0]._srch) {
    for (const r of rows) {
      r._srch = [r.Keyword, r.Brand, r.Region, r.Category, r.eCTR, r.AdRel, r.LpExp].join(' ').toLowerCase();
    }
  }

  const cats    = Array.from(new Set(rows.map(r => r.Category).filter(Boolean))).sort();
  const regions = Array.from(new Set(rows.map(r => r.Region).filter(Boolean))).sort();

  // ---- Consolidated component table (Expected CTR + Ad Relevance + LP Exp stacked) ----
  // When BRAND is filtered and we have per-brand data, uses brand-specific rows; else portfolio.
  const consolidatedCompTableHTML = () => {
    const cmpRowHTML = (r) => {
      const cpcDelta = r.cpc_vs_avg;
      const deltaColor = cpcDelta==null ? '' : (cpcDelta > 0 ? 'color:#dc2626;' : 'color:#059669;');
      const deltaTxt = cpcDelta==null ? '—' : (cpcDelta >= 0 ? '+' : '') + (cpcDelta*100).toFixed(1) + '%';
      return `<tr>
        <td><span class="tag ${ratingClass(r.rating)}">${r.rating}</span></td>
        <td class="num">${fmt.num(r.keywords)}</td>
        <td class="num">${fmt.pct(r.pct_kws,1)}</td>
        <td class="num">${fmt.money(r.spend)}</td>
        <td class="num">${fmt.money(r.avg_cpc,2)}</td>
        <td class="num">${fmt.pct(r.ctr,2)}</td>
        <td class="num">${fmt.pct(r.cvr,2)}</td>
        <td class="num">${fmt.money(r.cpa,2)}</td>
        <td class="num">${fmt.num(r.conv,0)}</td>
        <td class="num" style="${deltaColor} font-weight:600;">${deltaTxt}</td>
      </tr>`;
    };
    const titleBrand = BRAND !== 'ALL' && componentsByBrand[BRAND]
      ? `${BRAND} · ` : '';
    const titleScope = BRAND !== 'ALL' && componentsByBrand[BRAND]
      ? `<span class="muted" style="font-weight:400;font-size:12.5px;">brand-specific</span>`
      : `<span class="muted" style="font-weight:400;font-size:12.5px;">portfolio total</span>`;
    const metaRibbonHTML = componentsBrandMeta
      ? `<div class="brand-meta-ribbon">
           <div class="bm-stat"><div class="bm-lbl">Brand</div><strong>${BRAND}</strong></div>
           <div class="bm-stat"><div class="bm-lbl">Spend</div><strong>${fmt.money(componentsBrandMeta.total_spend)}</strong><div class="bm-sub">${fmt.pct(componentsBrandMeta.pct_portfolio,1)} of portfolio</div></div>
           <div class="bm-stat"><div class="bm-lbl">Avg CPC</div><strong>${fmt.money(componentsBrandMeta.avg_cpc,2)}</strong></div>
           <div class="bm-stat"><div class="bm-lbl">Wtd Avg QS</div><strong>${componentsBrandMeta.wtd_avg_qs?.toFixed(1) ?? '—'}</strong></div>
         </div>`
      : '';
    const sectionHTML = (comp, idx) => `
      <tr class="comp-section-row">
        <td colspan="10"><div class="comp-section-head"><span class="comp-section-num">${idx+1}</span><strong>${comp.name}</strong></div></td>
      </tr>
      ${comp.rows.map(cmpRowHTML).join('')}
    `;
    return `
      <div class="panel">
        <h3>Quality Score Component Analysis <span class="muted" style="font-weight:400;font-size:12.5px;">· ${titleBrand}</span>${titleScope}</h3>
        <div class="muted" style="margin-bottom:10px;">
          All three Quality Score components stacked in one table. Each component breaks keywords into Above / Average / Below average ratings with performance context.
        </div>
        ${metaRibbonHTML}
        <div class="tbl-wrap">
          <table class="sortable qs-components-unified">
            <thead><tr>
              <th>Rating</th>
              <th class="num">Keywords</th>
              <th class="num">% of KWs</th>
              <th class="num">Spend</th>
              <th class="num">Avg CPC</th>
              <th class="num">CTR</th>
              <th class="num">Conv Rate</th>
              <th class="num">CPA</th>
              <th class="num">Conversions</th>
              <th class="num">CPC vs Avg</th>
            </tr></thead>
            <tbody>${components.map((c, i) => sectionHTML(c, i)).join('')}</tbody>
          </table>
        </div>
      </div>`;
  };

  // --- 3D component grid: 3 sub-grids (one per eCTR slice), 3×3 LP × Ad Rel ---
  // Color mapping: cpc → red high / green low | spend → red big spend / green small | qs → green high / red low.
  const _gridMin = (key) => {
    if (!grid3D) return 0;
    let m = Infinity;
    for (const s of grid3D.slices) for (const row of s[key+'_grid']) for (const v of row) if (v != null && v < m) m = v;
    return m === Infinity ? 0 : m;
  };
  const _gridMax = (key) => {
    if (!grid3D) return 1;
    let m = -Infinity;
    for (const s of grid3D.slices) for (const row of s[key+'_grid']) for (const v of row) if (v != null && v > m) m = v;
    return m === -Infinity ? 1 : m;
  };
  function cellColor(metric, v) {
    if (v == null) return '#f3f4f6';
    const key = metric === 'cpc' ? 'cpc' : metric === 'spend' ? 'spend' : 'qs';
    const min = _gridMin(key), max = _gridMax(key);
    if (max === min) return '#fefce8';
    let t = (v - min) / (max - min); // 0..1
    // For CPC and Spend higher=worse → red. For QS higher=better → green.
    if (metric === 'qs') t = 1 - t; // invert so high QS becomes "low t" (green)
    // t=0 → green (good), t=1 → red (bad). Yellow midway.
    // Use HSL: 120° (green) → 60° (yellow) → 0° (red)
    const hue = 120 - (t * 120);
    const light = 88 - (t * 18); // gentle gradient 88% → 70%
    return `hsl(${hue}, 65%, ${light}%)`;
  }
  function cellText(metric, v) {
    if (v == null) return '—';
    if (metric === 'cpc')   return '$'+Number(v).toFixed(2);
    if (metric === 'spend') {
      if (v >= 1e6) return '$'+(v/1e6).toFixed(1)+'M';
      if (v >= 1e3) return '$'+(v/1e3).toFixed(0)+'K';
      return '$'+Math.round(v);
    }
    return String(v); // qs
  }
  // Build flat list of all cells for unified rendering: 3 eCTR × 3 LP × 3 Ad = 27 cells
  // Rendered as 9 rows (3 eCTR groups × 3 LP rows), 3 Ad Rel columns; eCTR cell uses rowspan=3.
  const ectrRowClass = ratingClass; // reuse: above→A, below→D, average→C

  function unifiedGridHTML(metric) {
    if (!grid3D) return '';
    return `<table class="qs3d-table">
      <thead>
        <tr>
          <th rowspan="2" class="corner-ectr">Expected CTR</th>
          <th rowspan="2" class="corner-lp">LP Experience</th>
          <th colspan="3" class="corner-ad">Ad Relevance →</th>
        </tr>
        <tr>
          ${grid3D.ad_levels.map(a => `<th class="ad-h"><span class="tag ${ratingClass(a)}">${a}</span></th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${grid3D.slices.map(slice => {
          const grid = slice[metric+'_grid'];
          const ectrCls = ectrRowClass(slice.ectr);
          return grid3D.lp_levels.map((lp, i) => {
            const isFirst = i === 0;
            const ectrCell = isFirst
              ? `<td rowspan="3" class="ectr-cell ${ectrCls}">
                   <div class="ectr-name">${slice.ectr}</div>
                   ${slice.pct_spend!=null ? `<div class="ectr-pct">${(slice.pct_spend*100).toFixed(1)}% of spend</div>` : ''}
                 </td>`
              : '';
            const cells = grid[i].map(v => `<td class="metric-cell" style="background:${cellColor(metric, v)};">${cellText(metric, v)}</td>`).join('');
            return `<tr class="${isFirst?'group-first':''}">${ectrCell}<td class="lp-cell"><span class="tag ${ratingClass(lp)}">${lp}</span></td>${cells}</tr>`;
          }).join('');
        }).join('')}
      </tbody>
    </table>`;
  }

  // Build the brand meta ribbon (shown above the grid when a brand is active AND we have brand-specific data)
  const bm = grid3D && grid3D._brandMeta;
  const brandMetaRibbon = (grid3D && grid3D._brand && bm) ? `
    <div class="brand-meta-ribbon">
      <span class="bm-brand">${grid3D._brand}</span>
      <span class="bm-stat"><span class="bm-lbl">Spend</span><strong>${fmt.money(bm.total_spend)}</strong><span class="bm-sub">${bm.pct_portfolio!=null ? fmt.pct(bm.pct_portfolio,1)+' of portfolio' : ''}</span></span>
      <span class="bm-stat"><span class="bm-lbl">Avg CPC</span><strong>${fmt.money(bm.avg_cpc,2)}</strong></span>
      <span class="bm-stat"><span class="bm-lbl">Wtd Avg QS</span><strong>${bm.wtd_avg_qs!=null ? bm.wtd_avg_qs : '—'}</strong></span>
    </div>` : '';
  const gridTitle = (grid3D && grid3D._brand)
    ? `All three components · ${grid3D._brand}: Expected CTR × LP Experience × Ad Relevance`
    : `All three components: Expected CTR × LP Experience × Ad Relevance`;
  // Inside the 3D panel, only show the portfolioNote when we're NOT displaying brand-specific grid
  const grid3DNote = (grid3D && grid3D._brand) ? '' : portfolioNote;

  const grid3DHTML = grid3D ? `
    <div class="panel">
      <h3>${gridTitle}</h3>
      <div class="muted" style="font-size: 12.5px; margin-bottom: 12px;">
        One unified view of all 27 component combinations${grid3D._brand ? ` for <strong style="color:var(--ink);">${grid3D._brand}</strong>` : ''}. The 9 row-pairs group by Expected CTR slice (Above / Average / Below avg);
        within each group, rows are LP Experience and columns are Ad Relevance. Toggle the metric to see
        <strong style="color:var(--ink);">avg CPC</strong>, <strong style="color:var(--ink);">spend volume</strong>,
        or the resulting <strong style="color:var(--ink);">average Quality Score</strong> for each combination.
        ${grid3D._brand ? `<br/><span style="color:var(--grey);">Spend % shown per eCTR slice is the share of <strong>${grid3D._brand}</strong>'s spend, not portfolio spend.</span>` : ''}
      </div>
      ${brandMetaRibbon}
      ${grid3DNote}
      <div class="seg-group" id="qs3dToggle" style="margin-bottom: 14px;">
        <button class="seg-pill ${QS3D_METRIC==='cpc'?'active':''}"   data-m="cpc">Avg CPC</button>
        <button class="seg-pill ${QS3D_METRIC==='spend'?'active':''}" data-m="spend">Spend</button>
        <button class="seg-pill ${QS3D_METRIC==='qs'?'active':''}"    data-m="qs">Avg Quality Score</button>
      </div>
      ${unifiedGridHTML(QS3D_METRIC)}
      <div class="qs3d-legend">
        <span class="qs3d-legend-label">${QS3D_METRIC==='qs' ? 'Higher = better' : (QS3D_METRIC==='spend' ? 'Higher = more concentrated spend' : 'Higher = more expensive')}</span>
        <div class="qs3d-legend-bar">
          <span style="background:hsl(120,65%,80%);">${QS3D_METRIC==='qs' ? 'Strong' : 'Good'}</span>
          <span style="background:hsl(60,65%,77%);">Mid</span>
          <span style="background:hsl(0,65%,72%);">${QS3D_METRIC==='qs' ? 'Weak' : 'Costly'}</span>
        </div>
      </div>
      ${grid3D.key_insight ? `<div class="muted" style="font-size: 12.5px; margin-top: 14px; padding: 10px 12px; background:#FAFAF7; border-left: 3px solid var(--lime); border-radius: 4px;">
        <strong style="color:var(--ink);">Key insight:</strong> ${grid3D.key_insight.replace(/^Key Insight:\s*/i,'')}
      </div>` : ''}
    </div>` : '';

  el.innerHTML = `
    <style>
      .portfolio-note { display:flex; align-items:center; gap:10px; margin: -4px 0 10px 0; padding: 8px 12px; background:#FAFAF7; border-left: 3px solid var(--lime); border-radius: 4px; font-size: 12px; color: var(--grey); }
      .portfolio-tag { display:inline-block; padding: 2px 8px; background: var(--ink); color: var(--lime); font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; border-radius: 3px; }
      .brand-active-banner { display:flex; align-items:center; gap:8px; margin: 0 0 14px 0; padding: 8px 14px; background: var(--ink); color: #fff; border-radius: 6px; font-size: 12.5px; }
      .brand-active-banner strong { color: var(--lime); font-family:'Space Grotesk',sans-serif; letter-spacing:0.04em; }
      table.qs3d-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; table-layout: fixed; }
      table.qs3d-table thead th { background: #1A1A1A; color: #fff; font-weight: 600; padding: 10px 8px; text-align: center; font-size: 12px; border: 1px solid #1A1A1A; }
      table.qs3d-table thead th.corner-ectr,
      table.qs3d-table thead th.corner-lp  { color: var(--lime); font-size: 11px; text-align: left; padding-left: 12px; }
      table.qs3d-table thead th.corner-ad  { color: var(--lime); font-size: 11px; letter-spacing: 0.04em; }
      table.qs3d-table thead th.ad-h       { background: #2a2a2a; padding: 6px 4px; }
      table.qs3d-table tbody td { padding: 12px 10px; text-align: center; border: 1px solid #fff; vertical-align: middle; }
      table.qs3d-table tbody td.ectr-cell { background: #F7F7F2; text-align: left; padding: 12px 14px; vertical-align: middle; border-left: 4px solid var(--grey); }
      table.qs3d-table tbody td.ectr-cell.grade-A { border-left-color: #059669; }
      table.qs3d-table tbody td.ectr-cell.grade-C { border-left-color: #9CA3AF; }
      table.qs3d-table tbody td.ectr-cell.grade-D { border-left-color: #dc2626; }
      table.qs3d-table tbody td.ectr-cell .ectr-name { font-weight: 700; color: var(--ink); font-size: 13.5px; line-height: 1.2; }
      table.qs3d-table tbody td.ectr-cell .ectr-pct  { font-size: 11.5px; color: var(--grey); margin-top: 4px; }
      table.qs3d-table tbody td.lp-cell   { background: #FAFAF7; text-align: left; padding-left: 12px; }
      table.qs3d-table tbody td.metric-cell { font-weight: 700; color: #1f2937; font-size: 14.5px; font-variant-numeric: tabular-nums; }
      table.qs3d-table tbody tr.group-first td.ectr-cell,
      table.qs3d-table tbody tr.group-first td.lp-cell,
      table.qs3d-table tbody tr.group-first td.metric-cell { border-top: 2px solid #1A1A1A; }
      .brand-meta-ribbon { display:flex; align-items:stretch; gap: 0; margin: 0 0 14px 0; padding: 10px 14px; background: linear-gradient(90deg, #1A1A1A 0%, #262626 100%); color: #fff; border-radius: 6px; border: 1px solid #000; }
      .brand-meta-ribbon .bm-brand { align-self: center; font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 15px; letter-spacing: 0.04em; color: var(--lime); margin-right: 22px; padding-right: 18px; border-right: 1px solid rgba(255,255,255,0.15); }
      .brand-meta-ribbon .bm-stat { display:flex; flex-direction:column; justify-content:center; padding: 0 18px; min-width: 120px; border-right: 1px solid rgba(255,255,255,0.08); }
      .brand-meta-ribbon .bm-stat:last-child { border-right: none; }
      .brand-meta-ribbon .bm-lbl { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.55); margin-bottom: 2px; }
      .brand-meta-ribbon .bm-stat strong { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size: 17px; font-variant-numeric: tabular-nums; color: #fff; line-height:1.2; }
      .brand-meta-ribbon .bm-sub { font-size: 11px; color: rgba(255,255,255,0.55); margin-top: 1px; }
      .qs3d-legend { display:flex; justify-content: flex-end; align-items:center; gap: 14px; margin-top: 10px; font-size: 11.5px; color: var(--grey); }
      .qs3d-legend-bar { display:flex; gap: 0; border-radius: 4px; overflow: hidden; border: 1px solid var(--border); }
      .qs3d-legend-bar span { padding: 4px 14px; font-weight: 600; color: #1f2937; font-size: 11px; }
      /* Consolidated QS component table — section rows visually split the three components */
      .qs-components-unified .comp-section-row td { background: #111; padding: 9px 12px; border-top: 1px solid #000; border-bottom: 1px solid #000; }
      .qs-components-unified .comp-section-head { display:flex; align-items:center; gap: 10px; color: #fff; font-family:'Space Grotesk',sans-serif; }
      .qs-components-unified .comp-section-head strong { font-weight: 700; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; }
      .qs-components-unified .comp-section-num { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius: 4px; background: var(--lime); color: #000; font-weight: 700; font-size: 12px; font-family:'Space Grotesk',sans-serif; }
      /* Tighten spacing between sections so the unified table reads as one report */
      .qs-components-unified tbody tr.comp-section-row:first-child td { border-top: none; }
    </style>
    <div class="view-head">
      <div>
        <h2>Quality Score Breakdown${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:14px;">· ${BRAND}</span>` : ''}</h2>
        <div class="muted">Component-level ratings (eCTR, Ad Relevance, LP Experience) and the top optimization opportunities</div>
      </div>
    </div>

    ${BRAND !== 'ALL' ? `<div class="brand-active-banner">
      <span>Brand filter active:</span> <strong>${BRAND}</strong>
      <span style="margin-left:auto; opacity:0.75;">${(componentsByBrand[BRAND] && grid3DByBrand[BRAND])
        ? `Filtering keyword list, savings table, the consolidated component table, and the 3-component grid.`
        : (componentsByBrand[BRAND]
            ? `Filtering keyword list, savings table, and the consolidated component table.`
            : `Filtering keyword list and savings table. Component-level views are portfolio-wide (not split by brand at source).`)}</span>
    </div>` : ''}

    ${(BRAND !== 'ALL' && !componentsByBrand[BRAND]) ? portfolioNote : ''}
    ${consolidatedCompTableHTML()}

    ${grid3DHTML}

    <div class="panel">
      <h3>Estimated monthly savings by brand${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:12.5px;">· filtered to ${BRAND}</span>` : ''} <span class="muted" style="font-weight:400;font-size:12.5px;">if QS ≤ 5 → QS 7</span></h3>
      <div class="tbl-wrap">
        <table class="sortable">
          <thead><tr>
            <th>Brand</th>
            <th class="num">KWs at QS ≤ 5</th>
            <th class="num">Spend at QS ≤ 5</th>
            <th class="num">Current CPC</th>
            <th class="num">Target CPC (QS 7)</th>
            <th class="num">Est. Savings</th>
            <th class="num">% of Brand Spend</th>
            <th>Primary Component Gap</th>
          </tr></thead>
          <tbody>${opps.map(o => {
            const isTotal = String(o.brand).toUpperCase() === 'TOTAL';
            return `<tr style="${isTotal?'font-weight:700; background:#F7F7F2;':''}">
              <td>${o.brand}</td>
              <td class="num">${fmt.num(o.kws)}</td>
              <td class="num">${fmt.money(o.spend)}</td>
              <td class="num">${fmt.money(o.current_cpc,2)}</td>
              <td class="num">${fmt.money(o.target_cpc,2)}</td>
              <td class="num">${fmt.money(o.est_savings)}</td>
              <td class="num">${fmt.pct(o.pct_brand_spend,2)}</td>
              <td>${o.primary_gap||'—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h3>Top optimization keywords${BRAND!=='ALL' ? ` · ${BRAND}` : ''} <span class="muted" style="font-weight:400;font-size:12.5px;">QS ≤ 6, sorted by spend</span></h3>
      <div class="toolbar">
        <input type="text" id="kwFilter" placeholder="Filter keyword, region, category..." style="min-width: 280px;"/>
        <label>Category:</label>
        <div class="multi">
          <button class="multi-btn" id="kwCatBtn" type="button">All categories</button>
          <div class="multi-menu hidden" id="kwCatMenu">
            ${cats.map(c => `<label><input type="checkbox" value="${c}" checked/> ${c}</label>`).join('')}
          </div>
        </div>
        <label>Region:</label>
        <div class="multi">
          <button class="multi-btn" id="kwRegBtn" type="button">All regions</button>
          <div class="multi-menu hidden" id="kwRegMenu">
            ${regions.map(r => `<label><input type="checkbox" value="${r}" checked/> ${r}</label>`).join('')}
          </div>
        </div>
        <span id="kwCount" class="muted" style="font-size:12.5px; margin-left:auto;"></span>
        <button type="button" id="kwShowAll" class="multi-btn hidden">Show all</button>
      </div>
      <div class="tbl-wrap">
        <table class="sortable" id="kwTbl">
          <thead><tr>
            <th>Keyword</th>
            <th>Brand</th>
            <th>Region</th>
            <th>Category</th>
            <th class="num">QS</th>
            <th class="num">Spend</th>
            <th class="num">CPC</th>
            <th class="num">Clicks</th>
            <th>eCTR</th>
            <th>Ad Rel</th>
            <th>LP Exp</th>
            <th class="num">Conv</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;

  // 3D grid toggle
  const qs3dToggle = $('#qs3dToggle');
  if (qs3dToggle) {
    qs3dToggle.querySelectorAll('.seg-pill').forEach(b => {
      b.addEventListener('click', () => {
        QS3D_METRIC = b.dataset.m;
        setView(CURRENT_VIEW, {preserveScroll: true});
      });
    });
  }

  // Filter state
  const input   = $('#kwFilter');
  const catBtn  = $('#kwCatBtn');
  const catMenu = $('#kwCatMenu');
  const regBtn  = $('#kwRegBtn');
  const regMenu = $('#kwRegMenu');
  const countEl = $('#kwCount');
  const showAll = $('#kwShowAll');
  let expanded = false;
  let filtered = rows;
  let debounce = null;

  catBtn.addEventListener('click', e => { e.stopPropagation(); catMenu.classList.toggle('hidden'); regMenu.classList.add('hidden'); });
  regBtn.addEventListener('click', e => { e.stopPropagation(); regMenu.classList.toggle('hidden'); catMenu.classList.add('hidden'); });
  document.addEventListener('click', e => {
    if (!catMenu.contains(e.target) && e.target !== catBtn) catMenu.classList.add('hidden');
    if (!regMenu.contains(e.target) && e.target !== regBtn) regMenu.classList.add('hidden');
  });

  function rowHTML(r) {
    return `<tr class="${qsRowClass(r.QS)}">
      <td class="url">${r.Keyword}</td>
      <td>${r.Brand}</td>
      <td>${r.Region||'—'}</td>
      <td>${r.Category||'—'}</td>
      <td class="num"><strong>${r.QS}</strong></td>
      <td class="num">${fmt.money(r.Spend)}</td>
      <td class="num">${fmt.money(r.CPC,2)}</td>
      <td class="num">${fmt.num(r.Clicks)}</td>
      <td><span class="tag ${ratingClass(r.eCTR)}">${r.eCTR||'—'}</span></td>
      <td><span class="tag ${ratingClass(r.AdRel)}">${r.AdRel||'—'}</span></td>
      <td><span class="tag ${ratingClass(r.LpExp)}">${r.LpExp||'—'}</span></td>
      <td class="num">${fmt.num(r.Conv,1)}</td>
    </tr>`;
  }

  function renderBody() {
    const tb = document.querySelector('#kwTbl tbody');
    const slice = expanded ? filtered : filtered.slice(0, ROW_CAP);
    tb.innerHTML = slice.map(rowHTML).join('');
    updateCount();
  }
  function updateCount() {
    if (!expanded && filtered.length > ROW_CAP) {
      showAll.classList.remove('hidden');
      showAll.textContent = `Show all ${fmt.num(filtered.length)}`;
      countEl.textContent = `Showing top ${ROW_CAP} of ${fmt.num(filtered.length)} (from ${fmt.num(rows.length)} total)`;
    } else {
      showAll.classList.add('hidden');
      countEl.textContent = `Showing ${fmt.num(filtered.length)} of ${fmt.num(rows.length)}`;
    }
  }
  function applyFilters() {
    const q = input.value.toLowerCase();
    const pickedCats = Array.from(catMenu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value);
    const pickedRegs = Array.from(regMenu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value);
    const allCats = pickedCats.length === cats.length;
    const allRegs = pickedRegs.length === regions.length;
    catBtn.textContent = allCats ? 'All categories' : `${pickedCats.length} of ${cats.length}`;
    catBtn.classList.toggle('has-selection', !allCats);
    regBtn.textContent = allRegs ? 'All regions' : `${pickedRegs.length} of ${regions.length}`;
    regBtn.classList.toggle('has-selection', !allRegs);
    const pcSet = new Set(pickedCats);
    const prSet = new Set(pickedRegs);
    filtered = rows.filter(r =>
      (q === '' || (r._srch || '').includes(q)) &&
      pcSet.has(r.Category) &&
      prSet.has(r.Region)
    );
    expanded = false;
    renderBody();
  }
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(applyFilters, 120); });
  catMenu.addEventListener('change', applyFilters);
  regMenu.addEventListener('change', applyFilters);
  showAll.addEventListener('click', () => { expanded = true; renderBody(); });
  applyFilters();

  enableSortable(el);
}

// ====== KEYWORD · REGION & CATEGORY (Component × Brand) ======
let QS_CB_SECTION = 0; // which component section: 0 eCTR, 1 Ad Rel, 2 LP Exp
function renderQsRegionCategory(el) {
  const d = DATA.qs_region_category || {sections: []};
  const sections = d.sections || [];
  if (!sections.length) {
    el.innerHTML = `<div class="panel">No data available.</div>`;
    return;
  }
  const active = sections[QS_CB_SECTION] || sections[0];
  const allRows = active.rows || [];
  let rows = BRAND === 'ALL' ? allRows : allRows.filter(r => r.Brand === BRAND);
  // Precompute searchable text
  if (rows.length && !rows[0]._srch) {
    for (const r of rows) r._srch = [r.Brand, r.Region, r.Category].join(' ').toLowerCase();
  }
  const cats    = Array.from(new Set(rows.map(r => r.Category).filter(Boolean))).sort();
  const regions = Array.from(new Set(rows.map(r => r.Region).filter(Boolean))).sort();
  const brands  = Array.from(new Set(allRows.map(r => r.Brand).filter(Boolean))).sort();

  el.innerHTML = `
    <style>
      .brand-active-banner { display:flex; align-items:center; gap:8px; margin: 0 0 14px 0; padding: 8px 14px; background: var(--ink); color: #fff; border-radius: 6px; font-size: 12.5px; }
      .brand-active-banner strong { color: var(--lime); font-family:'Space Grotesk',sans-serif; letter-spacing:0.04em; }
    </style>
    <div class="view-head">
      <div>
        <h2>Region &amp; Category · CPC by component rating${BRAND!=='ALL' ? ` <span class="muted" style="font-weight:400;font-size:14px;">· ${BRAND}</span>` : ''}</h2>
        <div class="muted">For each Brand × Region × Category slice, compare avg CPC when the keyword's component rating is Below Avg, Average, or Above Avg.</div>
      </div>
    </div>

    ${BRAND !== 'ALL' ? `<div class="brand-active-banner">
      <span>Brand filter active:</span> <strong>${BRAND}</strong>
      <span style="margin-left:auto; opacity:0.75;">Showing ${rows.length} of ${allRows.length} ${active.name} rows.</span>
    </div>` : ''}

    <div class="seg-group" style="margin-bottom: 14px;">
      ${sections.map((s,i) => `<button class="seg-pill ${i===QS_CB_SECTION?'active':''}" data-idx="${i}">${s.name}</button>`).join('')}
    </div>

    <div class="panel">
      <div class="toolbar">
        <input type="text" id="cbFilter" placeholder="Filter brand, region, category..." style="min-width: 280px;"/>
        <label>Category:</label>
        <div class="multi">
          <button class="multi-btn" id="cbCatBtn" type="button">All categories</button>
          <div class="multi-menu hidden" id="cbCatMenu">
            ${cats.map(c => `<label><input type="checkbox" value="${c}" checked/> ${c}</label>`).join('')}
          </div>
        </div>
        <label>Region:</label>
        <div class="multi">
          <button class="multi-btn" id="cbRegBtn" type="button">All regions</button>
          <div class="multi-menu hidden" id="cbRegMenu">
            ${regions.map(r => `<label><input type="checkbox" value="${r}" checked/> ${r}</label>`).join('')}
          </div>
        </div>
        <span id="cbCount" class="muted" style="font-size:12.5px; margin-left:auto;"></span>
        <button type="button" id="cbShowAll" class="multi-btn hidden">Show all</button>
      </div>
      <div class="muted" style="font-size: 12.5px; margin: 0 0 10px 2px;">
        Showing: <strong style="color:var(--ink);">${active.name}</strong>. "CPC Spread" = Below CPC − Above CPC. Larger spread = higher financial pain when a component drops to Below Avg.
      </div>
      <div class="tbl-wrap">
        <table class="sortable" id="cbTbl">
          <thead><tr>
            <th>Brand</th>
            <th>Region</th>
            <th>Category</th>
            <th class="num">Total Spend</th>
            <th class="num">Below CPC</th>
            <th class="num">Below Clicks</th>
            <th class="num">Avg CPC</th>
            <th class="num">Avg Clicks</th>
            <th class="num">Above CPC</th>
            <th class="num">Above Clicks</th>
            <th class="num">CPC Spread</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;

  // Section tabs
  el.querySelectorAll('.seg-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      QS_CB_SECTION = +btn.dataset.idx;
      setView(CURRENT_VIEW, {preserveScroll: true});
    });
  });

  const input   = $('#cbFilter');
  const catBtn  = $('#cbCatBtn');
  const catMenu = $('#cbCatMenu');
  const regBtn  = $('#cbRegBtn');
  const regMenu = $('#cbRegMenu');
  const countEl = $('#cbCount');
  const showAll = $('#cbShowAll');
  let expanded = false;
  let filtered = rows;
  let debounce = null;

  catBtn.addEventListener('click', e => { e.stopPropagation(); catMenu.classList.toggle('hidden'); regMenu.classList.add('hidden'); });
  regBtn.addEventListener('click', e => { e.stopPropagation(); regMenu.classList.toggle('hidden'); catMenu.classList.add('hidden'); });
  document.addEventListener('click', e => {
    if (!catMenu.contains(e.target) && e.target !== catBtn) catMenu.classList.add('hidden');
    if (!regMenu.contains(e.target) && e.target !== regBtn) regMenu.classList.add('hidden');
  });

  function rowHTML(r) {
    const spread = r.Spread;
    const spreadColor = spread==null ? '' : (spread >= 0.5 ? 'color:#dc2626;font-weight:600;' : spread >= 0.25 ? 'color:#f59e0b;font-weight:600;' : '');
    return `<tr>
      <td>${r.Brand}</td>
      <td>${r.Region||'—'}</td>
      <td>${r.Category||'—'}</td>
      <td class="num">${fmt.money(r.TotalSpend)}</td>
      <td class="num">${fmt.money(r.BelowCPC,2)}</td>
      <td class="num">${fmt.num(r.BelowClicks)}</td>
      <td class="num">${fmt.money(r.AvgCPC,2)}</td>
      <td class="num">${fmt.num(r.AvgClicks)}</td>
      <td class="num">${fmt.money(r.AboveCPC,2)}</td>
      <td class="num">${fmt.num(r.AboveClicks)}</td>
      <td class="num" style="${spreadColor}">${spread==null ? '—' : '$'+spread.toFixed(2)}</td>
    </tr>`;
  }

  function renderBody() {
    const tb = document.querySelector('#cbTbl tbody');
    const slice = expanded ? filtered : filtered.slice(0, ROW_CAP);
    tb.innerHTML = slice.map(rowHTML).join('');
    updateCount();
  }
  function updateCount() {
    if (!expanded && filtered.length > ROW_CAP) {
      showAll.classList.remove('hidden');
      showAll.textContent = `Show all ${fmt.num(filtered.length)}`;
      countEl.textContent = `Showing top ${ROW_CAP} of ${fmt.num(filtered.length)} (from ${fmt.num(rows.length)} total)`;
    } else {
      showAll.classList.add('hidden');
      countEl.textContent = `Showing ${fmt.num(filtered.length)} of ${fmt.num(rows.length)}`;
    }
  }
  function applyFilters() {
    const q = input.value.toLowerCase();
    const pickedCats = Array.from(catMenu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value);
    const pickedRegs = Array.from(regMenu.querySelectorAll('input[type=checkbox]:checked')).map(x=>x.value);
    const allCats = pickedCats.length === cats.length;
    const allRegs = pickedRegs.length === regions.length;
    catBtn.textContent = allCats ? 'All categories' : `${pickedCats.length} of ${cats.length}`;
    catBtn.classList.toggle('has-selection', !allCats);
    regBtn.textContent = allRegs ? 'All regions' : `${pickedRegs.length} of ${regions.length}`;
    regBtn.classList.toggle('has-selection', !allRegs);
    const pcSet = new Set(pickedCats);
    const prSet = new Set(pickedRegs);
    filtered = rows.filter(r =>
      (q === '' || (r._srch || '').includes(q)) &&
      pcSet.has(r.Category) &&
      prSet.has(r.Region)
    );
    expanded = false;
    renderBody();
  }
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(applyFilters, 120); });
  catMenu.addEventListener('change', applyFilters);
  regMenu.addEventListener('change', applyFilters);
  showAll.addEventListener('click', () => { expanded = true; renderBody(); });
  applyFilters();

  enableSortable(el);
}

// ====== RECOMMENDATIONS ======
function renderRecs(el) {
  const all = DATA.recommendations || [];
  const rs = BRAND==='ALL' ? all : all.filter(r => {
    const blob = `${r.Category||''} ${r.Recommendation||''} ${r.Rationale||''}`.toUpperCase();
    // brand-word match (boundaries) to avoid false positives like "BP" inside "LP Performance"
    const re = new RegExp('(^|[^A-Z])'+BRAND+'([^A-Z]|$)');
    return re.test(blob);
  });
  const priorityTag = p => {
    const s = String(p||'').toLowerCase();
    if (s.includes('high') || s.includes('p0') || s.includes('p1')) return '<span class="tag bad">High</span>';
    if (s.includes('medium') || s.includes('p2')) return '<span class="tag warn">Medium</span>';
    if (s.includes('low') || s.includes('p3')) return '<span class="tag info">Low</span>';
    return `<span class="tag">${p||'—'}</span>`;
  };
  el.innerHTML = `
    <div class="view-head"><div><h2>Recommendations</h2>
      <div class="muted">${BRAND==='ALL' ? `${rs.length} strategic recommendations · prioritized` : `${rs.length} of ${all.length} recommendations mentioning ${BRAND}`}</div></div></div>
    ${rs.length===0 ? `<div class="panel" style="text-align:center; color:var(--grey); padding:32px;">No recommendations directly mention ${BRAND}. Clear the brand filter to see all.</div>` : ''}
    ${rs.map(r => {
      const title = r.Recommendation||r.Title||r.title||'';
      const cat = r.Category||r.category||r.Area||'';
      const rationale = r.Rationale||r.Description||r.description||r.Details||'';
      const impact = r['Expected Impact']||r.Impact||'';
      const effort = r.Effort||r.effort||'';
      return `<div class="rec">
        <div class="rec-head">
          ${priorityTag(r.Priority||r.priority)}
          <div class="rec-title">${title}</div>
          <div class="rec-meta">${cat}</div>
        </div>
        <p>${rationale}</p>
        ${(impact||effort) ? `<div class="rec-foot muted" style="margin-top:10px; font-size:12px;">
          ${impact?`<span><strong style="color:var(--ink);">Impact:</strong> ${impact}</span>`:''}
          ${impact&&effort?' &nbsp;·&nbsp; ':''}
          ${effort?`<span><strong style="color:var(--ink);">Effort:</strong> ${effort}</span>`:''}
        </div>` : ''}
      </div>`;
    }).join('')}
  `;
}

// ====== CHART DEFAULTS ======
function chartOpts(opts) {
  opts = opts || {};
  const common = {
    responsive:true, maintainAspectRatio:true,
    interaction: {mode:'index', intersect:false},
    plugins: {
      legend: { labels: { color:'#1A1A1A', font:{family:'Inter', size:12, weight:'500'}, boxWidth:10, boxHeight:10, padding:12 } },
      tooltip: { backgroundColor:'#1A1A1A', titleColor:'#CFFF04', bodyColor:'#fff', borderColor:'#CFFF04', borderWidth:1, padding:10, cornerRadius: 8, titleFont:{family:'Space Grotesk', weight:'700'}, bodyFont:{family:'Inter'} },
    },
    scales: {
      x: { ticks:{ color:'#6B7280', font:{family:'Inter', size:11} }, grid:{ color:'rgba(229,231,235,0.6)' } },
      y: { ticks:{ color:'#6B7280', font:{family:'Inter', size:11},
                    callback: v => opts.moneyAxis ? '$'+Number(v).toLocaleString() : opts.pctAxis ? (Number(v)*100).toFixed(0)+'%' : Number(v).toLocaleString() },
           grid:{ color:'rgba(229,231,235,0.6)' } },
    }
  };
  if (opts.dualY) {
    common.scales.y1 = { position:'right', ticks:{ color:'#6B7280', font:{family:'Inter', size:11}, callback: v=>Number(v).toLocaleString() }, grid:{drawOnChartArea:false} };
  }
  return common;
}
