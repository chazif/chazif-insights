import { useState } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { LpCatSummary, LpCatGridRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { shortUrl } from "../lib/grades";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

// CVR heat: low → light red, mid → light yellow, ≥45% → lime (mirrors the original).
function cvrHeatBg(cvr: number) {
  const t = Math.max(0, Math.min(1, cvr / 0.45));
  const stops = [[251, 215, 215], [254, 243, 199], [207, 255, 4]];
  const seg = t < 0.5 ? 0 : 1;
  const u = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const a = stops[seg], b = stops[seg + 1];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * u));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function CvrBadge({ v }: { v: number | null }) {
  if (v == null) return <span className="text-text-disabled">—</span>;
  return <span className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-ink" style={{ background: cvrHeatBg(v) }}>{(v * 100).toFixed(1)}%</span>;
}

export function LpCategoryGrid() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [filter, setFilter] = useState("");
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const grid = data?.landing_pages_section?.category_grid;
  if (!grid?.summary?.length) return <Empty what="No landing-page category grid for this client." />;

  const st = grid.stats;
  const shownRows = filter ? grid.rows.filter((r) => (r.url || "").toLowerCase().indexOf(filter.toLowerCase()) >= 0) : grid.rows;

  const sumCols: Column<LpCatSummary>[] = [
    { key: "cat", header: "Category", sort: (r) => r.category, render: (r) => <span className="font-medium">{r.category}</span>, csv: (r) => r.category },
    { key: "lps", header: "LPs Running", align: "right", sort: (r) => r.lps_running, render: (r) => num(r.lps_running), agg: { kind: "sum", get: (r) => r.lps_running, fmt: (n) => num(n) }, csv: (r) => r.lps_running },
    { key: "spend", header: "Spend (LPs Running)", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend },
    { key: "min", header: "Min CVR", align: "right", sort: (r) => r.min_cvr, render: (r) => <CvrBadge v={r.min_cvr} />, csv: (r) => r.min_cvr },
    { key: "med", header: "Median CVR", align: "right", sort: (r) => r.median_cvr, render: (r) => <CvrBadge v={r.median_cvr} />, csv: (r) => r.median_cvr },
    { key: "max", header: "Max CVR", align: "right", sort: (r) => r.max_cvr, render: (r) => <CvrBadge v={r.max_cvr} />, csv: (r) => r.max_cvr },
    { key: "best", header: "Best LP", sort: (r) => r.best_lp, render: (r) => <span className="block max-w-[220px] truncate text-[11.5px] text-text-tertiary" title={r.best_lp}>{shortUrl(r.best_lp)}</span>, csv: (r) => r.best_lp },
    { key: "worst", header: "Worst LP", sort: (r) => r.worst_lp, render: (r) => <span className="block max-w-[220px] truncate text-[11.5px] text-[#9a5b1e]" title={r.worst_lp}>{shortUrl(r.worst_lp)}</span>, csv: (r) => r.worst_lp },
  ];

  const gridCols: Column<LpCatGridRow>[] = [
    { key: "url", header: "URL", sort: (r) => r.url, render: (r) => <a href={r.url} target="_blank" rel="noopener noreferrer" className="block max-w-[320px] truncate font-medium hover:underline" title={r.url}>{shortUrl(r.url)}</a>, csv: (r) => r.url },
    { key: "cost", header: "Cost", align: "right", sort: (r) => r.cost, render: (r) => money(r.cost), csv: (r) => r.cost },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), csv: (r) => r.clicks },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 0), csv: (r) => r.conv },
    { key: "ocvr", header: "Overall CVR", align: "right", sort: (r) => r.overall_cvr, render: (r) => pct(r.overall_cvr, 2), csv: (r) => r.overall_cvr },
    { key: "ncat", header: "# Cats", align: "right", sort: (r) => r.n_cats, render: (r) => num(r.n_cats), csv: (r) => r.n_cats },
    ...grid.categories.map((cat): Column<LpCatGridRow> => ({
      key: "cat_" + cat,
      header: cat,
      align: "right",
      sort: (r) => r.cvr_by_cat[cat] ?? -1,
      render: (r) => <CvrBadge v={r.cvr_by_cat[cat] ?? null} />,
      csv: (r) => r.cvr_by_cat[cat] ?? "",
    })),
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold">LP Category Grid</h2>
        <div className="text-[12.5px] text-text-muted">{num(grid.total)} landing pages · CVR by category (heat-coded: lime = excellent, red = poor)</div>
      </div>

      <StatStrip
        stats={[
          { label: "Landing Pages", value: num(st.landing_pages), sub: `avg ${st.avg_cats} categories each` },
          { label: "Spend", value: money(st.spend), sub: `across ${num(st.landing_pages)} LPs` },
          { label: "Clicks", value: num(st.clicks), sub: "driven to LPs" },
          { label: "Conversions", value: num(st.conversions, 0), sub: "total tracked conv" },
          { label: "Weighted CVR", value: pct(st.weighted_cvr, 2), sub: "conv ÷ clicks (all LPs)", highlight: true },
        ]}
      />

      <div className="mt-6">
        <Panel title="Category summary" sub="CVR stats across LPs running each category">
          <DataTable rows={grid.summary} columns={sumCols} rowKey={(r) => r.category} totalsLabel="Total" exportName={`lp-category-summary-${clientId}`} />
        </Panel>
      </div>

      <div className="mt-6">
        <Panel>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-text-secondary">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter URL…"
              className="min-w-[260px] rounded-[7px] border border-border-strong px-2.5 py-1 text-[13px] focus:border-ink focus:outline-none"
            />
            <span className="ml-auto text-text-muted">Showing {num(shownRows.length)} of {num(grid.total)}</span>
          </div>
          <DataTable rows={shownRows} columns={gridCols} rowKey={(r, i) => r.url + "|" + i} exportName={`lp-category-grid-${clientId}`} />
        </Panel>
      </div>
    </div>
  );
}
