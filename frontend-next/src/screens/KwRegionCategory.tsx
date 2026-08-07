import { useState } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { RegCatRow } from "../lib/types";
import { money, num } from "../lib/format";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

export function KwRegionCategory() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [tab, setTab] = useState(0);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.region_category_section;
  if (!sec?.components?.length) {
    return <Empty what="Needs a keyword export segmented by geography. Re-export the Search Keyword report with a Region/State segment to unlock this view." />;
  }

  const comp = sec.components[Math.min(tab, sec.components.length - 1)];
  const cpc = (v: number | null) => (v == null ? <span className="text-text-disabled">—</span> : money(v, 2));
  const cols: Column<RegCatRow>[] = [
    { key: "region", header: "Region", sort: (r) => r.region, render: (r) => <span className="font-medium">{r.region}</span>, csv: (r) => r.region },
    { key: "cat", header: "Category", sort: (r) => r.category, render: (r) => <span className="text-text-tertiary">{r.category}</span>, csv: (r) => r.category },
    { key: "spend", header: "Total spend", align: "right", sort: (r) => r.total_spend, render: (r) => money(r.total_spend), agg: { kind: "sum", get: (r) => r.total_spend, fmt: (n) => money(n) }, csv: (r) => r.total_spend },
    { key: "below", header: "Below CPC", align: "right", sort: (r) => r.below_cpc ?? 0, render: (r) => cpc(r.below_cpc), csv: (r) => r.below_cpc ?? "" },
    { key: "avg", header: "Avg CPC", align: "right", sort: (r) => r.avg_cpc ?? 0, render: (r) => cpc(r.avg_cpc), csv: (r) => r.avg_cpc ?? "" },
    { key: "above", header: "Above CPC", align: "right", sort: (r) => r.above_cpc ?? 0, render: (r) => cpc(r.above_cpc), csv: (r) => r.above_cpc ?? "" },
    {
      key: "spread", header: "Below − Above", align: "right", sort: (r) => r.spread ?? 0,
      render: (r) => (r.spread == null ? <span className="text-text-disabled">—</span> : <span className={r.spread > 0 ? "text-negative" : "text-positive"}>{money(r.spread, 2)}</span>),
      csv: (r) => r.spread ?? "",
    },
  ];

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-6">
      <h2 className="mb-1 text-[16px] font-semibold">KW by Region & Category</h2>
      <p className="mb-3 text-[12.5px] text-text-muted">CPC split by the keyword's component rating — the Below−Above spread is what a QS fix could recover.</p>
      <div className="mb-3 flex gap-1.5">
        {sec.components.map((c, i) => (
          <button
            key={c.key}
            onClick={() => setTab(i)}
            className={`rounded-[7px] border px-2.5 py-1 text-[12.5px] ${i === tab ? "border-ink bg-ink text-white" : "border-border-strong hover:border-ink"}`}
          >
            {c.label} <span className="opacity-60">({num(c.total)})</span>
          </button>
        ))}
      </div>
      <DataTable rows={comp.rows} columns={cols} rowKey={(r, i) => r.region + "|" + r.category + "|" + i} totalsLabel="Total" exportName={`kw-region-category-${comp.key}-${clientId}`} />
    </div>
  );
}
