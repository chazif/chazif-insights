import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { GeoRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

export function GeoPerformance() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const g = data?.geo_performance;
  if (!g || !g.rows.length) return <Empty what="No geographic data for this client." />;

  // Totals mirror the original geo table: money/count columns sum, CTR (a rate) stays blank.
  const columns: Column<GeoRow>[] = [
    { key: "location", header: g.dimension, sort: (r) => r.location, render: (r) => <span className="font-medium">{r.location}</span>, csv: (r) => r.location },
    { key: "cost", header: "Cost*", align: "right", sort: (r) => r.cost, render: (r) => money(r.cost), agg: { kind: "sum", get: (r) => r.cost, fmt: (n) => money(n) }, csv: (r) => r.cost },
    { key: "impr", header: "Impr", align: "right", sort: (r) => r.impr, render: (r) => num(r.impr), agg: { kind: "sum", get: (r) => r.impr, fmt: (n) => num(n) }, csv: (r) => r.impr },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks },
    { key: "ctr", header: "CTR", align: "right", sort: (r) => r.ctr, render: (r) => pct(r.ctr, 2), csv: (r) => r.ctr },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
    { key: "cpa", header: "Cost/conv.", align: "right", sort: (r) => r.cpa, render: (r) => money(r.cpa, 2), agg: { kind: "sum", get: (r) => r.cpa, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa },
    { key: "cv", header: "Conv Value", align: "right", sort: (r) => r.conv_value, render: (r) => money(r.conv_value), agg: { kind: "sum", get: (r) => r.conv_value, fmt: (n) => money(n) }, csv: (r) => r.conv_value },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold">Geo Performance</h2>
        <div className="text-[12.5px] text-text-muted">By {g.dimension} · cost derived from CPA×conv (Geographic export carries no cost column)</div>
      </div>
      <Panel>
        <DataTable rows={g.rows} columns={columns} rowKey={(r) => r.location} totalsLabel="Total" exportName={`geo-${clientId}`} />
      </Panel>
    </div>
  );
}
