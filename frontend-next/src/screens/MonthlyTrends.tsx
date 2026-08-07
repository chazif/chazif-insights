import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle } from "../lib/api";
import type { TrendPoint } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { TrendChart } from "../components/ui/TrendChart";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

export function MonthlyTrends() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const trend = data?.total_trend ?? [];
  if (!trend.length) return <Empty />;

  const cols: Column<TrendPoint>[] = [
    { key: "month", header: "Month", sort: (r) => r.Month, render: (r) => <span className="font-medium">{r.Month}</span>, csv: (r) => r.Month },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.Spend, render: (r) => money(r.Spend), agg: { kind: "sum", get: (r) => r.Spend, fmt: (n) => money(n) }, csv: (r) => r.Spend },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.Clicks, render: (r) => num(r.Clicks), agg: { kind: "sum", get: (r) => r.Clicks, fmt: (n) => num(n) }, csv: (r) => r.Clicks },
    { key: "conv", header: "Main Conv", align: "right", sort: (r) => r["Main Conv"], render: (r) => num(r["Main Conv"], 1), agg: { kind: "sum", get: (r) => r["Main Conv"], fmt: (n) => num(n, 1) }, csv: (r) => r["Main Conv"] },
    { key: "cpa", header: "CPA", align: "right", sort: (r) => r.CPA, render: (r) => money(r.CPA, 2), agg: { kind: "rate", num: (r) => r.Spend, den: (r) => r["Main Conv"], fmt: (n) => money(n, 2) }, csv: (r) => r.CPA },
    { key: "cvr", header: "CVR", align: "right", sort: (r) => r.CVR, render: (r) => pct(r.CVR, 2), agg: { kind: "rate", num: (r) => r["Main Conv"], den: (r) => r.Clicks, fmt: (n) => pct(n, 2) }, csv: (r) => r.CVR },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <Panel title="Spend & conversions over time">
        <TrendChart data={trend} height={300} />
      </Panel>
      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">Monthly detail</h2>
        <DataTable rows={trend} columns={cols} rowKey={(r) => r.Month} totalsLabel="All months" exportName={`trends-${clientId}`} />
      </div>
    </div>
  );
}
