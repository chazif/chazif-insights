import { useState } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { RegCatRow } from "../lib/types";
import { money, num } from "../lib/format";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const selectCls = "rounded-[7px] border border-border-strong bg-surface px-2.5 py-1 text-[13px]";

export function KwRegionCategory() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [tab, setTab] = useState(0);
  const [cat, setCat] = useState("all");
  const [reg, setReg] = useState("all");
  const [filter, setFilter] = useState("");
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.region_category_section;
  if (!sec?.components?.length) {
    return <Empty what="Needs a keyword export segmented by geography. Re-export the Search Keyword report with a Region/State segment to unlock this view." />;
  }

  const comp = sec.components[Math.min(tab, sec.components.length - 1)];
  const cpc = (v: number | null) => (v == null ? <span className="text-text-disabled">—</span> : money(v, 2));

  const shown = comp.rows.filter((r) => {
    if (cat !== "all" && r.category !== cat) return false;
    if (reg !== "all" && r.region !== reg) return false;
    if (filter) {
      const f = filter.toLowerCase();
      if (`${r.brand} ${r.region} ${r.category}`.toLowerCase().indexOf(f) < 0) return false;
    }
    return true;
  });

  const cols: Column<RegCatRow>[] = [
    { key: "brand", header: "Brand", sort: (r) => r.brand, render: (r) => <span className="font-medium">{r.brand}</span>, csv: (r) => r.brand },
    { key: "region", header: "Region", sort: (r) => r.region, render: (r) => r.region, csv: (r) => r.region },
    { key: "cat", header: "Category", sort: (r) => r.category, render: (r) => (r.category === "Uncategorized" ? <span className="text-text-disabled">Uncategorized</span> : <span className="rounded-[5px] bg-[#eef2ff] px-1.5 py-0.5 text-[12px] font-medium text-[#4338ca]">{r.category}</span>), csv: (r) => r.category },
    { key: "spend", header: "Total Spend", align: "right", sort: (r) => r.total_spend, render: (r) => money(r.total_spend), agg: { kind: "sum", get: (r) => r.total_spend, fmt: (n) => money(n) }, csv: (r) => r.total_spend },
    { key: "below", header: "Below CPC", align: "right", sort: (r) => r.below_cpc ?? 0, render: (r) => cpc(r.below_cpc), csv: (r) => r.below_cpc ?? "" },
    { key: "belowc", header: "Below Clicks", align: "right", sort: (r) => r.below_clicks, render: (r) => num(r.below_clicks), agg: { kind: "sum", get: (r) => r.below_clicks, fmt: (n) => num(n) }, csv: (r) => r.below_clicks },
    { key: "avg", header: "Avg CPC", align: "right", sort: (r) => r.avg_cpc ?? 0, render: (r) => cpc(r.avg_cpc), csv: (r) => r.avg_cpc ?? "" },
    { key: "avgc", header: "Avg Clicks", align: "right", sort: (r) => r.avg_clicks, render: (r) => num(r.avg_clicks), csv: (r) => r.avg_clicks },
    { key: "above", header: "Above CPC", align: "right", sort: (r) => r.above_cpc ?? 0, render: (r) => cpc(r.above_cpc), csv: (r) => r.above_cpc ?? "" },
    { key: "abovec", header: "Above Clicks", align: "right", sort: (r) => r.above_clicks, render: (r) => num(r.above_clicks), agg: { kind: "sum", get: (r) => r.above_clicks, fmt: (n) => num(n) }, csv: (r) => r.above_clicks },
    {
      key: "spread", header: "CPC Spread", align: "right", sort: (r) => r.spread ?? 0,
      render: (r) => (r.spread == null ? <span className="text-text-disabled">—</span> : <span className={r.spread >= 0 ? "text-negative" : "text-positive"}>{(r.spread >= 0 ? "+" : "") + money(r.spread, 2)}</span>),
      csv: (r) => r.spread ?? "",
    },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold">Region &amp; Category · CPC by component rating</h2>
        <div className="text-[12.5px] text-text-muted">
          For each Brand × Region × Category slice, compare avg CPC when the keyword's component rating is Below Avg, Average, or Above Avg.
        </div>
      </div>

      <div className="mb-4 inline-flex overflow-hidden rounded-[7px] border border-border-strong divide-x divide-border-strong">
        {sec.components.map((c, i) => (
          <button
            key={c.key}
            onClick={() => { setTab(i); setCat("all"); setReg("all"); }}
            className={`px-3 py-1 text-[13px] font-medium ${i === tab ? "bg-ink text-accent" : "bg-surface text-text-muted hover:text-ink"}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px] text-text-secondary">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter brand, region, category…"
          className="min-w-[240px] rounded-[7px] border border-border-strong px-2.5 py-1 text-[13px] focus:border-ink focus:outline-none"
        />
        <label>Category:</label>
        <select value={cat} onChange={(e) => setCat(e.target.value)} className={selectCls}>
          <option value="all">All categories</option>
          {sec.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label>Region:</label>
        <select value={reg} onChange={(e) => setReg(e.target.value)} className={selectCls}>
          <option value="all">All regions</option>
          {sec.regions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <span className="ml-auto text-text-muted">Showing {num(shown.length)} of {num(comp.total)}</span>
      </div>

      <div className="mb-2 text-[12px] text-text-muted">
        Showing: <strong className="text-ink">{comp.label}</strong>. "CPC Spread" = Below CPC − Above CPC. Larger spread = higher financial pain when a component drops to Below Avg.
      </div>

      <DataTable rows={shown} columns={cols} rowKey={(r, i) => r.region + "|" + r.category + "|" + i} totalsLabel="Total" exportName={`kw-region-category-${comp.key}-${clientId}`} />
    </div>
  );
}
