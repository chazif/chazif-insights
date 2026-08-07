import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle } from "../lib/api";
import type { GeoRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { DataTable, type Column } from "../components/ui/DataTable";
import { InlineBarCell } from "../components/ui/InlineBarCell";
import { Loading, ErrorState, Empty } from "../components/ui/States";

export function GeoPerformance() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const g = data?.geo_performance;
  if (!g || !g.rows.length) return <Empty what="No geographic data for this client." />;

  const t = g.totals;
  const cpaTotal = t.conv ? t.cost / t.conv : 0;
  const cvrTotal = t.clicks ? t.conv / t.clicks : 0;

  const columns: Column<GeoRow>[] = [
    { key: "location", header: g.dimension, sort: (r) => r.location, render: (r) => <span className="font-medium">{r.location}</span>, csv: (r) => r.location },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sort: (r) => r.cost,
      render: (r) => <InlineBarCell figure={money(r.cost)} share={t.cost ? r.cost / t.cost : 0} />,
      agg: { kind: "sum", get: (r) => r.cost, fmt: (n) => money(n) },
      csv: (r) => r.cost,
    },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks },
    { key: "impr", header: "Impr", align: "right", sort: (r) => r.impr, render: (r) => num(r.impr), agg: { kind: "sum", get: (r) => r.impr, fmt: (n) => num(n) }, csv: (r) => r.impr },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
    { key: "cpa", header: "CPA", align: "right", sort: (r) => r.cpa, render: (r) => (r.cpa ? money(r.cpa, 2) : "—"), agg: { kind: "rate", num: (r) => r.cost, den: (r) => r.conv, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa },
    { key: "cvr", header: "CVR", align: "right", sort: (r) => r.cvr, render: (r) => pct(r.cvr, 2), agg: { kind: "rate", num: (r) => r.conv, den: (r) => r.clicks, fmt: (n) => pct(n, 2) }, csv: (r) => r.cvr },
    { key: "ctr", header: "CTR", align: "right", sort: (r) => r.ctr, render: (r) => pct(r.ctr, 2), agg: { kind: "rate", num: (r) => r.clicks, den: (r) => r.impr, fmt: (n) => pct(n, 2) }, csv: (r) => r.ctr },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Spend", value: money(t.cost) },
          { label: "Conversions", value: num(t.conv, 0) },
          { label: "CPA", value: money(cpaTotal, 2) },
          { label: "CVR", value: pct(cvrTotal, 2) },
          { label: `${g.dimension}s`, value: num(g.rows.length) },
        ]}
      />
      <div className="mt-6">
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-[16px] font-semibold">Performance by {g.dimension.toLowerCase()}</h2>
          <span className="text-[12px] text-text-muted">bar length = share of spend</span>
        </div>
        <DataTable rows={g.rows} columns={columns} rowKey={(r) => r.location} totalsLabel={`${g.dimension} total`} exportName={`geo-${clientId}`} />
        <p className="mt-2 text-[11.5px] text-text-muted">Cost is derived from Cost/conv — the Geographic export has no Cost column. CPA, CVR and CTR are weighted averages.</p>
      </div>
    </div>
  );
}
