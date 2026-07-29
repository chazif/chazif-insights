/* Auto Total row for data tables.
 *
 * Adds a sticky <tfoot> "Total" row to every data table in the dashboard, computed
 * from the rows currently rendered. Additive columns (Spend, Clicks, Impressions,
 * Conversions, ...) are summed; rate columns (CTR, CVR, CPA, CPC, Impr. Share, QS,
 * position, ...) are intentionally left blank — summing rates is meaningless and
 * would violate the weighted-metrics rule. Transposed / non-additive tables (the KPI
 * scorecard whose first header is "Metric", the ad×LP pair-grid) are skipped, as are
 * pure text/list tables with nothing summable.
 *
 * It re-runs on any view change, in-view filter, or sort via a MutationObserver, so
 * the Total always reflects the visible rows. Add class "no-total" to a table to opt out.
 */
(function () {
  "use strict";

  // Header keywords whose columns are rates/derived and must NOT be summed.
  var RATE_RE = /%|CTR|CVR|CPA|CPC|CPM|ROAS|\bshare\b|\brate\b|\bavg\b|average|\bindex\b|score|position|\bper\b/i;

  function parseNum(cell) {
    if (!cell) return NaN;
    var ds = cell.getAttribute && cell.getAttribute("data-sort");
    if (ds != null && ds !== "" && isFinite(+ds)) return +ds;          // trust the sort key when present
    var t = (cell.innerText || cell.textContent || "").replace(/[^0-9.\-]/g, "");
    if (t === "" || t === "-" || t === ".") return NaN;
    var n = parseFloat(t);
    return isFinite(n) ? n : NaN;
  }

  function decimalsOf(text) {
    var m = /\.(\d+)/.exec(String(text || ""));
    return m ? Math.min(m[1].length, 2) : 0;
  }

  function fmtNum(v, decimals, currency) {
    var s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return (v < 0 ? "-" : "") + (currency ? "$" : "") + s;
  }

  function shouldSkip(table) {
    if (!table.tHead || !table.tHead.rows.length || !table.tBodies.length) return true;
    if (table.classList.contains("pair-grid") || table.classList.contains("no-total")) return true;
    var first = table.tHead.rows[0].cells[0];
    var h = (first && (first.innerText || first.textContent) || "").trim().toLowerCase();
    if (h === "metric") return true;   // transposed scorecard — columns aren't additive
    return false;
  }

  function computeRowHTML(table) {
    var head = table.tHead.rows[0];
    var ncols = head.cells.length;
    var body = table.tBodies[0];
    // Only rows with the full column count — skips colspan "No data" / note rows.
    var rows = Array.prototype.filter.call(body.rows, function (r) { return r.cells.length === ncols; });
    if (rows.length < 2) return null;

    var isRate = [], sums = [], counts = [], decs = [], currency = [];
    for (var i = 0; i < ncols; i++) {
      isRate[i] = RATE_RE.test(head.cells[i].innerText || head.cells[i].textContent || "");
      sums[i] = 0; counts[i] = 0; decs[i] = 0; currency[i] = false;
    }
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].cells;
      for (var c = 0; c < ncols; c++) {
        var txt = cells[c].innerText || cells[c].textContent || "";
        if (txt.indexOf("$") >= 0) currency[c] = true;
        if (isRate[c]) continue;
        var n = parseNum(cells[c]);
        if (!isNaN(n)) { sums[c] += n; counts[c]++; decs[c] = Math.max(decs[c], decimalsOf(txt)); }
      }
    }
    // A column is summable only if most of its cells parsed as numbers.
    var need = Math.ceil(rows.length / 2), summable = [], anyNumeric = false;
    for (var k = 0; k < ncols; k++) { summable[k] = !isRate[k] && counts[k] >= need; if (summable[k]) anyNumeric = true; }
    if (!anyNumeric) return null;   // nothing to total (pure text/list table)

    // "Total" label goes in the first non-summable column (usually the entity name).
    var labelCol = 0;
    for (var j = 0; j < ncols; j++) { if (!summable[j]) { labelCol = j; break; } }

    var out = [];
    for (var m = 0; m < ncols; m++) {
      var alignNum = head.cells[m].classList.contains("num") || (rows[0].cells[m] && rows[0].cells[m].classList.contains("num"));
      var cls = alignNum ? ' class="num"' : "";
      if (summable[m])            out.push("<td" + cls + ">" + fmtNum(sums[m], decs[m], currency[m]) + "</td>");
      else if (m === labelCol)    out.push("<td" + cls + ">Total</td>");
      else                        out.push("<td" + cls + "></td>");
    }
    return "<tr>" + out.join("") + "</tr>";
  }

  function applyOne(table) {
    var old = table.querySelector("tfoot.total-row");
    if (old) old.parentNode.removeChild(old);          // clean recompute
    if (shouldSkip(table)) return;
    var html = computeRowHTML(table);
    if (!html) return;
    var tf = document.createElement("tfoot");
    tf.className = "total-row";
    tf.innerHTML = html;
    table.appendChild(tf);
  }

  function applyAll(root) {
    var tables = (root || document).querySelectorAll("table");
    Array.prototype.forEach.call(tables, applyOne);
  }

  function target() {
    return document.getElementById("view-root") || document.getElementById("main") || document.body;
  }

  var scheduled = false, observer = null;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      if (observer) observer.disconnect();            // our own tfoot writes must not retrigger us
      try { applyAll(target()); } catch (e) { /* never break the view over a totals hiccup */ }
      if (observer) observer.observe(target(), { childList: true, subtree: true });
    }, 60);
  }

  function init() {
    try { applyAll(target()); } catch (e) {}
    observer = new MutationObserver(schedule);
    observer.observe(target(), { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.chzApplyTotals = applyAll;   // exposed for manual re-run if ever needed
})();
