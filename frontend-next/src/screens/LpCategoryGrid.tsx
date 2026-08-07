import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { LpCatSummary, LpCatGridRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { shortUrl } from "../lib/grades";
import { StatStrip } from "../components/ui/StatStrip";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

export function LpCategoryGrid() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const grid = data?.landing_pages_section?.category_grid;
  if (!grid?.summary?.length) return <Empty what="No landing-page category grid for this client." />;

  const st = grid.stats;

  const sumCols: Column<LpCatSummary>[] = [
    { key: "cat", header: "Category", sort: (r) => r.category, render: (r) => <span className="font-medium">{r.category}</span>, csv: (r) => r.category },
    { key: "lps", header: "LPs running", align: "right", sort: (r) => r.lps_running, render: (r) => num(r.lps_running), agg: { kind: "sum", get: (r) => r.lps_running, fmt: (n) => num(n) }, csv: (r) => r.lps_running },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend },
    { key: "min", header: "Min CVR", align: "right", sort: (r) => r.min_cvr, render: (r) => pct(r.min_cvr, 2), csv: (r) => r.min_cvr },
    { key: "med", header: "Median CVR", align: "right", sort: (r) => r.median_cvr, render: (r) => pct(r.median_cvr, 2), csv: (r) => r.median_cvr },
    { key: "max", header: "Max CVR", align: "right", sort: (r) => r.max_cvr, render: (r) => pct(r.max_cvr, 2), csv: (r) => r.max_cvr },
    { key: "best", header: "Best LP", sort: (r) => r.best_lp, render: (r) => <span className="text-text-tertiary" title={r.best_lp}>{shortUrl(r.best_lp)}</span>, csv: (r) => r.best_lp },
  ];

  const gridCols: Column<LpCatGridRow>[] = [
    { key: "url", header: "Landing page", sort: (r) => r.url, render: (r) => <span className="font-medium" title={r.url}>{shortUrl(r.url)}</span>, csv: (r) => r.url },
    { key: "ncat", header: "Categories", align: "right", sort: (r) => r.n_cats, render: (r) => num(r.n_cats), csv: (r) => r.n_cats },
    ...grid.categories.map((cat): Column<LpCatGridRow> => ({
      key: "cat_" + cat,
      header: cat,
      align: "right",
      sort: (r) => r.cvr_by_cat[cat] ?? -1,
      render: (r) => (r.cvr_by_cat[cat] == null ? <span className="text-text-disabled">—</span> : pct(r.cvr_by_cat[cat]!, 2)),
      csv: (r) => r.cvr_by_cat[cat] ?? "",
    })),
    { key: "cost", header: "Cost", align: "right", sort: (r) => r.cost, render: (r) => money(r.cost), agg: { kind: "sum", get: (r) => r.cost, fmt: (n) => money(n) }, csv: (r) => r.cost },
    { key: "ocvr", header: "Overall CVR", align: "right", sort: (r) => r.overall_cvr, render: (r) => pct(r.overall_cvr, 2), agg: { kind: "rate", num: (r) => r.conv, den: (r) => r.clicks, fmt: (n) => pct(n, 2) }, csv: (r) => r.overall_cvr },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Landing pages", value: num(st.landing_pages) },
          { label: "Spend", value: money(st.spend) },
          { label: "Weighted CVR", value: pct(st.weighted_cvr, 2) },
          { label: "Avg categories / LP", value: st.avg_cats.toFixed(1) },
        ]}
      />
      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">By category</h2>
        <DataTable rows={grid.summary} columns={sumCols} rowKey={(r) => r.category} totalsLabel="All categories" exportName={`lp-category-summary-${clientId}`} />
      </div>
      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">CVR by landing page × category</h2>
        <DataTable rows={grid.rows} columns={gridCols} rowKey={(r, i) => r.url + "|" + i} totalsLabel="Total" exportName={`lp-category-grid-${clientId}`} />
      </div>
    </div>
  );
}
